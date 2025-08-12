import { type BootedGraphileServer, bootPreset, getSuperuserPool, makeRandomPort, runDdl } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import type { GraphQLInputObjectType } from 'postgraphile/graphql'
import { printSchema } from 'postgraphile/graphql'
import type { FilterMethod } from '../src/types.ts'
import { CONFIG } from './config.ts'

type Author = {
	id: number
	name: string
	bio: {
		age: number
		favourite_genre: string
	}
	metadata: Record<string, unknown>
	nickname?: string | null
}

type AuthorsQueryResult = {
	allAuthors: {
		nodes: {
			id: number
			name: string
		}[]
	}
}

const AUTHORS_QUERY = `query GetAuthors($cond: AuthorCondition) {
	allAuthors(condition: $cond) {
		nodes {
			id
			name
		}
	}
}`

type FilterMethodTest = {
	method: FilterMethod
	additionalSql?: string
}

const FILTER_METHOD_TESTS: FilterMethodTest[] = [
	{
		method: 'plainSql',
	},
	{
		method: 'paradedb',
		additionalSql: `
		CREATE EXTENSION IF NOT EXISTS pg_search;
		CREATE INDEX ON "conditions_test"."authors" USING bm25(id, name, nicknames)
		WITH (
			key_field='id',
			text_fields='{
				"name": {
					"fast":true,
					"tokenizer": {"type": "keyword"},
					"record": "basic"
				},
				"nicknames": {
					"fast":true,
					"tokenizer": {"type": "keyword"},
					"record": "basic"
				},
				"name_ngram": {
					"fast":true,
					"tokenizer": {
						"type": "ngram",
						"min_gram": 2,
						"max_gram": 3,
						"prefix_only": false
					},
					"record": "position",
					"column": "name"
				},
				"nicknames_ngram": {
					"fast":true,
					"tokenizer": {
						"type": "ngram",
						"min_gram": 2,
						"max_gram": 3,
						"prefix_only": false
					},
					"record": "position",
					"column": "nicknames"
				}
			}'
		);`
	}
]

// eslint-disable-next-line unicorn/no-array-for-each
FILTER_METHOD_TESTS.forEach(({ method, additionalSql }, i) => describe(`${method} - Conditions`, () => {

	let srv: BootedGraphileServer
	let authors: Author[]

	before(async() => {
		await runDdl(CONFIG)
		const pool = getSuperuserPool(CONFIG.preset)

		if(additionalSql) {
			await pool.query(additionalSql)
		}

		await pool.query(`
			comment on column "conditions_test"."authors".name is $$
			@behaviour filterType:icontains filterType:eq filterMethod:${method}
			@filterConfig icontains:{"fieldName":"name_ngram"}
			$$;
	
			comment on column "conditions_test"."authors".nicknames is $$
			@behaviour filterType:icontains filterType:eq filterType:eqIn filterMethod:${method}
			@filterConfig icontains:{"fieldName":"nicknames_ngram"}
			$$;
	
			comment on column "conditions_test"."authors".id is $$
			@behaviour filterType:eq filterType:eqIn filterType:range filterMethod:${method}
			$$;
		`)

		srv = await bootPreset(CONFIG.preset, makeRandomPort())

		// seed the database with some data
		const { rows } = await pool.query(
			`INSERT INTO "conditions_test"."authors"
				(name, bio, metadata, nicknames)
			VALUES
				('Author One', ROW(30, 'Science Fiction'), '{"hobby": "reading"}', '{A1,a_one}'),
				('Author Two', ROW(40, 'Fantasy'), '{"hobby": "writing"}', '{A2,a_two}'),
				('Author Three', ROW(25, 'Mystery'), '{"hobby": "gaming"}', '{A3,a_three}')
			RETURNING *;`
		)
		authors = rows as Author[]

		await pool.query(
			`INSERT INTO "conditions_test"."books" (title, author_id)
			VALUES
				('Book One', ${authors[0].id}),
				('Book Two', ${authors[1].id}),
				('Book Three', ${authors[2].id});`
		)
	})

	after(async() => {
		// as tests need to only destroy the server, and not the PG pool
		// we only close the server between test suites. However, after
		// the last test suite, we destroy the pool too
		if(i === FILTER_METHOD_TESTS.length - 1) {
			await srv.destroy()
			return
		}

		await srv?.closeServer()
	})

	it('should correctly generate schemas', async() => {
		const schema = srv.schema

		await writeFile('./schema.graphql', printSchema(schema))

		const authorCondition = schema
		 .getType('AuthorCondition') as GraphQLInputObjectType
		assert.ok(authorCondition)
		assert.partialDeepStrictEqual(
			authorCondition.getFields(),
			{
				rowId: {},
				name: {},
				books: {}
			}
		)

		const authorRowIdCondition = authorCondition.getFields()
			.rowId
			.type as GraphQLInputObjectType
		assert.partialDeepStrictEqual(
			authorRowIdCondition.getFields(),
			{
				eq: {},
				eqIn: {},
				range: {}
			}
		)

		// ensure the same condition schema is used for all "range" conditions
		const booksRangeCondition = schema
			.getType('BooksRowIdCondition') as GraphQLInputObjectType
		assert.equal(
			booksRangeCondition.getFields().range.type,
			authorRowIdCondition.getFields().range.type
		)

		// ensure the condition for books in the author condition is the same
		// as the type for the books condition
		const bookCondition = authorCondition.getFields()
			.books
			.type as GraphQLInputObjectType

		assert.equal(bookCondition, schema.getType('BookCondition'))
	})

	describe('Eq', () => {
		it('should query int', async() => {
			await selectAuthorOneByCondition({ rowId: { eq: authors[0].id } })
		})

		it('should query varchar', async() => {
			await selectAuthorOneByCondition({ name: { eq: 'Author One' } })
		})

		it('should query varchar[]', async() => {
			await selectAuthorOneByCondition({ nicknames: { eq: 'A1' } })
		})
	})

	describe('Eq In', () => {
		it('should query int', async() => {
			await selectAuthorOneByCondition({
				rowId: { eqIn: [-2, -1, authors[0].id] }
			})
		})

		it('should query varchar[]', async() => {
			await selectAuthorOneByCondition({
				nicknames: { eqIn: ['Author ABCD', 'a_one'] }
			})
		})
	})

	describe('Insensitve contains', () => {
		it('should query varchar', async() => {
			await selectAuthorOneByCondition({ name: { icontains: 'one' } })
		})

		it('should query varchar[]', async() => {
			await selectAuthorOneByCondition({ nicknames: { icontains: 'a_one' } })
		})
	})

	describe('Range', () => {
		it('should query int', async() => {
			await selectAuthorOneByCondition({
				rowId: { range: { from: -1, to: authors[0].id } }
			})
		})
	})

	describe('Relational Search', async() => {
		it('should query authors by book title', async() => {
			await selectAuthorOneByCondition({
				books: {
					title: { icontains: 'Book One' }
				}
			})
		})
	})

	// write a condition that results in only Author One being returned
	async function selectAuthorOneByCondition(cond: Record<string, unknown>) {
		const {
			allAuthors: { nodes }
		} = await srv.graphqlRequest<AuthorsQueryResult>({
			query: AUTHORS_QUERY,
			variables: { cond }
		})
		assert.equal(nodes.length, 1)
		assert.partialDeepStrictEqual(nodes, [{ name: 'Author One' }])
	}
}))