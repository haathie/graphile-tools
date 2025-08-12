import { getInputConditionForResource } from '@haathie/postgraphile-common-utils'
import type { PgCodecWithAttributes, PgCondition } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputFieldConfig, GraphQLInputObjectType } from 'postgraphile/graphql'
import { type SQL, sql } from 'postgraphile/pg-sql2'
import { getFilterTypesForAttribute } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLInputObjectType_fields']

export const fields: Hook = (fieldMap, build, ctx) => {
	const { behavior, inflection, getTypeByName } = build
	const { scope: { pgCodec: _codec, isPgCondition }, fieldWithHooks } = ctx
	if(!isPgCondition || !_codec?.extensions?.isTableLike) {
		return fieldMap
	}

	const pgCodec = _codec as PgCodecWithAttributes
	const pgResource = build.pgTableResource(pgCodec)!

	for(const attrName in pgCodec.attributes) {
		const hasFilter = getFilterTypesForAttribute(pgCodec, attrName, build)
			.next()
			.value
		if(!hasFilter) {
			continue
		}

		const typeName = inflection.conditionContainerTypeName(pgResource, attrName)
		const type = getTypeByName(typeName) as GraphQLInputObjectType | undefined
		if(!type) {
			throw new Error(
				`Condition type ${typeName} for attribute "${attrName}" `
				+ `not found in codec "${pgCodec.name}".`
			)
		}

		const fieldName = inflection
			.attribute({ attributeName: attrName, codec: pgCodec })
		fieldMap[fieldName] = fieldWithHooks(
			{ fieldName, isConditionContainer: true },
			() => ({ extensions: { grafast: { apply: passThroughApply } }, type })
		)
	}

	// add queries via refs
	for(const [refName, { paths }] of Object.entries(pgCodec.refs || {})) {
		if(!behavior.pgCodecRefMatches([pgCodec, refName], 'filterable')) {
			continue
		}

		if(!paths.length) {
			throw new Error(
				`Ref ${refName} on codec ${pgCodec.name} has no paths defined.`
			)
		}

		if(paths.length > 1) {
			throw new Error('Refs w multiple paths are not supported yet.')
		}

		const { relationName } = paths[0][0]
		const field = buildRelationSearch(relationName)
		if(!field) {
			continue
		}

		const fieldName = inflection.camelCase(refName)
		fieldMap[fieldName] = field
	}

	return fieldMap

	function buildRelationSearch(
		relationName: string
	): GraphQLInputFieldConfig | undefined {
		const relation = pgResource?.getRelation(relationName)
		if(!relation) {
			return
		}

		const rmtRrsc = relation.remoteResource
		const rmtRrscFrom = rmtRrsc.from as SQL
		const remoteResourceCond = getInputConditionForResource(
			// @ts-expect-error
			rmtRrsc,
			build
		)
		if(!remoteResourceCond) {
			throw new Error(
				'The remote resource does not have a condition type defined.'
			)
		}

		return {
			type: remoteResourceCond,
			extensions: {
				grafast: {
					apply(target: PgCondition) {
						const wherePlan = target
							.existsPlan({ alias: 't', tableExpression: rmtRrscFrom })

						const localAttrsJoined = sql.join(
							(relation.localAttributes as string[]).map(attr => (
								sql`${target.alias}.${sql.identifier(attr)}`
							)),
							','
						)
						const remoteAttrsJoined = sql.join(
							(relation.remoteAttributes as string[]).map(attr => (
								sql`${wherePlan.alias}.${sql.identifier(attr)}`
							)),
							','
						)

						wherePlan.where(sql`(${localAttrsJoined}) = (${remoteAttrsJoined})`)

						return wherePlan
					}
				}
			}
		}
	}
}

const passThroughApply: InputObjectFieldApplyResolver = p => p