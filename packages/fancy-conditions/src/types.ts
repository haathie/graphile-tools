import type {} from 'postgraphile'
import type { PgCodec, PgCodecAttribute, PgCondition, PgResource } from 'postgraphile/@dataplan/pg'
import type { InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import type { GraphQLInputType } from 'postgraphile/graphql'

export type FilterType = keyof GraphileBuild.FilterTypeMap

export type FilterMethod = keyof GraphileBuild.FilterMethodMap

export type FilterApply<T = unknown> = InputObjectFieldApplyResolver<PgCondition, any, {
	attrName: string
	attr: PgCodecAttribute
	config?: T
}>

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
	applys?: { [M in FilterMethod]?: FilterApply }
}

export type FilterMethodConfig = {
	description?: string
	supportedOnSubscription: boolean
}

interface FilterBehaviours extends
	Record<`filterType:${FilterType}`, true>,
	Record<`filterMethod:${FilterMethod}`, true> {
	'filterable': true
}

declare global {

	namespace GraphileBuild {

		interface FilterTypeMap {
			eq: true
			eqIn: true
			range: true
			icontains: true
		}

		/**
		 * Method used to apply filters -- useful for different index types like
		 * GIN, paradedb, zombodb, etc.
		 */
		interface FilterMethodMap {
		}

		interface FilterTypeMap {
			eq: true
			eqIn: true
			range: true
			icontains: true
		}

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

		interface PgCodecAttributeTags {
			filterConfig?: string[]
		}
	}
}