import { type BootedGraphileServer, runDdlAndBoot, runSqlFile } from '@haathie/postgraphile-common-utils/tests'
import { createClient } from 'graphql-ws'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { CONFIG } from './config.ts'

const TEST_USER_ID = 'test-user'

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

describe('Fancy Subscriptions', () => {

	let srv: BootedGraphileServer
	let wsUrl: string
	let client: ReturnType<typeof createClient>

	before(async() => {
		await runSqlFile(CONFIG.preset, 'packages/fancy-subscriptions/sql/fancy-subscriptions.sql')
		srv = await runDdlAndBoot(CONFIG)

		wsUrl = `ws://localhost:${srv.port}/graphql`

		client = createClient({
			url: wsUrl,
			connectionParams: {
				'x-user-id': TEST_USER_ID
			},
		})
	})

	after(async() => {
		await client.dispose()
		await srv.close()
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

	it('should subscribe to book changes', async() => {
		const createSubQl = `subscription BooksCreated($creatorId: String!) {
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
		const iterator = client.iterate({
			query: createSubQl,
			variables: {
				creatorId: TEST_USER_ID
			}
		})

		const nextValue = iterator.next()

		// create a book
		const { createBook: { book } } = await srv.graphqlRequest<any>({
			query: CREATE_QL,
			variables: {
				input: {
					title: 'Test Book',
					author: 'Somebody',
				}
			},
			headers: { 'x-user-id': TEST_USER_ID }
		})

		const rslt = await nextValue
		const { value: { data: { booksCreated: { eventId, items } } } } = rslt

		assert.ok(eventId)
		assert.strictEqual(items.length, 1)
		// Note: the "id" column doesn't match as it's stringified in
		// the subscription but isn't in the mutation response
		assert.strictEqual(items[0].rowId, book.rowId)

		// check that a mutation on another creator's book doesn't trigger the subscription
		it('should not trigger subscription for other users', async() => {
			const userId2 = 'another-user'
			const iterate2 = client.iterate({
				query: createSubQl,
				variables: {
					creatorId: userId2
				}
			})

			const nextValue2 = iterate2.next()
			const nextValueOg = iterator.next()

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
		})
	})
})