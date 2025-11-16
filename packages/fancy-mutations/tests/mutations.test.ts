import { type BootedGraphileServer, getSuperuserPool, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type { GraphQLInputObjectType } from 'postgraphile/graphql'
import { CONFIG, makeMutationsPgService } from './config.ts'

type SimpleUpsertResult = {
	createAuthors: {
		items: {
			rowId: number
			name: string
			booksByAuthorId: {
				nodes: {
					rowId: number
					title: string
					publisherByPublisherId: {
						rowId: number
						name: string
					} | null
				}[]
			}
		}[]
	}
}

const UPSERT_QL = `mutation CreateAuthors(
	$input: [AuthorsCreateItem!]!,
	$onConflict: OnConflictOptions!
) {
	createAuthors(items: $input, onConflict: $onConflict) {
		items {
			rowId
			name
			bio {
				age
				favouriteGenre
			}
			booksByAuthorId {
				nodes {
					rowId
					title,
					publisherByPublisherId {
						rowId
						name
					}
				}
			}
		}
	}
}`

describe('Bulk & Nested Mutations', () => {

	let srv: BootedGraphileServer

	before(async() => {
		srv = await runDdlAndBoot(CONFIG)
	})

	after(async() => {
		await srv?.destroy()
	})

	it('should correctly generate schemas', async() => {
		const schema = srv.schema
		const mutationFields = schema.getMutationType()?.getFields()
		assert.ok(mutationFields)

		assert.ok(mutationFields.createAuthors)
		assert.ok(mutationFields.updateAuthors)
		assert.ok(mutationFields.deleteAuthors)
	})

	it('should bulk create authors with books, onConflict: DoNothing', async() => {
		const input = [
			{
				name: 'Author 1',
				booksByAuthorId: [
					{ title: 'Book 1' },
					{ title: 'Book 2' }
				]
			},
			{
				name: 'Author 2',
				booksByAuthorId: [
					{
						title: 'Book 3',
						publisherByPublisherId: { name: 'Publisher 1' }
					},
					{ title: 'Book 4' }
				]
			}
		]
		const {
			createAuthors: { items }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: { onConflict: 'DoNothing', input }
		})

		assert.ok(items[0].rowId)
		assert.ok(items[1].booksByAuthorId.nodes[0].rowId)
		assert.partialDeepStrictEqual(
			items,
			[
				{
					'name': 'Author 1',
					'booksByAuthorId': {
						'nodes': [
							{
								'title': 'Book 1',
								'publisherByPublisherId': null
							},
							{
								'title': 'Book 2',
								'publisherByPublisherId': null
							}
						]
					}
				},
				{
					'name': 'Author 2',
					'booksByAuthorId': {
						'nodes': [
							{
								'title': 'Book 3',
								'publisherByPublisherId': {
									'name': 'Publisher 1'
								}
							},
							{
								'title': 'Book 4',
								'publisherByPublisherId': null
							}
						]
					}
				}
			]
		)

		// ensure the author isn't created again
		// as it has a constraint on the name
		const {
			createAuthors: { items: items2 }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: { onConflict: 'DoNothing', input }
		})
		assert.strictEqual(items2.length, items.length)
		assert.strictEqual(items[0].rowId, items2[0].rowId)
	})

	it('should execute mutations in parallel', async() => {
		const rslts = await Promise.all(
			Array.from({ length: 10 }, async(_, i) => {
				const input = [
					{
						name: `Bulk Author ${i}`,
						'booksByAuthorId': [
							{
								'title': 'BBook ' + (i + 1),
							}
						]
					},
					{
						name: `Bulk Author 2nd - ${i + 1}`,
						booksByAuthorId: []
					}
				]
				const {
					createAuthors: { items }
				} = await srv.graphqlRequest<SimpleUpsertResult>({
					query: UPSERT_QL,
					variables: { onConflict: 'DoNothing', input }
				})

				return { input, output: items }
			})
		)

		for(const { input, output } of rslts) {
			assert.strictEqual(output.length, input.length)
			assert.partialDeepStrictEqual(
				output,
				input.map(item => ({
					name: item.name,
					booksByAuthorId: {
						nodes: item.booksByAuthorId.map(book => ({
							title: book.title,
						}))
					}
				}))
			)
		}
	})

	it('should bulk create authors with onConflict: Error', async() => {
		const input = [
			{
				name: 'Author 3',
				booksByAuthorId: [
					{
						title: 'Book 10',
						'publisherByPublisherId': {
							'name': 'Publisher 3'
						}
					},
					{ title: 'Book 11' }
				]
			},
		]

		const {
			createAuthors: { items }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: {
				onConflict: 'Error',
				input: input
			}
		})
		assert.strictEqual(items.length, 1)

		const pool = getSuperuserPool(CONFIG.preset)
		const { rows: existingPubs } = await pool.query(
			'SELECT * FROM mutations_test.publishers',
		)

		await assert.rejects(() => (
			srv.graphqlRequest<SimpleUpsertResult>({
				query: UPSERT_QL,
				variables: { onConflict: 'Error', input }
			})
		))

		// ensure that if one of the rows fails,
		// the entire mutation fails and no rows are created
		const { rows: newPubs } = await pool.query(
			'SELECT * FROM mutations_test.publishers'
		)
		assert.strictEqual(existingPubs.length, newPubs.length)
	})

	it('should bulk create authors with onConflict: Replace', async() => {
		const {
			createAuthors: { items: initialItems }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: {
				onConflict: 'Replace',
				input: [
					{
						name: 'Author 4',
						bio: { age: 40, 'favouriteGenre': 'something' },
						booksByAuthorId: [
							{ title: 'Book 5' },
						]
					},
				]
			}
		})

		const {
			createAuthors: { items: updatedItems }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: {
				onConflict: 'Replace',
				input: [
					{
						name: 'Author 4',
						bio: { age: 41, 'favouriteGenre': 'something' },
						booksByAuthorId: [
							{ title: 'Book 5' },
						]
					},
				]
			}
		})

		assert.strictEqual(initialItems.length, updatedItems.length)
		assert.strictEqual(initialItems[0].rowId, updatedItems[0].rowId)
		assert.partialDeepStrictEqual(
			updatedItems,
			[
				{
					'name': 'Author 4',
					'bio': { 'age': 41, 'favouriteGenre': 'something' },
					'booksByAuthorId': {
						'nodes': [
							{
								'title': 'Book 5',
								'publisherByPublisherId': null
							},
							{
								'title': 'Book 5',
								'publisherByPublisherId': null
							}
						]
					}
				}
			]
		)
	})

	it('should update authors by query', async() => {
		const {
			createAuthors: { items: [{ rowId }] }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: {
				onConflict: 'Error',
				input: [
					{ name: 'Author 5' },
					{ name: 'Author 6' }
				]
			}
		})

		const { updateAuthors: { items } } = await srv.graphqlRequest<any>({
			query: `mutation UpdateAuthors($condition: AuthorCondition!, $patch: AuthorPatch!) {
				updateAuthors(condition: $condition, patch: $patch) {
					affected
					items {
						rowId
						name
						bio {
							age
							favouriteGenre
						}
					}
				}
			}`,
			variables: {
				condition: { rowId: rowId },
				patch: {
					name: 'Author 5 Updated',
					bio: { age: 35, favouriteGenre: 'Sci-Fi' },
				}
			}
		})

		assert.partialDeepStrictEqual(
			items,
			[
				{
					'rowId': rowId,
					'name': 'Author 5 Updated',
					'bio': { 'age': 35, 'favouriteGenre': 'Sci-Fi' }
				}
			]
		)

		// check if affected count is correct
		const { updateAuthors: { affected } } = await srv.graphqlRequest<any>({
			query: `mutation UpdateAuthors($condition: AuthorCondition!, $patch: AuthorPatch!) {
				updateAuthors(condition: $condition, patch: $patch) {
					affected
				}
			}`,
			variables: {
				condition: { rowId: rowId },
				patch: {
					name: 'Author 5 Updated Again',
				}
			}
		})
		assert.strictEqual(affected, 1)

		// ensure the other author is not affected
		const pool = getSuperuserPool(CONFIG.preset)
		const { rows: authors } = await pool.query(
			'SELECT * FROM mutations_test.authors WHERE name = $1',
			['Author 6']
		)
		assert.partialDeepStrictEqual(
			authors,
			[
				{
					'name': 'Author 6',
					'bio': null
				}
			]
		)
	})

	it('should delete authors by query', async() => {
		const {
			createAuthors: { items: [{ rowId }] }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: {
				onConflict: 'Error',
				input: [
					{ name: 'Author 7' },
					{ name: 'Author 8' },
				]
			}
		})

		const { deleteAuthors: { affected } } = await srv.graphqlRequest<any>({
			query: `mutation DeleteAuthors($condition: AuthorCondition!) {
				deleteAuthors(condition: $condition) {
					affected
				}
			}`,
			variables: {
				condition: { rowId: rowId }
			}
		})

		assert.strictEqual(affected, 1)

		// ensure the other author is not affected
		const pool = getSuperuserPool(CONFIG.preset)
		const { rows: authors } = await pool.query(
			'SELECT name FROM mutations_test.authors WHERE name IN ($1, $2)',
			['Author 7', 'Author 8']
		)
		assert.deepStrictEqual(authors, [{ name: 'Author 8' }])
	})
})

describe('Bulk & Nested Mutations with Permissions', () => {

	let srv: BootedGraphileServer
	beforeEach(async() => {
		CONFIG.preset.pgServices = [makeMutationsPgService()]
	})

	afterEach(async() => {
		await srv?.destroy()
	})

	it('should prevent bulk create books without insert permissions', async() => {
		srv = await runDdlAndBoot({
			...CONFIG,
			ddl: `
				${CONFIG.ddl}
				REVOKE INSERT ON mutations_test.books FROM "muts_user";
			`,
		})

		// check that the mutation is not present
		const schema = srv.schema
		const mutationFields = schema.getMutationType()?.getFields()
		assert.ok(mutationFields)
		assert.ok(!mutationFields.createBooks)

		const createauthor = schema.getType('AuthorInput') as GraphQLInputObjectType
		assert.ok(!createauthor.getFields().booksByAuthorId)

		const input = [
			{ name: 'Author 1' },
			{ name: 'Author 2' }
		]
		const {
			createAuthors: { items }
		} = await srv.graphqlRequest<SimpleUpsertResult>({
			query: UPSERT_QL,
			variables: { onConflict: 'DoNothing', input }
		})

		assert.strictEqual(items.length, 2)
	})
})