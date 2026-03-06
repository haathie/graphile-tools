import { type BootedGraphileServer, bootPreset, getSuperuserPool, makeRandomPort, runDdl } from '@haathie/postgraphile-common-utils/tests'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { GraphQLObjectType, GraphQLInputObjectType } from 'postgraphile/graphql'
import { CONFIG } from './config.ts'

describe('ReplaceTypesPlugin', () => {
  let srv: BootedGraphileServer

  before(async () => {
    await runDdl(CONFIG)
    srv = await bootPreset(CONFIG.preset, makeRandomPort())
  })

  after(async () => {
    await srv.destroy()
  })

  it('should replace field types based on @replaceType tag', async () => {
    const { schema } = srv

    const userType = schema.getType('User')
    assert.ok(userType, 'User type should exist')
    assert.ok(userType.name === 'User', 'Should be User type')

    const fields = (userType as GraphQLObjectType).getFields()
    const statusField = fields['status']
    assert.ok(statusField, 'status field should exist')

    assert.ok(
      statusField.type.toString() === 'CustomStatus',
      `Expected type CustomStatus but got ${statusField.type.toString()}`
    )
  })

  it('should replace custom_status field type with CustomStatus', async () => {
    const { schema } = srv

    const userType = schema.getType('User')
    assert.ok(userType, 'User type should exist')
    const fields = (userType as GraphQLObjectType).getFields()
    const customStatusField = fields['customStatus']
    assert.ok(customStatusField, 'customStatus field should exist')

    assert.ok(
      customStatusField.type.toString() === 'CustomStatus',
      `Expected type CustomStatus but got ${customStatusField.type.toString()}`
    )
  })

  it('should query user with replaced type using enum values', async () => {
    const pool = getSuperuserPool(CONFIG.preset)
    await pool.query(`
      INSERT INTO replace_types_test.users (name, status, custom_status)
      VALUES ('John', 'ACTIVE', 'ACTIVE'), ('Jane', 'INACTIVE', 'INACTIVE')
    `)

    const result = await srv.graphqlRequest<{
      allUsers: { nodes: { id: number; name: string; status: string; customStatus: string }[] }
    }>({
      query: `
        query {
          allUsers {
            nodes {
              id
              name
              status
              customStatus
            }
          }
        }
      `
    })

    assert.strictEqual(result.allUsers.nodes.length, 2)
  })

  it('should replace input field types based on @replaceType tag', async () => {
    const { schema } = srv

    const userInputType = schema.getType('UserInput')
    assert.ok(userInputType, 'UserInput type should exist')

    const fields = (userInputType as GraphQLInputObjectType).getFields()
    const statusField = fields['status']
    assert.ok(statusField, 'status field should exist')

    assert.ok(
      statusField.type.toString() === 'CustomStatus',
      `Expected type CustomStatus (fallback) but got ${statusField.type.toString()}`
    )
  })

  it('should insert user with replaced input type using enum value', async () => {
    const result = await srv.graphqlRequest<{
      createUser: { user: { id: number; name: string; status: string } | null }
    }>({
      query: `
        mutation {
          createUser(input: {
            user: {
              name: "TestUser"
              status: PENDING
            }
          }) {
            user {
              id
              name
              status
            }
          }
        }
      `
    })

    console.log('Result:', JSON.stringify(result, null, 2))
    assert.ok(result.createUser.user, 'User should be created')
    assert.strictEqual(result.createUser.user!.name, 'TestUser')
    assert.strictEqual(result.createUser.user!.status, 'PENDING')
  })
})
