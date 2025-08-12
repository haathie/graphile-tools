import { buildFieldNameToAttrNameMap, isSubscriptionPlan, mapFieldsToAttrs } from '@haathie/postgraphile-common-utils'
import type { PgCodecAttribute, PgCodecWithAttributes, PgCondition, PgResource } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputFieldConfig } from 'postgraphile/graphql'
import type { SQL, SQLRawValue } from 'postgraphile/pg-sql2'
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

type FilterTypeConfig = unknown

const DEFAULT_FILTER_METHOD: FilterMethod = 'plainSql'

export const init: Hook = (_, build) => {
	const {
		input: { pgRegistry: { pgResources } },
		inflection,
		registerInputObjectType,
		sql,
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
					{ conditionFilterType: filterType, pgCodec: attr.codec },
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
		const filterConfigs = getFilterConfigs(attr.extensions?.tags)

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
						const condType = buildConditionField(
							attrName, attr, filterType, method, filterConfigs[filterType]
						)
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
		config: FilterTypeConfig = { }
	): GraphQLInputFieldConfig {
		const { getType, applys } = FILTER_TYPES_MAP[filter]!
		const builtType
			= getType(attr.codec, getBuildGraphQlTypeByCodec(attr.codec, build), build)
		const fieldMap = buildFieldNameToAttrNameMap(attr.codec, inflection)

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
						config,
						serialiseToSql: () => serialiseToSql(args),
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

		function serialiseToSql(input: unknown): SQL | null {
			if(input === null || input === undefined) {
				return sql.null
			}

			// so if the input isn't a compound type, we can just return it
			// we'll assume it's a scalar value or an array of scalars
			if(!fieldMap) {
				return sql.value(input as SQLRawValue)
			}

			const mapped = mapFieldsToAttrs(input, fieldMap)
			const mainCodec = attr.codec.arrayOfCodec || attr.codec
			if(Array.isArray(mapped)) {
				return sql.value(mapped.map(v => mainCodec.toPg(v)))
			}

			return sql.value(mainCodec.toPg(mapped))
		}
	}
}

function getFilterConfigs(
	tags: Partial<GraphileBuild.PgCodecAttributeTags> | undefined
) {
	const filterConfigs: { [T in FilterType]?: FilterTypeConfig } = {}
	const configTag = typeof tags?.filterConfig === 'string' ? [tags.filterConfig] : tags?.filterConfig
	if(!configTag) {
		return filterConfigs
	}

	for(const configStr of configTag) {
		const colonIdx = configStr.indexOf(':')
		if(colonIdx === -1) {
			throw new Error(`Invalid filter config tag: ${configStr}`)
		}

		const filterType = configStr.slice(0, colonIdx) as FilterType
		const configJsonStr = configStr.slice(colonIdx + 1)
		try {
			const configJson = JSON.parse(configJsonStr) as FilterTypeConfig
			filterConfigs[filterType] = configJson
		} catch(e: any) {
			throw new Error(`Invalid JSON in filter config tag: ${configStr}, ${e.message}`)
		}
	}

	return filterConfigs
}