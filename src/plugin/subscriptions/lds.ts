import { Pool } from 'pg'

type LDSSourceOptions = {
	uri: string
	slotName?: string
	tablePattern?: string
	sleepDuration?: number
}

export class LDSSource {

	slotName: string
	tablePattern: string
	chunkSize = 500
	sleepDuration: number

	#pool: Pool
	#createdSlot = false
	#closed = false

	constructor({
		uri,
		slotName = 'postgraphile',
		tablePattern = '*.*',
		sleepDuration = 500
	}: LDSSourceOptions) {
		this.slotName = slotName
		this.tablePattern = tablePattern
		this.sleepDuration = sleepDuration
		this.#pool = new Pool({ connectionString: uri, max: 1 })
	}

	async *readChanges(signal: AbortSignal): AsyncGenerator {
		if(this.#closed) {
			throw new Error('Source is already closed')
		}

		while(!this.#closed) {
			try {
				yield* this.readChangesBlock()
			} catch(e: any) {
				if(e.code === '42704') {
					console.error('Replication slot was dropped, will recreate')
					this.#createdSlot = false
				} else {
					console.error('Error reading changes:', e)
				}
			}

			if(signal.aborted) {
				break
			}

			await new Promise<void>(resolve => {
				const timeout = setTimeout(resolve, this.sleepDuration)
				signal.onabort = () => {
					resolve()
					clearTimeout(timeout)
				}
			})
		}
	}

	async *readChangesBlock(): AsyncGenerator {
		if(!this.#createdSlot) {
			await this.#createSlot()
			this.#createdSlot = true
		}

		const client = await this.#pool.connect()
		try {
			const { rows } = await client.query(
				`SELECT
					(change).*, sub_id, sub_additional_data, sub_type
				FROM postgraphile_meta.get_changes_and_subs($1, NULL, $2, 'add-tables', $3)`,
				[this.slotName, this.chunkSize, this.tablePattern]
			)
			for(const row of rows) {
				yield row
			}
		} finally {
			client.release()
		}
	}

	async #createSlot() {
		const client = await this.#pool.connect()
		try {
			await client.query(
				'SELECT pg_catalog.pg_create_logical_replication_slot($1, \'wal2json\', $2)',
				[this.slotName, false]
			)
		} catch(e: any) {
			if(e.code === '58P01') {
				throw new Error(
					"Couldn't create replication slot, seems you don't have wal2json installed?"
				)
			} else if(e.code === '42710') {
				return // Slot already exists, no need to create it
			}

			throw e
		} finally {
			client.release()
		}
	}

	async close() {
		this.#closed = true
		await this.#pool.end()
	}
}

async function main() {
	const src = new LDSSource({
		uri: process.env.PG_URI!,
		tablePattern: 'app.*',
		sleepDuration: 1000
	})

	const abortController = new AbortController()
	process.on('SIGINT', () => {
		abortController.abort()
	})

	for await (const change of src.readChanges(abortController.signal)) {
		console.log('Change:', change)
	}

	console.log('Exited')
	await src.close()
}

main()