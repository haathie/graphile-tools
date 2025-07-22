import type {} from 'postgraphile'
import { inflection } from './inflection.ts'
import { fieldsHook } from './schema-fields.ts'
import { initHook } from './schema-init.ts'

export const FancyMutationsPlugin: GraphileConfig.Plugin = {
	name: 'FancyMutationsPlugin',
	inflection: inflection,
	after: [
		'PgMutationUpdateDeletePlugin',
		'PgMutationCreatePlugin',
	],
	schema: {
		behaviorRegistry: {
			'add': {
				'bulkCreate': {
					description: 'Add bulk create (insert + upsert) mutation',
					entities: ['pgResource']
				},
				'bulkUpdate': {
					description: 'Add bulk update mutation',
					entities: ['pgResource']
				},
				'bulkDelete': {
					description: 'Add bulk delete mutation',
					entities: ['pgResource']
				}
			}
		},
		entityBehavior: {
			pgResource: [
				'bulkCreate',
				'bulkUpdate',
				'bulkDelete',
			],
		},
		hooks: {
			'init': initHook,
			'GraphQLObjectType_fields': fieldsHook,
		}
	}
}