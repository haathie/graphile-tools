import { type PgCodecAttribute, type PgCodecWithAttributes, PgCondition, type PgSelectQueryBuilder, PgSelectStep } from 'postgraphile/@dataplan/pg'
import { type InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import { type GraphQLInputFieldConfig, GraphQLInputObjectType, type GraphQLInputType } from 'postgraphile/graphql'
import { type SQL } from 'postgraphile/pg-sql2'
import { getInputConditionForResource } from '../fancy-mutations/utils.ts'
import { FILTER_METHODS, FILTER_TYPES_MAP, type FilterMethod, type FilterType } from './filters.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLInputObjectType_fields']

type FilterInfo = {
	types: FilterType[]
	method: FilterMethod | undefined
}

const inputConditionTypes: { [key: string]: GraphQLInputType } = {}

const hook: Hook = (fieldMap, build, ctx) => {
	const { behavior, inflection } = build
	const { scope: { pgCodec: _codec, isPgCondition } } = ctx
	if(!isPgCondition || !_codec?.extensions?.isTableLike) {
		return fieldMap
	}

	const pgCodec = _codec as PgCodecWithAttributes
	const pgResource = build.pgTableResource(pgCodec)!

	const typeName = build.getGraphQLTypeNameByPgCodec(pgCodec, 'output')

	for(const attrName in pgCodec.attributes) {
		const applicableTypes: FilterType[] = []
		const method = FILTER_METHODS.find(m => (
			behavior.pgCodecAttributeMatches([pgCodec, attrName], `filterMethod:${m}`)
		))
		for(const _filterType in FILTER_TYPES_MAP) {
			const filterType = _filterType as FilterType
			if(
				behavior
					.pgCodecAttributeMatches([pgCodec, attrName], `filterType:${filterType}`)
			) {
				applicableTypes.push(filterType)
			}
		}

		if(!applicableTypes.length) {
			continue
		}

		const info: FilterInfo = { types: applicableTypes, method }
		const field = addConditionField(attrName, info)
		if(!field) {
			continue
		}

		const fieldName = inflection
			.attribute({ attributeName: attrName, codec: pgCodec })
		fieldMap[fieldName] = field
	}

	// add queries via refs
	for(const [refName, { paths }] of Object.entries(pgCodec.refs || {})) {
		if(
			!behavior.pgCodecRefMatches([pgCodec, refName], 'searchable')
		) {
			continue
		}

		if(!paths.length) {
			throw new Error(
				`Ref ${refName} on codec ${pgCodec.name} has no paths defined.`
			)
		}

		if(paths.length > 1) {
			throw new Error(
				'Refs w multiple paths are not supported yet.'
			)
		}

		const relationName = paths[0][0].relationName
		const field = buildRelationSearch(relationName)
		if(!field) {
			continue
		}

		const fieldName = inflection.camelCase(refName)
		fieldMap[fieldName] = field
	}

	return fieldMap

	function addConditionField(
		attrName: string, { types: filterTypes, method }: FilterInfo
	): GraphQLInputFieldConfig | undefined {
		const attr = pgCodec.attributes[attrName]
		const attrSingularCodec = attr.codec.arrayOfCodec || attr.codec
		const graphQlType = build
			.getGraphQLTypeByPgCodec(attrSingularCodec, 'input') as GraphQLInputType
		if(!graphQlType) {
			return
		}

		return {
			extensions: { grafast: { apply: passThroughApply } },
			type: new GraphQLInputObjectType({
				name: inflection.upperCamelCase(`${typeName}_${attrName}_condition`),
				description: `Conditions for filtering by ${attrName}`,
				isOneOf: true,
				fields: filterTypes.reduce((fields, filterType) => {
					const condType = buildConditionField(
						attrName, attr, filterType, method, graphQlType
					)
					fields[filterType] = condType
					return fields
				}, { } as Record<string, GraphQLInputFieldConfig>),
			})
		}
	}

	function buildConditionField(
		attrName: string,
		attr: PgCodecAttribute,
		filter: FilterType,
		method: FilterMethod | undefined,
		graphQlType: GraphQLInputType
	): GraphQLInputFieldConfig {
		const { buildType, buildApplys } = FILTER_TYPES_MAP[filter]
		let builtType = buildType(graphQlType, inflection)
		if('name' in builtType) {
			if(inputConditionTypes[builtType.name]) {
				// If the type is already built, reuse it
				builtType = inputConditionTypes[builtType.name]
			} else {
				inputConditionTypes[builtType.name] = builtType
			}
		}

		const buildApply = buildApplys[method || 'default']
		if(!buildApply) {
			throw new Error(
				`No apply builder for filter type ${filter} and method ${method}`
			)
		}

		return {
			type: builtType,
			extensions: {	grafast: { apply: buildApply(attrName, attr) } }
		}
	}

	function buildRelationSearch(
		relationName: string
	): GraphQLInputFieldConfig | undefined {
		const relation = pgResource?.getRelation(relationName)
		if(!relation) {
			return
		}

		const rmtRrsc = relation.remoteResource
		const rmtRrscFrom = rmtRrsc.from as SQL
		const remoteResourceCond = getInputConditionForResource(rmtRrsc, build)
		if(!remoteResourceCond) {
			//throw new Error('TODO')
			return
		}

		return {
			type: remoteResourceCond,
			extensions: {
				grafast: {
					apply(target: PgCondition) {
						const condParent = target['parent'] as PgSelectQueryBuilder
						if(!condParent) {
							throw new Error(
								'Cannot apply relation search condition without a parent query builder.'
							)
						}

						const alias = condParent.singleRelation(relationName)
						return new PgCondition({ ...condParent, alias }, false)
					}
				}
			}
		}
	}
}

function buildConditionFields(
	codec: PgCodecWithAttributes,
	build: GraphileBuild.Build,
) {

}

const passThroughApply: InputObjectFieldApplyResolver = s => s

export const FancyConditionsPlugin: GraphileConfig.Plugin = {
	name: 'FancyConditionsPlugin',
	version: '0.0.1',
	schema: {
		hooks: {
			'GraphQLInputObjectType_fields': hook,
			'GraphQLObjectType_fields_field'(field, build, ctx) {
				if(!ctx.scope.isRootQuery) {
					return field
				}

				// const ogPlan = field.plan
				// field.plan = (parent, args, info) => {
				// 	const res = ogPlan!(parent, args, info)
				// 	if(!(res instanceof ConnectionStep)) {
				// 		return res
				// 	}

				// 	const subPlan = res.getSubplan() as PgSelectStep
				// 	// console.log(ctx.scope.pgCodec.rela)
				// 	const alias = subPlan.singleRelation('contactsSearchViewByMyId')

				// 	return res
				// }

				return field
			}
		}
	}
}