import { type PgCodecAttribute, type PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'
import { type InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import { type GraphQLInputFieldConfig, GraphQLInputObjectType, type GraphQLInputType } from 'postgraphile/graphql'
import { FILTER_TYPES_MAP, type FilterType } from './filters.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLInputObjectType_fields']

const hook: Hook = (fieldMap, build, ctx) => {
	const { behavior, inflection } = build
	const { scope: { pgCodec: _codec, isPgCondition } } = ctx
	if(!isPgCondition || !_codec?.extensions?.isTableLike) {
		return fieldMap
	}

	const pgCodec = _codec as PgCodecWithAttributes
	const typeName = build.getGraphQLTypeNameByPgCodec(pgCodec, 'output')
	const inputConditionTypes: { [key: string]: GraphQLInputType } = {}

	for(const attrName in pgCodec.attributes) {
		const applicableFilters: FilterType[] = []
		for(const _filterType in FILTER_TYPES_MAP) {
			const filterType = _filterType as FilterType
			if(
				behavior
					.pgCodecAttributeMatches([pgCodec, attrName], `filterType:${filterType}`)
			) {
				applicableFilters.push(filterType)
			}
		}

		if(!applicableFilters.length) {
			continue
		}

		const field = addConditionField(attrName, applicableFilters)
		if(!field) {
			continue
		}

		const fieldName = inflection
			.attribute({ attributeName: attrName, codec: pgCodec })
		fieldMap[fieldName] = field
	}

	return fieldMap

	function addConditionField(
		attrName: string, filters: FilterType[]
	): GraphQLInputFieldConfig | undefined {
		const attr = pgCodec.attributes[attrName]
		const { codec: attrCodec } = attr
		const graphQlType = build
			.getGraphQLTypeByPgCodec(attrCodec, 'input') as GraphQLInputType
		if(!graphQlType) {
			return
		}

		return {
			extensions: { grafast: { apply: passThroughApply } },
			type: new GraphQLInputObjectType({
				name: inflection.upperCamelCase(`${typeName}_${attrName}_condition`),
				description: `Conditions for filtering by ${attrName}`,
				isOneOf: true,
				fields: filters.reduce((fields, filterType) => {
					const condType
						= buildConditionField(attrName, attr, filterType, graphQlType)
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
		graphQlType: GraphQLInputType
	): GraphQLInputFieldConfig {
		const { buildType, buildApply } = FILTER_TYPES_MAP[filter]
		let builtType = buildType(graphQlType, inflection)
		if('name' in builtType && inputConditionTypes[builtType.name]) {
			// If the type is already built, reuse it
			builtType = inputConditionTypes[builtType.name]
		}

		return {
			type: builtType,
			extensions: {	grafast: { apply: buildApply(attrName, attr) } }
		}
	}
}

const passThroughApply: InputObjectFieldApplyResolver = s => s

export const FancyConditionsPlugin: GraphileConfig.Plugin = {
	name: 'FancyConditionsPlugin',
	version: '0.0.1',
	schema: {
		hooks: {
			'GraphQLInputObjectType_fields': hook
		}
	}
}