import { type BootedGraphileServer, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { CONFIG } from './config.ts'

type SimpleMutationResult = {
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

describe('Fancy Mutations', () => {

	let srv: BootedGraphileServer

	before(async() => {
		srv = await runDdlAndBoot(CONFIG)
	})

	after(async() => {
		await srv?.close()
	})

	it('should correctly generate schemas', async() => {
		const schema = srv.schema
		const mutationFields = schema.getMutationType()?.getFields()
		assert.ok(mutationFields)

		assert.ok(mutationFields.createAuthors)
		assert.ok(mutationFields.updateAuthors)
		assert.ok(mutationFields.deleteAuthors)
	})

	it('should bulk create authors with books', async() => {
		const mutQl = `mutation CreateAuthors($input: [AuthorsCreateItem!]!) {
			createAuthors(items: $input, onConflict: DoNothing) {
				items {
					rowId
					name
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
		const {
			createAuthors: { items }
		} = await srv.graphqlRequest<SimpleMutationResult>({
			query: mutQl,
			variables: {
				input: [
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
			}
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
	})
})