import { isSubscriptionPlan } from '@haathie/postgraphile-common-utils'
import type { PgCodecAttribute, PgCodecWithAttributes, PgCondition, PgResource } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputFieldConfig } from 'postgraphile/graphql'
import { FILTER_METHODS, FILTER_METHODS_CONFIG, FILTER_TYPES_MAP } from './filters.ts'
import type { FilterMethod, FilterType } from './types.ts'
import { getBuildGraphQlTypeByCodec, getFilterTypesForAttribute } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['init']

type FilterInfo = {
	types: FilterType[]
	method: FilterMethod | undefined
}

export const init: Hook = (_, build) => {
	const {
		behavior,
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
				method: FILTER_METHODS.find(m => (
					behavior.pgCodecAttributeMatches([codec, attrName], `filterMethod:${m}`)
				))
			}
			for(
				const filterType of getFilterTypesForAttribute(codec, attrName, build)
			) {
				info.types.push(filterType)

				const { getRegisterTypeInfo } = FILTER_TYPES_MAP[filterType]
				if(!getRegisterTypeInfo) {
					continue
				}

				const { name, spec } = getRegisterTypeInfo(
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
		method: FilterMethod | undefined,
	): GraphQLInputFieldConfig {
		const { getType, buildApplys } = FILTER_TYPES_MAP[filter]
		const builtType = getType(
			attr.codec, getBuildGraphQlTypeByCodec(attr.codec, build), build
		)
		// if('name' in builtType) {
		// 	if(inputConditionTypes[builtType.name]) {
		// 		// If the type is already built, reuse it
		// 		builtType = inputConditionTypes[builtType.name]
		// 	} else {
		// 		inputConditionTypes[builtType.name] = builtType
		// 	}
		// }

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
					`INTERNAL: No apply builder for type "${filter}" and method "${method}"`
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
}