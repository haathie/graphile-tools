import { getSuperuserPool, runDdl } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { insertData, type PGEntityCtx } from '../src/pg-utils.ts'
import { CONFIG } from './config.ts'

type Author = {
	id: number
	name: string
	bio: {
		age: number
		favourite_genre: number
	} | null
	metadata: Record<string, unknown> | null
	nickname: string | Date | null
}

const AUTHOR_CTX: PGEntityCtx<Partial<Author>> = {
	'idProperties': ['id'],
	'propertyColumnMap': {
		'id': { sqlType: 'varchar' },
		'name': { sqlType: 'varchar' },
		'bio': { sqlType: 'fancy_mutations_test.bio_data' },
		'metadata': { sqlType: 'jsonb' },
		'nickname': { sqlType: 'varchar' }
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

	describe('On Conflict = Ignore', () => {
		it('should insert or do nothing', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'Author 1',
				},
				{
					name: 'Author 2',
					// bio: { age: 30, 'favourite_genre': 5 },
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
				assert.strictEqual(row['row_action'], 'INSERT')
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
			assert.partialDeepStrictEqual(rows2?.at(0), { 'row_action': 'EXISTING' })
		})

		it('should handle duplicate inputs and return rows', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'Author 10',
				},
				{
					name: 'Author 10', // duplicate
				},
				{
					name: 'Author 11',
				}
			]

			const { rows, affectedCount } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'ignore' },
					['id', 'name'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows?.length, 3)
			assert.strictEqual(affectedCount, 2)
			assert.strictEqual(rows[0]['id'], rows[1]['id'])
			assert.strictEqual(rows[1]['row_action'], 'DUPLICATE')
		})

		it('should handle duplicate inputs and return nothing', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'Author 15',
				},
				{
					name: 'Author 15', // duplicate
				},
				{
					name: 'Author 17',
				}
			]

			const { rows, affectedCount, rowCount } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'ignore' },
					undefined,
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rowCount, 3)
			assert.strictEqual(affectedCount, 2)
			assert.strictEqual(rows, undefined)
		})
	})

	describe('On Conflict = Replace', () => {

		it('should insert or replace', async() => {
			const authors: Partial<Author>[] = [
				{ name: 'RAuthor 1' },
				{ name: 'RAuthor 2' },
				{ name: 'RAuthor 3' }
			]

			const { rows } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'replace' },
					['id', 'name'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows?.length, 3)
			for(const [i, row] of rows.entries()) {
				assert.strictEqual(row['name'], `RAuthor ${i + 1}`)
				assert.ok((row['id'] as number) > 0)
				assert.strictEqual(row['row_action'], 'INSERT')
			}

			// re-insert the same data + 1 more
			const { rows: rows2, affectedCount } = await tx(client => (
				insertData(
					[
						{ name: 'RAuthor 1', nickname: 'Testing' },
						{ name: 'RAuthor 2' },
						{ name: 'RAuthor 3' },
						{ name: 'RAuthor 4' }
					],
					client,
					{ type: 'replace' },
					['id', 'name', 'nickname'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows2?.length, 4)
			assert.strictEqual(affectedCount, 4)
			assert.partialDeepStrictEqual(
				rows2?.at(0),
				{ 'row_action': 'UPDATE', nickname: 'Testing' }
			)
		})

		it('should handle duplicate inputs and return rows', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'RAuthor 10',
					nickname: 'Testing',
				},
				{
					name: 'RAuthor 10', // duplicate
					nickname: 'Testing 2',
				},
				{
					name: 'RAuthor 11',
				}
			]

			const { rows, affectedCount } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'replace' },
					['id', 'name', 'nickname'],
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rows?.length, 3)
			assert.strictEqual(affectedCount, 2)
			assert.strictEqual(rows[0]['id'], rows[1]['id'])
			assert.strictEqual(rows[1]['row_action'], 'DUPLICATE')
			// first row's nickname should be set
			assert.strictEqual(rows[1]['nickname'], 'Testing')
		})

		it('should handle duplicate inputs and return nothing', async() => {
			const authors: Partial<Author>[] = [
				{
					name: 'RAuthor 15',
					nickname: 'Testing',
				},
				{
					name: 'RAuthor 15', // duplicate
					nickname: 'Testing 2',
				},
				{
					name: 'RAuthor 17',
				}
			]

			const { rowCount, affectedCount } = await tx(client => (
				insertData(
					authors,
					client,
					{ type: 'replace' },
					undefined,
					AUTHOR_CTX
				)
			))

			assert.strictEqual(rowCount, 3)
			assert.strictEqual(affectedCount, 2)
		})
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