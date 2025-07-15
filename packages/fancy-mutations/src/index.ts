import type {} from 'postgraphile'
import { inflection } from './inflection.ts'
import { fieldsHook } from './schema-fields.ts'
import { initHook } from './schema-init.ts'

export const FancyMutationsPlugin: GraphileConfig.Plugin = {
	name: 'FancyMutationsPlugin',
	inflection: inflection,
	schema: {
		entityBehavior: {
			pgResource: [
				'insert',
				'update',
				'delete',
			],
		},
		hooks: {
			'init': initHook,
			'GraphQLObjectType_fields': fieldsHook,
		}
	}
}