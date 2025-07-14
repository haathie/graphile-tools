import { getRelationFieldName } from '@haathie/postgraphile-common-utils'
import type { PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'
import type { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLInputType } from 'postgraphile/graphql'
import type { PgTableResource } from './types.ts'
import { isInsertable, isInsertableAttribute } from './utils.ts'

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
	const remoteResource = relation.remoteResource as PgResource<string, PgCodecWithAttributes>
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