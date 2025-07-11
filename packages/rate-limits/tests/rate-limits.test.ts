import assert from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import { GraphQLError } from 'postgraphile/graphql'
import { CONFIG, OVERRIDE_BOOKS_LIMIT } from './config.ts'
import { type BootedGraphileServer, type GraphQLRequest, runDdlAndBoot } from './utils.ts'

describe('Rate Limits', () => {

	const maxUnauthReqs = CONFIG.preset.schema?.haathieRateLimits
		?.defaultUnauthenticatedLimit
		?.max!

	let srv: BootedGraphileServer
	let ip: string
	let userId: string

	before(async() => {
		srv = await runDdlAndBoot(CONFIG)
	})

	after(async() => {
		await srv?.close()
	})

	beforeEach(() => {
		ip = Math.random().toString(36)
		userId = `testing_user_${Math.random().toString(36).slice(2, 10)}`
	})

	it('should ensure rate limit description is present', () => {
		const booksQuery = srv.schema.getQueryType()?.getFields()?.allBooks
		assert.match(booksQuery?.description!, /@rateLimits/)
		// ensure the authentication rate limit is set too
		assert.match(booksQuery?.description!, /authenticated/)

		const mutationFields = srv.schema.getMutationType()?.getFields()
		assert.match(mutationFields?.createBook?.description!, /@rateLimits/)
		assert.match(mutationFields?.updateBook?.description!, /@rateLimits/)
		assert.match(mutationFields?.deleteBook?.description!, /@rateLimits/)
	})

	it('should apply unauthenticated rate limits', async() => {
		const simpleBooksQuery = 'query GetBooks { allBooks { nodes { id title } } }'
		await repeatTillRateLimitHit(
			{
				query: simpleBooksQuery,
				headers: { 'x-forwarded-for': ip }
			},
			maxUnauthReqs,
			err => {
				assert.match(err.message, /unauthenticated/)
			}
		)

		await it('should ensure another IP can still access endpoint', async() => {
			// ensure another IP can still access the data
			await srv.graphqlRequest({ query: simpleBooksQuery })
		})

		await it('should other ops to be executed', async() => {
			await repeatTillRateLimitHit(
				{
					query: `mutation MyMutation($title: String!, $author: String!) {
						createBook(input: {book: {title: $title, author: $author}}) {
							book {
								author
								metadata
								rowId
								title
							}
						}
					}`,
					variables: { title: 'Test Book', author: 'Test Author' },
					headers: { 'x-forwarded-for': ip }
				},
				maxUnauthReqs,
				err => {
					assert.match(err.message, /unauthenticated/)
				}
			)
		})
	})

	it('should apply authenticated rate limits', async() => {
		const simpleBooksQuery = 'query GetBooks { allBooks { nodes { id title } } }'

		for(let i = 0; i < maxUnauthReqs; i++) {
			await srv.graphqlRequest({
				query: simpleBooksQuery,
				headers: { 'x-forwarded-for': ip }
			})
		}

		await repeatTillRateLimitHit(
			{
				query: simpleBooksQuery,
				headers: { 'x-forwarded-for': ip, 'x-user-id': userId }
			},
			OVERRIDE_BOOKS_LIMIT.max,
			err => {
				assert.match(err.message, /\"authenticated\"/)
			}
		)
	})

	async function repeatTillRateLimitHit(
		request: GraphQLRequest,
		maxReqs: number,
		matchError: (err: GraphQLError) => void
	) {
		for(let i = 0; i < maxReqs; i++) {
			await srv.graphqlRequest(request)
		}

		await assert.rejects(
			() => srv.graphqlRequest(request),
			(err: GraphQLError) => {
				assert.match(err.message, /rate limit/)
				matchError(err)
				return true
			}
		)
	}
})