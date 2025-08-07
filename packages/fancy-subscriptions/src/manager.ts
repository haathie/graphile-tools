import { readFile } from 'fs/promises'
import { join } from 'path'
import { Pool } from 'pg'
import { PassThrough, type Writable } from 'stream'
import { setTimeout } from 'timers/promises'
import { DEBUG } from './utils.ts'

type SubscriptionManagerOptions = {
	pool: Pool
	/**
	 * Unique identifier for the device. For WebSocket subscriptions to work
	 * correctly, this should be unique per device.
	 */
	deviceId: string
	/**
	 * Time to sleep for between reading changes.
	 * @default 500
	 */
	sleepDurationMs?: number

	chunkSize?: number
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

const PING_INTERVAL_MS = 30 * 1000 // 30 seconds
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000 // 15 minute

export class SubscriptionManager {

	static #current: SubscriptionManager | undefined

	deviceId: string
	chunkSize: number
	sleepDurationMs: number

	#pool: Pool
	#closed = false
	#subscribers: { [topic: string]: Writable } = {}
	#readLoopPromise?: Promise<void>
	#devicePingInterval?: NodeJS.Timeout
	#maintenanceInterval?: NodeJS.Timeout
	#pendingTablesToPublishFor: string[] = []
	#eventsPublished = 0

	constructor({
		pool,
		deviceId,
		sleepDurationMs = 250,
		chunkSize = 1000
	}: SubscriptionManagerOptions) {
		this.deviceId = deviceId
		this.sleepDurationMs = sleepDurationMs
		this.#pool = pool
		this.chunkSize = chunkSize
	}

	/**
	 * Adds a table to the list of tables that will be made subscribable. This
	 * will be made subscribable on the next readChanges call.
	 *
	 * @param tableName - eg. 'public.my_table' (including schema)
	 */
	addTableToPublishFor(tableName: string) {
		if(!this.#pendingTablesToPublishFor.includes(tableName)) {
			this.#pendingTablesToPublishFor.push(tableName)
		}
	}

	async listen() {
		// already listening
		if(this.#readLoopPromise) {
			return
		}

		await this.runDdlIfRequired()
		await this.maintainEventsTable()
		await this.#pingDevice()
		await this.clearTempSubscriptions()

		this.#readLoopPromise = this.#startReadLoop()

		clearInterval(this.#devicePingInterval)
		this.#devicePingInterval = setInterval(async() => {
			try {
				await this.#pingDevice()
			} catch(e) {
				console.error('Error pinging device queue:', e)
			}
		}, PING_INTERVAL_MS) // every 30 seconds

		clearInterval(this.#maintenanceInterval)
		this.#maintenanceInterval = setInterval(async() => {
			try {
				await this.maintainEventsTable()
			} catch(e) {
				console.error('Error maintaining events table:', e)
			}
		}, MAINTENANCE_INTERVAL_MS)

		DEBUG('SubscriptionManager listening for changes...')
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

	/**
	 * Listens for changes for the given subscriptionId.
	 * Returns an async iterator that yields PgChangeEvent objects.
	 * @param deleteOnClose Delete the subscription when the stream closes.
	 */
	subscribe(
		subscriptionId: string | number,
		deleteOnClose: boolean
	): AsyncIterableIterator<PgChangeEvent> {
		if(this.#closed) {
			throw new Error('Source already closed.')
		}

		if(this.#subscribers[subscriptionId]) {
			throw new Error(`Subscription already exists for: ${subscriptionId}`)
		}

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

		async function onEnd(this: SubscriptionManager) {
			if(!this.#subscribers[subscriptionId]) {
				return
			}

			DEBUG(`Stream closed for subscriptionId: ${subscriptionId}`)
			delete this.#subscribers[subscriptionId]

			if(!deleteOnClose) {
				return
			}

			try {
				await this.#pool.query(
					'DELETE FROM postgraphile_meta.subscriptions WHERE id = $1',
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

	/**
	 * Makes the given tables subscribable. This is a one-time operation
	 * that allows the subscription manager to start listening for changes
	 * on these tables.
	 * @param tableNames eg. ['public.my_table', 'public.my_other_table']
	 */
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
				this.#eventsPublished ++
			}
		}

		const subs = Object.entries(subToEventMap)
		for(const [subId, items] of subs) {
			const stream = this.#subscribers[subId]
			if(!stream) {
				DEBUG(`No stream found for subscriptionId: ${subId}`)
				continue
			}

			const msg: PgChangeEvent = { eventId: items.at(-1)!.id, items }
			stream.write(msg, err => {
				if(err) {
					DEBUG(`Error writing to stream for ${subId}:`, err)
				}
			})
		}

		if(rows.length) {
			console.log(
				`Read ${rows.length} events from db to ${subs.length} subs in`
				+ ` ${Date.now() - now}ms, ${this.#eventsPublished} total events published`
			)
		}

		return rows.length
	}

	runDdlIfRequired() {
		return runDdlIfRequired(this.#pool)
	}

	release() {
		return this.close()
	}

	async close() {
		this.#closed = true

		if(SubscriptionManager.#current === this) {
			SubscriptionManager.#current = undefined
		}

		clearInterval(this.#devicePingInterval)
		clearInterval(this.#maintenanceInterval)
		for(const stream of Object.values(this.#subscribers)) {
			stream.end()
		}

		await this.#readLoopPromise
		this.#readLoopPromise = undefined
		this.#devicePingInterval = undefined
	}

	async #startReadLoop() {
		while(!this.#closed) {
			let rowsRead = 0
			try {
				rowsRead = await this.readChanges()
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
			'SELECT postgraphile_meta.mark_device_active($1)',
			[this.deviceId]
		)
	}

	async maintainEventsTable() {
		await this.#pool.query('SELECT postgraphile_meta.maintain_events_table()')
	}

	async clearTempSubscriptions() {
		// clear all temp subscriptions for this device
		await this.#pool.query(
			'SELECT postgraphile_meta.remove_temp_subscriptions($1)',
			[this.deviceId]
		)
	}

	static init(options: SubscriptionManagerOptions) {
		if(SubscriptionManager.#current) {
			throw new Error('SubscriptionManager already initialized.')
		}

		return (SubscriptionManager.#current = new SubscriptionManager(options))
	}

	static get isCurrentInitialized(): boolean {
		return !!SubscriptionManager.#current
	}

	/**
	 * Singleton instance of the current SubscriptionManager.
	 * Throws an error if not initialized.
	 */
	static get current(): SubscriptionManager {
		if(!SubscriptionManager.#current) {
			throw new Error(
				'SubscriptionManager not initialized, call SubscriptionManager.init() first.'
			)
		}

		return SubscriptionManager.#current
	}
}

async function runDdlIfRequired(pgPool: Pool) {
	// check if the schema exists
	const { rows } = await pgPool.query(
		'SELECT 1 FROM pg_namespace WHERE nspname = $1',
		['postgraphile_meta']
	)
	if(rows.length) {
		DEBUG('Schema postgraphile_meta already exists, skipping DDL.')
		return
	}

	DEBUG('Running DDL for postgraphile_meta schema...')
	const ddlFilename
		= join(import.meta.dirname, '../sql/fancy-subscriptions.sql')
	const ddl = await readFile(ddlFilename, 'utf8')
	await pgPool.query(`BEGIN;\n${ddl};\nCOMMIT;`)
	DEBUG('DDL for postgraphile_meta schema completed.')
}