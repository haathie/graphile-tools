import { JSONSerialiser, PGMBClient, type PGMBOnMessageOpts } from '@haathie/pgmb'
import { Pool } from 'pg'
import { PassThrough, type Writable } from 'stream'
import { setTimeout } from 'timers/promises'
import { DEBUG } from './utils.ts'

type LDSSourceOptions = {
	pool: Pool
	deviceId: string

	slotName?: string
	/**
	 * Time to sleep for between publishing changes.
	 * @default 500
	 */
	sleepDurationMs?: number
}

type Row = { [_: string]: unknown }

export type PgChangeEvent = {
	eventId: string
	items: PgChangeData[]
}

export type PgChangeOp = 'INSERT' | 'UPDATE' | 'DELETE'

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
	chunkSize = 10_000
	sleepDurationMs: number

	#pool: Pool
	#pgmb: PGMBClient<DataMap, DataMap>
	#closed = false
	#subscribers: { [topic: string]: Writable } = {}
	#consumerPromise?: Promise<void>
	#publishLoopPromise?: Promise<void>
	#devicePingInterval?: NodeJS.Timeout
	#pendingTablesToPublishFor: string[] = []

	constructor({
		pool,
		deviceId,
		slotName = 'postgraphile',
		sleepDurationMs = 250
	}: LDSSourceOptions) {
		this.deviceId = deviceId
		this.slotName = slotName
		this.sleepDurationMs = sleepDurationMs
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
	}

	addTableToPublishFor(tableName: string) {
		if(!this.#pendingTablesToPublishFor.includes(tableName)) {
			this.#pendingTablesToPublishFor.push(tableName)
		}
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
				`postgraphile_meta.create_topic(
					$${params.length - 2}::varchar,
					$${params.length - 1}::varchar,
					$${params.length}::varchar
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

		DEBUG(`Creating stream for subscriptionId: ${subscriptionId}`)

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

			DEBUG(`Stream closed for subscriptionId: ${subscriptionId}`)
			delete this.#subscribers[subscriptionId]

			if(deleteOnClose) {
				try {
					await this.#pool.query(
						'DELETE FROM postgraphile_meta.subscriptions'
						+ ' WHERE id = $1',
						[subscriptionId]
					)
					DEBUG(`Deleted subscription: ${subscriptionId}`)
				} catch(e: any) {
					console.error(
						`Error deleting subscription ${subscriptionId}:`, e
					)
				}
			}
		}
	}

	startPublishChangeLoop() {
		this.#loopPublishChanges()
	}

	async publishChanges() {
		if(this.#pendingTablesToPublishFor?.length) {
			const tableNames = [...this.#pendingTablesToPublishFor]
			this.#pendingTablesToPublishFor = []
			await this.makeSubscribable(...tableNames)
		}

		const now = Date.now()
		await this.#pool.query(
			'SELECT FROM postgraphile_meta.send_changes_to_subscriptions($1)',
			[this.chunkSize]
		)

		console.log(
			`Published changes for ${this.chunkSize} items in `
			+ `${Date.now() - now}ms`
		)
	}

	async makeSubscribable(...tableNames: string[]) {
		const conn = await this.#pool.connect()
		try {
			await conn.query('BEGIN')
			for(const tableName of tableNames) {
				await conn.query(
					'SELECT postgraphile_meta.make_subscribable($1::regclass)',
					[tableName]
				)
			}

			await conn.query('COMMIT')

			DEBUG(`Made tables subscribable: ${tableNames.join(', ')}`)
		} catch(err) {
			await conn.query('ROLLBACK')
			throw err
		} finally {
			conn.release()
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
				await setTimeout(this.sleepDurationMs)
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
	}: PGMBOnMessageOpts<string, DataMap, PgChangeData[]>) {
		DEBUG(`Got ${msgs.length} messages, on ${this.deviceId}`)
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