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
	id: string
	op: PgChangeOp
	topic: string
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

export class LDSSource {

	static #current: LDSSource | undefined

	slotName: string
	deviceId: string
	chunkSize = 250
	sleepDurationMs: number

	#pool: Pool
	#closed = false
	#subscribers: { [topic: string]: Writable } = {}
	#readLoopPromise?: Promise<void>
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
	}

	addTableToPublishFor(tableName: string) {
		if(!this.#pendingTablesToPublishFor.includes(tableName)) {
			this.#pendingTablesToPublishFor.push(tableName)
		}
	}

	async listen() {
		await this.#pingDevice()
		this.#readLoopPromise ||= this.#startReadLoop()

		clearInterval(this.#devicePingInterval)
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

	async readChanges() {
		if(this.#pendingTablesToPublishFor?.length) {
			const tableNames = [...this.#pendingTablesToPublishFor]
			this.#pendingTablesToPublishFor = []
			await this.makeSubscribable(...tableNames)
		}

		const now = Date.now()
		const { rows } = await this.#pool.query(
			'SELECT * FROM postgraphile_meta.get_events_for_subscriptions($1, $2)',
			[this.deviceId, this.chunkSize]
		)

		const subToEventMap: { [subscriptionId: string]: PgChangeData[] } = {}
		for(const { subscription_ids: subIds, ...row } of rows) {
			for(const subId of subIds) {
				subToEventMap[subId] ||= []
				subToEventMap[subId].push(row as PgChangeData)
			}
		}

		await Promise.all(
			Object.entries(subToEventMap).map(async([subId, items]) => {
				const stream = this.#subscribers[subId]
				if(!stream) {
					DEBUG(`No stream found for subscriptionId: ${subId}`)
					return
				}

				await new Promise<void>((resolve, reject) => {
					const msg: PgChangeEvent = { eventId: items.at(-1)!.id, items }
					stream.write(msg, err => {
						if(err) {
							reject(err)
						} else {
							resolve()
						}
					})
				})
			})
		)

		console.log(
			`Published changes for ${this.chunkSize} items in `
			+ `${Date.now() - now}ms`
		)

		return rows.length
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

		await this.#readLoopPromise
	}

	async #startReadLoop() {
		while(!this.#closed) {
			let rowsRead = 0
			try {
				rowsRead = await this.readChanges()
				if(rowsRead) {
					DEBUG(`Read ${rowsRead} events from db`)
				}
			} catch(e: any) {
				console.error('Error reading changes:', e)
			}

			// nothing to read, wait before next iteration
			if(!rowsRead) {
				await setTimeout(this.sleepDurationMs)
				continue
			}
		}
	}

	async #pingDevice() {
		await this.#pool.query(
			'SELECT postgraphile_meta.mark_device_queue_active($1::varchar)',
			[this.deviceId]
		)
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