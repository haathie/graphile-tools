import { type BootedGraphileServer, getSuperuserPool, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { GraphQLInputObjectType, printSchema } from 'postgraphile/graphql'
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

describe('Conditions', () => {

	let srv: BootedGraphileServer
	let authors: Author[]

	before(async() => {
		srv = await runDdlAndBoot(CONFIG)

		// seed the database with some data
		const pool = getSuperuserPool(CONFIG.preset)
		const { rows } = await pool.query(
			`INSERT INTO "fancy_conditions_test"."authors"
				(name, bio, metadata, nicknames)
			VALUES
				('Author One', ROW(30, 'Science Fiction'), '{"hobby": "reading"}', '{A1,a_one}'),
				('Author Two', ROW(40, 'Fantasy'), '{"hobby": "writing"}', '{A2,a_two}'),
				('Author Three', ROW(25, 'Mystery'), '{"hobby": "gaming"}', '{A3,a_three}')
			RETURNING *;`
		)
		authors = rows as Author[]

		await pool.query(
			`INSERT INTO "fancy_conditions_test"."books" (title, author_id)
			VALUES
				('Book One', ${authors[0].id}),
				('Book Two', ${authors[1].id}),
				('Book Three', ${authors[2].id});`
		)
	})

	after(async() => {
		await srv?.close()
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
})