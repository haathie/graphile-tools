import { type BootedGraphileServer, bootPreset, getSuperuserPool, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'assert'
import { after, before, describe, it } from 'node:test'
import type { GraphQLError } from 'postgraphile/graphql'
import { DEFAULT_RECORDS_PER_PAGE } from '../src/index.ts'
import { CONFIG } from './config.ts'

type QueryResult = { allBooks: { nodes: unknown[] } }

describe('Reasonable Limits', () => {

	let srv: BootedGraphileServer
	before(async() => {
		srv = await runDdlAndBoot(CONFIG)

		const pool = getSuperuserPool(CONFIG.preset)
		// insert like a 100 books
		await pool.query(`
			INSERT INTO "reasonable_limits_test"."books" (title, author)
			SELECT 'Book ' || i, 'Author ' || i FROM generate_series(1, 100) AS s(i)
		`)
	})

	after(async() => {
		await srv?.destroy()
	})

	it('should set a default limit', async() => {
		const res = await srv.graphqlRequest<QueryResult>({
			query: 'query GetBooks { allBooks { nodes { id title } } }'
		})
		assert.strictEqual(res.allBooks.nodes.length, DEFAULT_RECORDS_PER_PAGE)
	})

	it('should enforce a max limit', async() => {
		await assert.rejects(
			() => (
				srv.graphqlRequest<QueryResult>({
					query: `query GetBooks($limit: Int) {
						allBooks(first: $limit) { nodes { id title } }
					}`,
					variables: { limit: 1000 }
				})
			),
			(err: GraphQLError) => {
				assert.match(err.message, /Maximum of /)
				return true
			}
		)
	})

	describe('Customised Limits', () => {

		before(async() => {
			const pool = getSuperuserPool(CONFIG.preset)
			await pool.query(`
				COMMENT ON TABLE "reasonable_limits_test"."books" IS $$
				@maxRecordsPerPage 50
				@defaultRecordsPerPage 20
				$$;
			`)

			await srv.closeServer()
			srv = await bootPreset(CONFIG.preset, srv.port)
		})

		after(async() => {
			await srv.closeServer()
			srv = await runDdlAndBoot(CONFIG)
		})

		it('should apply the custom max limit', async() => {
			await assert.rejects(
				() => (
					srv.graphqlRequest<QueryResult>({
						query: `query GetBooks($limit: Int) {
							allBooks(first: $limit) { nodes { id title } }
						}`,
						variables: { limit: 90 }
					})
				),
				(err: GraphQLError) => {
					assert.match(err.message, /Maximum of 50/)
					return true
				}
			)
		})

		it('should apply the limit on null limit', async() => {
			await assert.rejects(
				() => (
					srv.graphqlRequest<QueryResult>({
						query: `query GetBooks($limit: Int) {
							allBooks(first: $limit) { nodes { id title } }
						}`,
						variables: { limit: null }
					})
				),
				(err: GraphQLError) => {
					assert.match(err.message, /cannot be null without/)
					return true
				}
			)
		})

		it('should apply the custom default limit', async() => {
			const res = await srv.graphqlRequest<QueryResult>({
				query: 'query GetBooks { allBooks { nodes { id title } } }'
			})
			assert.strictEqual(res.allBooks.nodes.length, 20)
		})

		it('should not apply the first limit when using last', async() => {
			const res = await srv.graphqlRequest<QueryResult>({
				query: `query GetBooks {
					allBooks(last: 15, first: null) { nodes { id title } }
				}`
			})
			assert.strictEqual(res.allBooks.nodes.length, 15)
		})
	})
})