import { type BootedGraphileServer, getSuperuserPool, runDdlAndBoot, runSqlFile } from '@haathie/postgraphile-common-utils/tests'
import { createClient } from 'graphql-ws'
import assert from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import type { PoolClient } from 'pg'
import { SubscriptionManager } from '../src/manager.ts'
import { CONFIG } from './config.ts'

const CREATE_QL = `mutation CreateBook($input: BookInput!) {
	createBook(input: { book: $input }) {
		book {
			id
			rowId
			title
			author
			metadata
			creatorId
			createdAt
			updatedAt
		}
	}
}`

const UPDATE_QL = `mutation UpdateBook($input: UpdateBookInput!) {
	updateBook(input: $input) {
		book {
			id
			rowId
			title
			author
			metadata
			creatorId
			createdAt
			updatedAt
		}
	}
}`

const CREATE_SUB_QL = `subscription BooksCreated($creatorId: String!) {
	booksCreated(
		condition: { creatorId: $creatorId }
	) {
		eventId
		items {
			id
			rowId
			title
			author
			metadata
			creatorId
			createdAt
			updatedAt
		}
	}
}`

describe('Fancy Subscriptions', () => {

	let srv: BootedGraphileServer
	let wsUrl: string
	let client: ReturnType<typeof createClient>
	let testUserId: string
	let tstIdx = 0

	before(async() => {
		await runSqlFile(
			CONFIG.preset,
			'packages/fancy-subscriptions/sql/fancy-subscriptions.sql'
		)
		srv = await runDdlAndBoot(CONFIG)

		wsUrl = `ws://localhost:${srv.port}/graphql`

		client = createClient({
			url: wsUrl,
			connectionParams: {
				'x-user-id': testUserId
			},
		})

		await SubscriptionManager.current.readChanges()
	})

	after(async() => {
		await client.dispose()
		await srv.close()
	})

	beforeEach(async() => {
		testUserId = `test_user_${tstIdx++}`
	})

	it('should correctly generate the schema', () => {
		const { schema } = srv
		const subFields = schema.getSubscriptionType()?.getFields()
		assert.ok(subFields)
		assert.ok(subFields['booksCreated'])
		assert.ok(subFields['booksUpdated'])
		assert.ok(subFields['booksDeleted'])

		assert.ok(!subFields['authorsCreated'])
	})

	it('should subscribe to created items', async() => {
		const iterator = client.iterate({
			query: CREATE_SUB_QL,
			variables: { creatorId: testUserId }
		})

		const nextValue = iterator.next()

		await setTimeout(500)

		// create a book
		const { createBook: { book } } = await srv.graphqlRequest<any>({
			query: CREATE_QL,
			variables: {
				input: {
					title: 'Test Book',
					author: 'Somebody',
				}
			},
			headers: { 'x-user-id': testUserId }
		})

		const rslt = await nextValue
		const { value: { data: { booksCreated: { eventId, items } } } } = rslt

		assert.ok(eventId)
		assert.strictEqual(items.length, 1)
		// Note: the "id" column doesn't match as it's stringified in
		// the subscription but isn't in the mutation response
		assert.strictEqual(items[0].rowId, book.rowId)

		const nextValueOg = iterator.next()

		await it('should not receive another event', async() => {
			const rslt = await Promise.race([
				nextValueOg,
				setTimeout(1000).then(() => 'did not trigger')
			])
			assert.strictEqual(rslt, 'did not trigger')
		})

		// check that a mutation on another creator's book doesn't trigger the subscription
		await it('should not trigger subscription for other users', async() => {
			const userId2 = 'another-user'
			const iterator2 = client.iterate({
				query: CREATE_SUB_QL,
				variables: {
					creatorId: userId2
				}
			})

			const nextValue2 = iterator2.next()

			// create a book for another user
			await srv.graphqlRequest<any>({
				query: CREATE_QL,
				variables: {
					input: {
						title: 'Another Book',
						author: 'Somebody Else',
					}
				},
				headers: { 'x-user-id': userId2 }
			})

			const rslt2 = await nextValue2
			assert.ok(rslt2)

			const ogSub = await Promise.race([
				nextValueOg,
				setTimeout(500).then(() => 'did not trigger')
			])
			assert.strictEqual(ogSub, 'did not trigger')

			await iterator2.return?.()
			await iterator.return?.()
		})
	})

	it('should subscribe to updated items', async() => {
		const updateSubQl = `subscription BooksUpdated($creatorId: String!) {
			booksUpdated(
				condition: { creatorId: $creatorId }
			) {
				eventId
				items {
					key {
						id
						rowId
					}
					patch {
						title
						author
						metadata
					}
				}
			}
		}`
		const iterator = client.iterate({
			query: updateSubQl,
			variables: {
				creatorId: testUserId
			}
		})

		const nextValue = iterator.next()

		const { createBook: { book } } = await srv.graphqlRequest<any>({
			query: CREATE_QL,
			variables: {
				input: {
					title: 'Test Book',
					author: 'Somebody',
				}
			},
			headers: { 'x-user-id': testUserId }
		})

		await srv.graphqlRequest({
			query: UPDATE_QL,
			variables: {
				input: {
					id: book.id,
					bookPatch: { title: 'Updated Book Title' }
				}
			},
			headers: { 'x-user-id': testUserId }
		})

		const {
			value: { data: { booksUpdated: { eventId, items } } }
		} = await nextValue

		assert.ok(eventId)
		assert.strictEqual(items.length, 1)
		assert.partialDeepStrictEqual(
			items[0],
			{
				key: {
					rowId: book.rowId,
				},
				patch: {
					title: 'Updated Book Title',
				}
			}
		)
	})

	it('should subscribe to deleted items', async() => {
		const deleteSubQl = `subscription BooksDeleted($creatorId: String!) {
			booksDeleted(
				condition: { creatorId: $creatorId }
			) {
				eventId
				items {
					id
					rowId
				}
			}
		}`
		const iterator = client.iterate({
			query: deleteSubQl,
			variables: {
				creatorId: testUserId
			}
		})

		const nextValue = iterator.next()

		const { createBook: { book } } = await srv.graphqlRequest<any>({
			query: CREATE_QL,
			variables: {
				input: {
					title: 'Test Book',
					author: 'Wow',
				}
			},
			headers: { 'x-user-id': testUserId }
		})

		await srv.graphqlRequest({
			query: `mutation DeleteBook($input: DeleteBookInput!) {
				deleteBook(input: $input) {
					deletedBookId
				}
			}`,
			variables: {
				input: { id: book.id }
			},
			headers: { 'x-user-id': testUserId }
		})

		const {
			value: { data: { booksDeleted: { eventId, items } } }
		} = await nextValue
		assert.ok(eventId)
		assert.strictEqual(items.length, 1)

		assert.partialDeepStrictEqual(
			items,
			[{ rowId: book.rowId }]
		)

		await iterator.return?.()
	})

	it('should not miss events when reading changes', async() => {
		const iterator = client.iterate({
			query: CREATE_SUB_QL,
			variables: { creatorId: testUserId }
		})

		const eventsPromise = readChanges()

		// we'll make two txs, the first one will be committed last
		// to test the edge case that if the first tx is committed
		// after the second one, it should still be read correctly
		const tx1 = tx(async client => {
			await client.query(
				`INSERT INTO subs_test.books (title, author, creator_id)
				VALUES
					('Test Book RC 1', 'Author RC 1', $1),
					('Test Book RC 2', 'Author RC 2', $1)`,
				[testUserId]
			)

			// wait longer than the next read loop execution
			await setTimeout(2000)
		})

		await setTimeout(100)

		// tx2, started after tx1, but committed first
		await tx(async client => {
			await client.query(
				`INSERT INTO subs_test.books (title, author, creator_id)
				VALUES ('Test Book RC 3', 'Author RC 3', $1)`,
				[testUserId]
			)
		})

		await tx1

		// wait for events to be read
		await setTimeout(1000)

		await iterator.return?.()

		const rows = await eventsPromise
		assert.strictEqual(rows.length, 3)
		assert.partialDeepStrictEqual(
			rows,
			[
				{ title: 'Test Book RC 1' },
				{ title: 'Test Book RC 2' },
				{ title: 'Test Book RC 3' }
			]
		)

		async function readChanges() {
			const events: any[] = []
			for await (const item of iterator) {
				if(!item?.data) {
					continue
				}

				const { booksCreated: { items } } = item.data as any
				events.push(...items)
			}

			return events
		}
	})

	it('should correctly batch events', async() => {
		// we'll test by creating multiple books
		const iterator = client.iterate({
			query: CREATE_SUB_QL,
			variables: { creatorId: testUserId }
		})

		const nextValue = iterator.next()

		const books = await Promise.all(
			Array.from({ length: 5 }).map(async(_, i) => {
				const { createBook: { book } } = await srv.graphqlRequest<any>({
					query: CREATE_QL,
					variables: {
						input: {
							title: `Test Book ${i}`,
							author: 'Somebody',
						}
					},
					headers: { 'x-user-id': testUserId }
				})
				return book
			})
		)

		const rslt = await nextValue
		const { value: { data: { booksCreated: { eventId, items } } } } = rslt
		assert.ok(eventId)
		for(const book of books) {
			const item = items.find((i: any) => i.rowId === book.rowId)
			assert.ok(item, `Book with rowId ${book.rowId} not found in items`)
			assert.strictEqual(item.title, book.title)
			assert.strictEqual(item.author, book.author)
		}
	})

	it('should handle large payloads', async() => {
		const iter = client.iterate(
			{
				query: CREATE_SUB_QL,
				variables: { creatorId: testUserId }
			},
		)
		const expectedItems = 1500
		const waitForAllDone = loopTillAllChangesDone()

		// will attempt to create a massive WAL entry, > 1gb
		// this should not break the logical decoding
		const pool = getSuperuserPool(CONFIG.preset)
		const conn = await pool.connect()
		try {
			await conn.query('BEGIN')
			await conn.query(`SET app.user_id = '${testUserId}'`)

			// create a large book
			const largeTitle = 'A'.repeat(1_000_000) // 1 MB
			await conn.query(
				`INSERT INTO subs_test.books (title, author)
				SELECT
					$1, 'Author ' || i::varchar
				FROM generate_series(1, ${expectedItems}) AS i`,
				[largeTitle]
			)

			await conn.query('COMMIT')
		} catch(err) {
			await conn.query('ROLLBACK')
			throw err
		} finally {
			conn.release()
		}

		console.log('inserted all data')

		await waitForAllDone

		async function loopTillAllChangesDone() {
			let itemsDone = 0
			for await (const item of iter) {
				if(!item?.data) {
					continue
				}

				const { booksCreated: { items } } = item.data as any
				itemsDone += items.length
				console.log(`Received ${itemsDone} items so far`)
				if(itemsDone >= expectedItems) {
					break
				}
			}

			if(itemsDone < expectedItems) {
				throw new Error(
					`Expected ${expectedItems} items, but got only ${itemsDone}`
				)
			}

			console.log(`Received all ${itemsDone} items`)
		}
	})
})

async function tx<T>(
	exec: (client: PoolClient) => Promise<T>
) {
	const pool = getSuperuserPool(CONFIG.preset)
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