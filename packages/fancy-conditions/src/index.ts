import { getInputConditionForResource, isSubscriptionPlan } from '@haathie/graphile-common-utils'
import { type PgCodecAttribute, type PgCodecWithAttributes, PgCondition } from 'postgraphile/@dataplan/pg'
import { type InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import { type GraphQLInputFieldConfig, GraphQLInputObjectType, type GraphQLInputType } from 'postgraphile/graphql'
import { type SQL, sql } from 'postgraphile/pg-sql2'
import { FILTER_METHODS, FILTER_METHODS_CONFIG, FILTER_TYPES_MAP, type FilterMethod, type FilterType } from './filters.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLInputObjectType_fields']

type FilterInfo = {
	types: FilterType[]
	method: FilterMethod | undefined
}

declare global {
	namespace GraphileBuild {
		interface Build {
			inputConditionTypes: { [key: string]: GraphQLInputType }
		}
	}
}

const hook: Hook = (fieldMap, build, ctx) => {
	const { behavior, inflection, inputConditionTypes } = build
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
		if(!behavior.pgCodecRefMatches([pgCodec, refName], 'searchable')) {
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

		const applyDefault = buildApplys.default(attrName, attr)
		return {
			type: builtType,
			extensions: {
				grafast: {
					apply: method ? buildMethodApply(method) : applyDefault
				}
			}
		}

		function buildMethodApply(
			method: FilterMethod
		): InputObjectFieldApplyResolver<PgCondition> | undefined {
			const applyMethod = buildApplys[method]?.(attrName, attr)
			if(!applyMethod) {
				throw new Error(
					`No apply builder for filter type ${filter} and method ${method}`
				)
			}

			return (plan, args, info) => {
				const isSubscription = isSubscriptionPlan(plan)
				if(
					isSubscription
					&& !FILTER_METHODS_CONFIG[method].supportedOnSubscription
				) {
					return applyDefault(plan, args, info)
				}

				return applyMethod(plan, args, info)
			}
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
						const wherePlan = target.existsPlan({
							alias: 't',
							tableExpression: rmtRrscFrom,
						})

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

const passThroughApply: InputObjectFieldApplyResolver = s => s

export const FancyConditionsPlugin: GraphileConfig.Plugin = {
	name: 'FancyConditionsPlugin',
	version: '0.0.1',
	schema: {
		hooks: {
			build(build) {
				return build
					.extend(build, { inputConditionTypes: {} }, 'FancyConditionsPlugin')
			},
			'GraphQLInputObjectType_fields': hook,
		}
	}
}