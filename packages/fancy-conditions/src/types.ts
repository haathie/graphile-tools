import type {} from 'postgraphile'
import type { PgCodec, PgCodecAttribute, PgCondition, PgResource } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputType } from 'postgraphile/graphql'

export type FilterType = 'eq'
	| 'eqIn'
	| 'range'
	| 'icontains'

/**
 * Method used to apply filters -- useful for different index types like
 * GIN, paradedb, zombodb, etc.
 */
export type FilterMethod = 'paradedb'

type ApplyBuilder = (
	attrName: string,
	attr: PgCodecAttribute
) => InputObjectFieldApplyResolver<PgCondition>

export type FilterImplementation = {
	description?: string
	/**
	 * Register the type used to filter the attribute.
	 */
	getRegisterTypeInfo?(
		fieldCodec: PgCodec,
		getGraphQlType: () => GraphQLInputType,
		build: GraphileBuild.Build
	): {
		name: string
		spec: () => Omit<GraphileBuild.GrafastInputObjectTypeConfig, 'name'>
	}
	getType(
		fieldCodec: PgCodec,
		getGraphQlType: () => GraphQLInputType,
		build: GraphileBuild.Build
	): GraphQLInputType
	buildApplys: {
		default: ApplyBuilder
	} & { [M in FilterMethod]?: ApplyBuilder }
}

interface FilterBehaviours extends
	Record<`filterType:${FilterType}`, true>,
	Record<`filterMethod:${FilterMethod}`, true> {
	'filterable': true
}

declare global {
	namespace GraphileBuild {
		interface BehaviorStrings	extends FilterBehaviours {}

		interface Inflection {
			conditionContainerTypeName(
				resource: PgResource,
				attrName: string
			): string
			rangeConditionTypeName(codec: PgCodec): string
		}

		interface ScopeInputObject {
			conditionFilterType?: FilterType
			isConditionContainer?: boolean
		}

		interface ScopeInputObjectFieldsField {
			isConditionContainer?: boolean
		}
	}
}

export type FilterMethodConfig = {
	description?: string
	supportedOnSubscription: boolean
}

declare global {
	namespace GraphileBuild {
		interface Build {
			inputConditionTypes: { [key: string]: GraphQLInputType }
		}
	}
}