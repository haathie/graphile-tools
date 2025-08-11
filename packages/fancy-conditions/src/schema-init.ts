import { isSubscriptionPlan } from '@haathie/postgraphile-common-utils'
import type { PgCodecAttribute, PgCodecWithAttributes, PgCondition, PgResource } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputFieldConfig } from 'postgraphile/graphql'
import { FILTER_METHODS_CONFIG, FILTER_TYPES_MAP } from './filter-implementations/index.ts'
import type { FilterMethod, FilterType } from './types.ts'
import { getBuildGraphQlTypeByCodec, getFilterMethodsForAttribute, getFilterTypesForAttribute } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['init']

type FilterInfo = {
	types: FilterType[]
	method: FilterMethod | undefined
}

const DEFAULT_FILTER_METHOD: FilterMethod = 'plainSql'

export const init: Hook = (_, build) => {
	const {
		input: { pgRegistry: { pgResources } },
		inflection,
		registerInputObjectType
	} = build
	const registeredTypes = new Set<string>()

	for(const resource of Object.values(pgResources)) {
		const codec = resource.codec as PgCodecWithAttributes
		if(!codec.extensions?.isTableLike) {
			continue
		}

		for(const [attrName, attr] of Object.entries(resource.codec.attributes)) {
			const info: FilterInfo = {
				types: [],
				method: getFilterMethodsForAttribute(codec, attrName, build)
					.next().value || undefined
			}
			for(
				const filterType of getFilterTypesForAttribute(codec, attrName, build)
			) {
				info.types.push(filterType)

				const filterInfo = FILTER_TYPES_MAP[filterType]
				if(!filterInfo) {
					throw new Error(
						`INTERNAL: Filter type "${filterType}" is not registered.`
						+ ' Please register it before using `registerFilterImplementations`'
					)
				}

				if(!filterInfo.getRegisterTypeInfo) {
					continue
				}

				const { name, spec } = filterInfo.getRegisterTypeInfo(
					attr.codec,
					getBuildGraphQlTypeByCodec(attr.codec, build),
					build
				)
				if(registeredTypes.has(name)) {
					continue
				}

				registerInputObjectType(
					name,
					{
						conditionFilterType: filterType,
						pgCodec: attr.codec,
					},
					spec,
					`${attr.codec.name}_${filterType}_condition`
				)
				registeredTypes.add(name)
			}

			registerConditionType(resource, attrName, info)
		}
	}

	return _

	function registerConditionType(
		pgResource: PgResource,
		attrName: string,
		{ types: filterTypes, method }: FilterInfo
	) {
		const attr = pgResource.codec.attributes![attrName]

		const typeName = inflection._resourceName(pgResource)
		registerInputObjectType(
			inflection.conditionContainerTypeName(pgResource, attrName),
			{
				isConditionContainer: true,
				pgResource,
				pgAttribute: attr,
			},
			() => ({
				description: `Conditions for filtering by ${typeName}'s ${attrName}`,
				isOneOf: true,
				fields() {
					return filterTypes.reduce((fields, filterType) => {
						const condType
							= buildConditionField(attrName, attr, filterType, method)
						fields[filterType] = condType
						return fields
					}, { } as Record<string, GraphQLInputFieldConfig>)
				}
			}),
			`${pgResource.name}_${attrName}_condition_container`
		)
	}

	function buildConditionField(
		attrName: string,
		attr: PgCodecAttribute,
		filter: FilterType,
		method: FilterMethod = DEFAULT_FILTER_METHOD,
	): GraphQLInputFieldConfig {
		const { getType, applys } = FILTER_TYPES_MAP[filter]!
		const builtType
			= getType(attr.codec, getBuildGraphQlTypeByCodec(attr.codec, build), build)

		const applyMethod = applys?.[method]!
		if(!applyMethod) {
			throw new Error(
				`No apply fn available for filter type ${filter} and method ${method}.`
			)
		}

		const applyDefault = applys?.[DEFAULT_FILTER_METHOD]!
		return {
			type: builtType,
			extensions: {
				grafast: {
					apply: buildMethodApply(method)
				}
			}
		}

		function buildMethodApply(
			method: FilterMethod
		): InputObjectFieldApplyResolver<PgCondition> | undefined {
			return (plan, args, info) => {
				const newInfo = {
					...info,
					scope: {
						...info.scope,
						attrName: attrName,
						attr: attr,
					}
				}
				const isSubscription = isSubscriptionPlan(plan)
				if(
					isSubscription
					&& !FILTER_METHODS_CONFIG[method]?.supportedOnSubscription
				) {
					if(!applyDefault) {
						throw new Error(
							`Filter method "${method}" is not supported on subscriptions.`
						)
					}

					return applyDefault(plan, args, newInfo)
				}

				return applyMethod(plan, args, newInfo)
			}
		}
	}
}