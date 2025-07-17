import { getRelationFieldName } from '@haathie/postgraphile-common-utils'
import * as debug from 'debug'
import type { PgCodecAttribute, PgResource } from 'postgraphile/@dataplan/pg'
import type { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLInputType } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'
import type { PGEntityColumn, PGEntityCtx } from './pg-utils.ts'
import type { PgRowBuilder } from './PgCreateStep.ts'
import type { PgTableResource } from './types.ts'

export const DEBUG = debug.default('@haathie/postgraphile-fancy-mutations:log')

export function buildFieldsForCreate(
	table: PgTableResource,
	build: GraphileBuild.Build,
	path: string[] = []
): GraphileBuild.GrafastInputObjectTypeConfig['fields'] {
	const { inflection, graphql: { GraphQLNonNull, GraphQLList } } = build
	// relation name => type name
	const upsertRelations: { [relname: string]: string } = {}
	const forwardAttrs = getForwardRelationAttrs(table)

	for(const relationName in table.getRelations()) {
		const typeName = buildRelatedType(
			relationName, table, build, path
		)
		if(!typeName) {
			continue
		}

		upsertRelations[relationName] = typeName
	}

	return ({ fieldWithHooks }) => {
		const relBeingCreated = path.length
			? getRelationByInverseName(table, path.at(-1)!)
			: undefined

		const fields: { [_: string]: GraphQLInputFieldConfig } = {}
		for(const [attrName, attr] of Object.entries(table.codec.attributes)) {
			if(!isInsertableAttribute(build, attr)) {
				continue
			}

			// if the field is a relation attribute, and is a child of
			// the relation being created, we don't want to populate it
			// as it'll conflict with the relation's attributes
			// (e.g. if we're creating an author with a book, we don't
			// want to populate the book's author attribute, if these fields are
			// being created by the "booksByAuthor" relation)
			if(
				relBeingCreated?.localAttributes.includes(attrName)
				&& !relBeingCreated.isReferencee
			) {
				continue
			}

			const fieldName = inflection
				.attribute({ codec: table.codec, attributeName: attrName })
			const shouldNotNull = !!attr.notNull
				&& !attr.hasDefault
				// if the attribute is capable of referencing a relation,
				// we don't want to make it non-nullable, as it may be
				// specified via a "create" relation
				&& !forwardAttrs.has(attrName)
			fields[fieldName] = fieldWithHooks(
				{ fieldName, isBulkCreateInputObjectField: true },
				() => {
					const coreType = build
						.getGraphQLTypeByPgCodec(attr.codec, 'input')! as GraphQLInputType
					return {
						type: shouldNotNull
							? new GraphQLNonNull(coreType)
							: coreType,
						apply(plan: PgRowBuilder, input) {
							plan.set(attrName, input)
						}
					}
				}
			)
		}

		for(const [relName, typeName] of Object.entries(upsertRelations)) {
			const { isUnique } = table.getRelation(relName)
			const fieldName = getRelationFieldName(relName, table, build)

			fields[fieldName] = fieldWithHooks(
				{ fieldName, isBulkCreateInputObjectField: true },
				() => {
					const type = build.getTypeByName(typeName) as GraphQLInputObjectType
					return {
						type: isUnique
							? type
							: new GraphQLList(new GraphQLNonNull(type)),
						extensions: {
							grafast: {
								apply(plan: PgRowBuilder) {
									if(isUnique) {
										return plan.setRelation(relName)
									}

									return () => plan.setRelation(relName)
								}
							}
						}
					}
				}
			)
		}

		return fields
	}
}

function buildRelatedType(
	relationName: string,
	fromTable: PgTableResource,
	build: GraphileBuild.Build,
	path: string[]
) {
	const { inflection } = build
	const relation = fromTable.getRelation(relationName)
	const remoteResource = relation.remoteResource as PgTableResource
	if(!isInsertable(build, remoteResource)) {
		return
	}

	const reciprocalRelName = remoteResource
		.getReciprocal(fromTable.codec, relationName)?.[0]
	if(
		path.includes(relationName)
		|| (
			typeof reciprocalRelName === 'string'
			&& path.includes(reciprocalRelName)
		)
	) {
		// avoid circular references
		return
	}

	const newPath = [...path, relationName]
	const relationCreateName = inflection
		.bulkCreateInputObjectRelationName(newPath)

	const fields = buildFieldsForCreate(remoteResource, build, newPath)
	build.registerInputObjectType(
		relationCreateName,
		{
			isBulkCreateInputObjectRelation: true,
			pgResource: remoteResource,
			path: newPath,
		},
		() => ({
			description: 'Input object for the bulk create operation on '
				+ `${remoteResource.name} via relation ${relationName}`,
			fields
		}),
		'Input object for the bulk create operation on '
		+ `${remoteResource.name} via relations ${newPath.join('->')}`
	)

	return relationCreateName
}

function getRelationByInverseName(
	table: PgTableResource,
	inverseName: string,
) {
	for(const relation of Object.values(table.getRelations())) {
		if(relation.remoteResource.getRelation(inverseName)) {
			return relation
		}
	}
}

function getForwardRelationAttrs(
	table: PgTableResource,
) {
	const attrs = new Set<string>()
	for(const rel of Object.values(table.getRelations())) {
		if(rel.isReferencee) {
			continue
		}

		for(const attr of rel.localAttributes) {
			attrs.add(attr)
		}
	}

	return attrs
}

export function getEntityCtx(
	table: PgTableResource
): PGEntityCtx<{ [_: string]: unknown }> {
	const { identifier, executor, codec } = table
	// table ID is the executor name + '.' + table name
	// so we remove the executor name from the identifier
	// to get the fully qualified table name
	// e.g. 'main.public.users' -> 'public.users'
	const fqTableName = identifier.slice(executor.name.length + 1)

	const propToColumnMap: Record<string, PGEntityColumn> = {}
	const primaryKeyNames: string[] = []
	const primaryKey = table.uniques.find(u => u.isPrimary)
	if(!primaryKey) {
		throw new Error(`Table ${fqTableName} does not have a primary key`)
	}

	const otherUniqueNames = table.uniques.map(u => {
		return { columns: [...u.attributes] as string[] }
	})
	for(const attributeName in codec.attributes) {
		const sqlType = codec.attributes[attributeName].codec.sqlType
		propToColumnMap[attributeName] = {
			name: attributeName,
			sqlType: sql.compile(sqlType).text
		}
		if(primaryKey.attributes.includes(attributeName)) {
			primaryKeyNames.push(attributeName)
		}
	}

	return {
		tableName: fqTableName,
		idProperties: primaryKeyNames,
		uniques: otherUniqueNames,
		propertyColumnMap: propToColumnMap,
	}
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationUpdateDeletePlugin.ts#L154
export const isUpdatable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	if(!resource.uniques || resource.uniques.length < 1) {
		return false
	}

	return !!build.behavior.pgResourceMatches(resource, 'resource:update')
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationUpdateDeletePlugin.ts#L154
export const isDeletable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	if(!resource.uniques || resource.uniques.length < 1) {
		return false
	}

	return !!build.behavior.pgResourceMatches(resource, 'resource:delete')
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationCreatePlugin.ts#L53C1-L62C3
export const isInsertable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	return build.behavior.pgResourceMatches(resource, 'resource:insert') === true
}

export const isInsertableAttribute = (
	build: GraphileBuild.Build,
	resource: PgCodecAttribute<any, any>,
) => {
	return resource.extensions?.canInsert || resource.extensions?.isInsertable
}