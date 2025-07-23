import { JSONSerialiser, PGMBClient, type PGMBOnMessageOpts } from '@haathie/pgmb'
import { Pool, type PoolClient } from 'pg'
import { PassThrough, type Writable } from 'stream'
import { setTimeout } from 'timers/promises'

type LDSSourceOptions = {
	pool: Pool
	deviceId: string

	slotName?: string
	tablePatterns?: string[]
	sleepDuration?: number
}

type Row = { [_: string]: unknown }

export type PgChangeEvent = {
	eventId: string
	items: PgChangeData[]
}

export type PgChangeOp = 'insert' | 'update' | 'delete'

export type PgChangeData = {
	lsn: string
	op: PgChangeOp
	op_topic: string
	row_before: Row | null
	row_data: Row
	diff: Row | null
}

export type CreateSubscriptionOpts = {
	topic: string | {
		schema: string
		table: string
		kind: PgChangeOp
	}
	type: string
	conditionsSql?: string
	conditionsParams?: any[]
	additionalData?: { [_: string]: unknown }
	isTemporary?: boolean
	diffOnlyFields?: string[]
}

type DataMap = { [_: string]: PgChangeData[] }

export class LDSSource {

	static #current: LDSSource | undefined

	slotName: string
	deviceId: string
	tablePatterns: string[]
	chunkSize = 500
	sleepDuration: number

	#pool: Pool
	#pgmb: PGMBClient<DataMap, DataMap>
	#closed = false
	#subscribers: { [topic: string]: Writable } = {}
	#consumerPromise?: Promise<void>
	#publishLoopPromise?: Promise<void>
	#devicePingInterval?: NodeJS.Timeout
	#publishClient: PoolClient | undefined

	constructor({
		pool,
		deviceId,
		slotName = 'postgraphile',
		tablePatterns = ['*.*'],
		sleepDuration = 500
	}: LDSSourceOptions) {
		this.deviceId = deviceId
		this.slotName = slotName
		this.tablePatterns = tablePatterns
		this.sleepDuration = sleepDuration
		this.#pool = pool
		this.#pgmb = new PGMBClient<DataMap, DataMap>({
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

		this.#onClientRemove = this.#onClientRemove.bind(this)
		this.#pool.on('remove', this.#onClientRemove)
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

	getCreateSubscriptionSql(
		{
			topic,
			conditionsSql,
			conditionsParams = [],
			type,
			additionalData = {},
			isTemporary = true,
			diffOnlyFields,
		}: CreateSubscriptionOpts,
	) {
		const values: string[] = []
		const params: unknown[] = []
		if(typeof topic === 'string') {
			params.push(topic)
			values.push(`$${params.length}`)
		} else {
			params.push(topic.schema, topic.table, topic.kind)
			values.push(
				`postgraphile_meta.get_topic_from_change_json(
					jsonb_object(
						ARRAY['schema', 'table', 'kind'],
						ARRAY[
							$${params.length - 2}::varchar,
							$${params.length - 1}::varchar,
							$${params.length}::varchar
						]
					)
				)`
			)
		}

		if(conditionsSql) {
			params.push(conditionsSql)
			values.push(`$${params.length}`)

			params.push(conditionsParams)
			values.push(`$${params.length}::varchar[]`)
		} else {
			values.push('DEFAULT')
			values.push('DEFAULT')
		}

		if(diffOnlyFields && diffOnlyFields.length > 0) {
			params.push(diffOnlyFields)
			values.push(`$${params.length}::varchar[]`)
		} else {
			values.push('DEFAULT')
		}

		params.push(isTemporary)
		values.push(`$${params.length}::boolean`)

		params.push(type)
		values.push(`$${params.length}::varchar`)

		params.push(additionalData)
		values.push(`$${params.length}::jsonb`)

		const sql = `INSERT INTO postgraphile_meta.subscriptions(
			topic,
			conditions_sql,
			conditions_params,
			diff_only_fields,
			is_temporary,
			type,
			additional_data
		)
		VALUES(${values.join(', ')})
		RETURNING id, topic
		`
		return [sql, params] as const
	}

	async subscribe(
		subscriptionId: string | number,
		deleteOnClose = true
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
		stream.on('close', onEnd.bind(this))

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

		async function onEnd(this: LDSSource) {
			if(!this.#subscribers[subscriptionId]) {
				return
			}

			console.log(`Stream closed for subscriptionId: ${subscriptionId}`)
			delete this.#subscribers[subscriptionId]

			if(deleteOnClose) {
				try {
					await this.#pool.query(
						'DELETE FROM postgraphile_meta.subscriptions'
						+ ' WHERE id = $1',
						[subscriptionId]
					)
					console.log(`Deleted subscription: ${subscriptionId}`)
				} catch(e: any) {
					console.error(
						`Error deleting subscription ${subscriptionId}:`, e
					)
				}
			}
		}
	}

	async startPublishChangeLoop() {
		await this.createPublisherSlot()
		this.#loopPublishChanges()
	}

	async publishChanges() {
		this.#publishClient ||= await this.#pool.connect()
		try {
			await this.#publishClient.query(
				`SELECT FROM postgraphile_meta.send_changes_to_subscriptions(
					$1, NULL, $2, 'add-tables', $3
				)`,
				[this.slotName, this.chunkSize, this.tablePatterns.join(',')]
			)
		} catch(err: any) {
			if(err.code === '55006') {
				// this error means that the slot is already in use by
				// another session. Can ignore this
				return
			}

			throw err
		}
	}

	async createPublisherSlot() {
		try {
			await this.#pool.query(
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
		}
	}

	release() {
		return this.close()
	}

	async close() {
		this.#closed = true

		if(LDSSource.#current === this) {
			LDSSource.#current = undefined
		}

		if(this.#publishClient) {
			await this.#publishClient.release()
			this.#publishClient = undefined
		}

		this.#pool.off('remove', this.#onClientRemove)

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

	#onClientRemove = (client: PoolClient) => {
		if(this.#publishClient === client) {
			this.#publishClient = undefined
			console.log('Publish client removed, resetting.')
		}
	}

	async #handleMessage({
		msgs,
		logger
	}: PGMBOnMessageOpts<string, DataMap, PgChangeData[]>) {
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
				const msg: PgChangeEvent = { eventId: id, items: message }
				stream.write(msg, err => {
					if(err) {
						reject(err)
					} else {
						resolve()
					}
				})
			})
		}
	}

	static init(options: LDSSourceOptions): LDSSource {
		if(LDSSource.#current) {
			throw new Error('LDSSource already initialized.')
		}

		LDSSource.#current = new LDSSource(options)
		return LDSSource.#current
	}

	static get isCurrentInitialized(): boolean {
		return !!LDSSource.#current
	}

	static get current(): LDSSource {
		if(!LDSSource.#current) {
			throw new Error(
				'LDSSource not initialized, call LDSSource.init() first.'
			)
		}

		return LDSSource.#current
	}
}

// duplicated from sql
function getQueueNameFromDeviceId(deviceId: string): string {
	return `postg_tmp_sub_${deviceId}`
}