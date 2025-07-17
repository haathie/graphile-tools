import { type BootedGraphileServer, runDdlAndBoot } from '@haathie/postgraphile-common-utils/tests'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { CONFIG } from './config.ts'

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

	})
})