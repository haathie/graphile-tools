import { JSONSerialiser, PGMBClient, type PGMBOnMessageOpts } from '@haathie/pgmb'
import { Pool } from 'pg'
import { PassThrough, Writable } from 'stream'
import { setTimeout } from 'timers/promises'

type LDSSourceOptions = {
	pool: Pool
	deviceId: string

	slotName?: string
	tablePattern?: string
	sleepDuration?: number
}

type Row = { [_: string]: unknown }

export type PgChangeData = {
	lsn: string
	op: 'insert' | 'update' | 'delete'
	op_topic: string
	row_before: Row | null
	row_data: Row
	diff: Row | null
}

type DataMap = { [_: string]: PgChangeData[] }

export class LDSSource {

	slotName: string
	deviceId: string
	tablePattern: string
	chunkSize = 500
	sleepDuration: number

	#pool: Pool
	#pgmb: PGMBClient
	#closed = false
	#subscribers: { [topic: string]: Writable } = {}
	#consumerPromise?: Promise<void>
	#publishLoopPromise?: Promise<void>
	#devicePingInterval?: NodeJS.Timeout

	constructor({
		pool,
		deviceId,
		slotName = 'postgraphile',
		tablePattern = '*.*',
		sleepDuration = 500
	}: LDSSourceOptions) {
		this.deviceId = deviceId
		this.slotName = slotName
		this.tablePattern = tablePattern
		this.sleepDuration = sleepDuration
		this.#pool = pool
		this.#pgmb = new PGMBClient<DataMap>({
			pool: this.#pool,
			serialiser: JSONSerialiser,
			consumers: [
				{
					name: getQueueNameFromDeviceId(deviceId),
					batchSize: this.chunkSize,
					onMessage: this.#handleMessage.bind(this),
				}
			]
		})
	}

	async listen() {
		if(!this.#consumerPromise) {
			this.#consumerPromise = this.#listen()
				.catch(err => {
					this.#consumerPromise = undefined
					throw err
				})
		}

		return this.#consumerPromise
	}

	async #listen() {
		// remove all temp subscribers from previous runs
		await this.#pool.query(
			'SELECT postgraphile_meta.remove_stale_subscriptions($1)',
			[this.deviceId]
		)
		await this.#pingDevice()
		await this.#pgmb.listen()

		this.#devicePingInterval = setInterval(async() => {
			try {
				await this.#pingDevice()
			} catch(e) {
				console.error('Error pinging device queue:', e)
			}
		}, 30 * 1000) // every 30 seconds
	}

	async subscribe(
		subscriptionId: string | number
	): Promise<AsyncIterableIterator<PgChangeData>> {
		if(this.#closed) {
			throw new Error('Source already closed.')
		}

		if(this.#subscribers[subscriptionId]) {
			throw new Error(`Subscription already exists for: ${subscriptionId}`)
		}

		await this.listen()

		console.log(`Creating stream for subscriptionId: ${subscriptionId}`)

		const stream = new PassThrough({ objectMode: true, highWaterMark: 1 })
		stream.on('close', () => {
			console.log(`Stream closed for subscriptionId: ${subscriptionId}`)
			delete this.#subscribers[subscriptionId]
		})

		this.#subscribers[subscriptionId] = stream

		const asyncIterator = stream[Symbol.asyncIterator]()
		const ogReturn = asyncIterator.return?.bind(asyncIterator)
		const ogThrow = asyncIterator.throw?.bind(asyncIterator)
		asyncIterator.return = async(value) => {
			stream.end()
			return ogReturn?.(value) || { done: true, value }
		}

		asyncIterator.throw = async(err) => {
			stream.destroy(err)
			return ogThrow?.(err) || { done: true, value: undefined }
		}

		return asyncIterator
	}

	async startPublishChangeLoop() {
		await this.createPublisherSlot()
		this.#loopPublishChanges()
	}

	async publishChanges() {
		await this.#pool.query(
			`SELECT FROM postgraphile_meta.send_changes_to_subscriptions(
				$1, NULL, $2, 'add-tables', $3
			)`,
			[this.slotName, this.chunkSize, this.tablePattern]
		)
	}

	async createPublisherSlot() {
		const client = await this.#pool.connect()
		try {
			await client.query(
				"SELECT pg_catalog.pg_create_logical_replication_slot($1, 'wal2json', $2)",
				[this.slotName, false]
			)
		} catch(e: any) {
			if(e.code === '58P01') {
				throw new Error(
					"Couldn't create replication slot, "
					+ "seems you don't have wal2json installed?"
				)
			} else if(e.code === '42710') {
				return // Slot already exists, no need to create it
			}

			throw e
		} finally {
			client.release()
		}
	}

	release() {
		return this.close()
	}

	async close() {
		this.#closed = true
		clearInterval(this.#devicePingInterval)
		for(const stream of Object.values(this.#subscribers)) {
			stream.end()
		}

		await this.#publishLoopPromise
		await this.#pgmb.close()
	}

	async #loopPublishChanges() {
		while(!this.#closed) {
			try {
				await this.publishChanges()
				await setTimeout(this.sleepDuration)
			} catch(e: any) {
				console.error('Error publishing changes:', e)
			}
		}
	}

	async #pingDevice() {
		await this.#pool.query(
			'SELECT postgraphile_meta.mark_device_queue_active($1::varchar)',
			[this.deviceId]
		)
	}

	async #handleMessage({
		msgs,
		logger
	}: PGMBOnMessageOpts<string, { [_: string]: unknown }, PgChangeData[]>) {
		for(const { id, headers, message } of msgs) {
			const { subscriptionId } = headers
			if(!subscriptionId) {
				logger.warn({ id, headers }, 'msg w/o subscriptionId')
				continue
			}

			const stream = this.#subscribers[subscriptionId]
			if(!stream) {
				logger.warn(
					{ id, subscriptionId },
					'no listeners for subscriptionId'
				)
				continue
			}

			await new Promise<void>((resolve, reject) => {
				stream.write(message, err => {
					if(err) {
						reject(err)
					} else {
						resolve()
					}
				})
			})
		}
	}
}

function getQueueNameFromDeviceId(deviceId: string): string {
	return `postg_tmp_sub_${deviceId}`
}