import { type BootedGraphileServer, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { GraphQLInputObjectType, printSchema } from 'postgraphile/graphql'
import { CONFIG } from './config.ts'

describe('Conditions', () => {

	let srv: BootedGraphileServer

	before(async() => {
		srv = await runDdlAndBoot(CONFIG)
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
				name: {}
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
	})
})