import { GraphQLObjectType, type GraphQLObjectTypeConfig } from 'graphql'
import { type PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'
import { createDeleteObject } from './createDeleteObject.ts'
import { createInsertObject } from './createInsertObject.ts'
import { createUpdateObject } from './createUpdateObject.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLSchema']

export const graphQLSchemaHook: Hook = (
	config, build
) => {
	const { inflection, pgTableResource, allPgCodecs } = build
	const existingFields = config.mutation?.getFields() || {}
	const mutations: GraphQLObjectTypeConfig<any, any>['fields'] = {}
	for(const _codec of allPgCodecs) {
		const codec = _codec as PgCodecWithAttributes
		if(!codec.extensions?.isTableLike) {
			continue
		}

		const table = pgTableResource(codec)
		if(!table) {
			continue
		}

		const insertObj = createInsertObject({ table, build })
		if(insertObj) {
			mutations[
				inflection.camelCase(inflection.pluralize(`create_${codec.name}`))
			] = insertObj
			delete existingFields[inflection.createField(table)]
		}

		const deleteObj = createDeleteObject({ table, build })
		if(deleteObj) {
			mutations[
				inflection.camelCase(inflection.pluralize(`delete_${codec.name}`))
			] = deleteObj
			for(const unique of table.uniques) {
				const deleteFieldName = inflection
					.deleteByKeysField({ resource: table, unique })
				delete existingFields[deleteFieldName]
			}
		}

		const updateObj = createUpdateObject({ table, build })
		if(updateObj) {
			const updateFieldName = inflection.bulkUpdateOperationName(table)
			mutations[updateFieldName] = updateObj
			for(const unique of table.uniques) {
				const fieldName = inflection
					.updateByKeysField({ resource: table, unique })
				// console.log('updateFieldName', fieldName)
				delete existingFields[fieldName]
			}
		}

	}

	const newMutations
		= new GraphQLObjectType({ name: 'Mutations', fields: mutations })
	Object.assign(existingFields, newMutations.getFields())
	return config
}