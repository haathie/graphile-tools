import { type PgCodecAttribute, PgCondition } from 'postgraphile/@dataplan/pg'
import { type InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import { GraphQLInputObjectType, type GraphQLInputType, GraphQLList } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'

export type FilterType = 'eq'
	| 'eqIn'
	| 'range'

type FilterTypeImpl = {
	buildType: (
		fieldType: GraphQLInputType,
		inflection: GraphileBuild.Inflection
	) => GraphQLInputType
	buildApply: (
		attrName: string,
		attr: PgCodecAttribute
	) => InputObjectFieldApplyResolver<PgCondition>
}

declare global {
	namespace GraphileBuild {
		interface BehaviorStrings
			extends Record<`filterType:${FilterType}`, true> {}
	}
}

export const FILTER_TYPES_MAP: { [K in FilterType]: FilterTypeImpl } = {
	'eq': {
		buildType: fieldType => fieldType,
		buildApply(attrName, attr) {
			return (cond, input) => (
				cond.where(
					input === null
						? sql`${cond.alias}.${sql.identifier(attrName)} IS NULL`
						: sql`${cond.alias}.${sql.identifier(attrName)}
							= ${sql.value(input)}::${attr.codec.sqlType}`
				)
			)
		}
	},
	'eqIn': {
		buildType: fieldType => new GraphQLList(fieldType),
		buildApply(attrName, attr) {
			return (cond, input) => {
				const whereClause = sql`${cond.alias}.${sql.identifier(attrName)} IN (
					SELECT * FROM unnest(${sql.value(input)}::${attr.codec.sqlType}[])
				)`
				const hasNull = input.includes(null)
				if(!hasNull) {
					return cond.where(whereClause)
				}

				return cond.where(
					sql`(${whereClause} OR ${cond.alias}.${sql.identifier(attrName)} IS NULL)`
				)
			}
		}
	},
	'range': {
		buildType: (fieldType, inflection) => {
			if(!('name' in fieldType)) {
				throw new Error(
					'Cannot build range condition type without a name in fieldType.'
				)
			}

			return new GraphQLInputObjectType({
				name: inflection.upperCamelCase(
					`${fieldType.name}_range_condition`
				),
				description: 'Conditions for filtering by range',
				fields: {
					from: { type: fieldType },
					to: { type: fieldType }
				}
			})
		},
		buildApply(attrName, attr) {
			return (cond, { from, to }) => {
				if(from !== undefined) {
					cond.where(
						sql`${cond.alias}.${sql.identifier(attrName)} >= ${sql.value(from)}::${attr.codec.sqlType}`
					)
				}

				if(to !== undefined) {
					cond.where(
						sql`${cond.alias}.${sql.identifier(attrName)} <= ${sql.value(to)}::${attr.codec.sqlType}`
					)
				}
			}
		}
	}
}