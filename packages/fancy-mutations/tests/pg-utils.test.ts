import { getSuperuserPool, runDdl } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { insertData, type PGEntityCtx } from '../src/pg-utils.ts'
import { CONFIG } from './config.ts'

type Author = {
	id: number
	name: string
	bio: string | null
	metadata: Record<string, unknown> | null
}

const AUTHOR_CTX: PGEntityCtx<Partial<Author>> = {
	'idProperties': ['id'],
	'propertyColumnMap': {
		'id': 'id',
		'name': 'name',
		'bio': 'bio',
		'metadata': 'metadata',
	},
	'uniques': [{ columns: ['id'] }, { columns: ['name'] }],
	'tableName': 'fancy_mutations_test.authors',
}

describe('PG Utils', () => {

	let pool: Pool

	before(async() => {
		await runDdl(CONFIG)
		pool = getSuperuserPool(CONFIG.preset)
	})

	after(async() => {
		await pool.end()
	})

	describe('Insert/Upsert', () => {

		it('should insert or do nothing', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'Author 1',
				},
				{
					name: 'Author 2',
				},
				{
					name: 'Author 3',
				}
			]

			const { rows } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'ignore' },
					['id', 'name'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows?.length, 3)
			for(const [i, row] of (rows as any[]).entries()) {
				assert.strictEqual(row['name'], `Author ${i + 1}`)
				assert.ok(row['id'] > 0)
				assert.strictEqual(row['row_action'], 'inserted')
			}

			// re-insert the same data + 1 more
			const { rows: rows2, affectedCount } = await tx(client => (
				insertData(
					[
						...authors,
						{
							name: 'Author 4',
						}
					],
					client,
					{ type: 'ignore' },
					['id', 'name'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows2?.length, 4)
			assert.strictEqual(affectedCount, 1)
			assert.partialDeepStrictEqual(rows2?.at(0), { 'row_action': 'existing' })
		})

		const CONFLICT_TYPES = [
			'error',
			'ignore',
			'replace',
		] as const

		for(const conflictType of CONFLICT_TYPES) {
			it(`should not return anything on ${conflictType} insert`, async() => {
				const authors: Partial<Author>[] = [
					{
						name: 'Author ' + Math.random(),
					},
				]

				const { rows, affectedCount } = await tx(client => (
					insertData(
						authors,
						client,
						conflictType === 'error'
							? undefined
							: { type: conflictType },
						undefined,
						AUTHOR_CTX
					)
				))
				assert.equal(rows, undefined)
				assert.strictEqual(affectedCount, 1)
			})
		}

	})

	async function tx<T>(
		exec: (client: PoolClient) => Promise<T>
	) {
		const client = await pool.connect()
		await client.query('BEGIN;')
		try {
			const rslt = await exec(client)
			await client.query('COMMIT;')
			return rslt
		} catch(err) {
			await client.query('ROLLBACK;')
			throw err
		} finally {
			client.release()
		}
	}
})