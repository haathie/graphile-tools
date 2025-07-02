import { type PgCodecAttribute, PgCondition } from 'postgraphile/@dataplan/pg'
import { type InputObjectFieldApplyResolver } from 'postgraphile/grafast'
import { GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull, GraphQLScalarType } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'

export type FilterType = 'eq'
	| 'eqIn'
	| 'range'
	| 'icontains'

export type FilterMethod = typeof FILTER_METHODS[number]

type ApplyBuilder = (
	attrName: string,
	attr: PgCodecAttribute
) => InputObjectFieldApplyResolver<PgCondition>

type FilterTypeImpl = {
	buildType: (
		fieldType: GraphQLInputType,
		inflection: GraphileBuild.Inflection
	) => GraphQLInputType
	buildApplys: {
		default: ApplyBuilder
	} & { [M in FilterMethod]?: ApplyBuilder }
}

interface FilterBehaviours extends
	Record<`filterType:${FilterType}`, true>,
	Record<`filterMethod:${FilterMethod}`, true> {
	'searchable': true
}

declare global {
	namespace GraphileBuild {
		interface BehaviorStrings	extends FilterBehaviours {}
	}
}

export const FILTER_METHODS = [
	'paradedb'
] as const

export const FILTER_TYPES_MAP: { [K in FilterType]: FilterTypeImpl } = {
	'eq': {
		buildType: fieldType => fieldType,
		buildApplys: {
			default(attrName, attr) {
				return (cond, input) => {
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					const codec = attr.codec.arrayOfCodec || attr.codec
					if(input === null) {
						return cond.where(sql`${id} IS NULL`)
					}

					if(attr.codec.arrayOfCodec) {
						// If the attribute is an array, we need to check for equality
						return cond.where(
							sql`${sql.value(input)}::${codec.sqlType} = ANY(${id})`
						)
					}

					return cond.where(
						sql`${id} = ${sql.value(input)}::${codec.sqlType}`
					)
				}
			},
			paradedb(attrName, attr) {
				return (cond, input) => {
					const codec = attr.codec.arrayOfCodec || attr.codec
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					if(input === null) {
						return cond.where(sql`NOT ${id} @@@ paradedb.exists(${sql.literal(attrName)})`)
					}

					return cond.where(
						sql`${id} @@@ paradedb.term(${sql.literal(attrName)}, ${sql.value(input)}::${codec.sqlType})`
					)
				}
			}
		}
	},
	'eqIn': {
		buildType: fieldType => new GraphQLList(fieldType),
		buildApplys: {
			default(attrName, attr) {
				return (cond, input) => {
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					const codec = attr.codec.arrayOfCodec || attr.codec
					const whereClause = attr.codec.arrayOfCodec
						? sql`${id} && ${sql.value(input)}::${codec.sqlType}[] -- TRUE`
						: sql`${id} IN (
							SELECT * FROM unnest(${sql.value(input)}::${codec.sqlType}[])
						)`

					const hasNull = input.includes(null)
					if(!hasNull) {
						return cond.where(whereClause)
					}

					return cond.where(
						sql`(${whereClause} OR ${id} IS NULL)`
					)
				}
			},
			paradedb(attrName, attr) {
				return (cond, input) => {
					const codec = attr.codec.arrayOfCodec || attr.codec
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					const whereClause = sql`${id} @@@ paradedb.term_set(
						(SELECT ARRAY_AGG(paradedb.term(${sql.literal(attrName)}, value))
						FROM unnest(${sql.value(input)}::${codec.sqlType}[]) value)
					)`

					const hasNull = input.includes(null)
					if(!hasNull) {
						return cond.where(whereClause)
					}

					return cond.where(sql`(
						${whereClause}
						OR NOT ${id} @@@ paradedb.exists(${sql.literal(attrName)})
					)`)
				}
			}
		}
	},
	'range': {
		buildType: (fieldType, inflection) => {
			if(!('name' in fieldType)) {
				throw new Error('Cannot build range condition on a non-named type')
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
		buildApplys: {
			default(attrName, attr) {
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
			},
			paradedb(attrName, attr) {
				return (cond, { from, to }) => {
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					const { sqlType } = attr.codec.arrayOfCodec || attr.codec
					const fromSql = from
						? sql`jsonb_build_object('included', ${sql.value(from)}::${sqlType})`
						: sql.null
					const toSql = to
						? sql`jsonb_build_object('excluded', ${sql.value(to)}::${sqlType})`
						: sql.null
					cond.where(sql`${id} @@@ 
						jsonb_build_object(
							'range',
							jsonb_build_object(
								'field', ${sql.literal(attrName)}, 
								'lower_bound', ${fromSql},
								'upper_bound', ${toSql}
							)
						)	
					`)
				}
			}
		}
	},
	'icontains': {
		buildType: fieldType => {
			fieldType = fieldType instanceof GraphQLNonNull
				? fieldType.ofType
				: fieldType
			if(!(fieldType instanceof GraphQLScalarType)) {
				throw new Error('Cannot build contains condition on a non-scalar type')
			}

			return fieldType
		},
		buildApplys: {
			default(attrName, attr) {
				return (cond, input) => {
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					const codec = attr.codec.arrayOfCodec || attr.codec
					if(attr.codec.arrayOfCodec) {
						throw new Error('TODO')
					}

					return cond.where(
						sql`${id} ILIKE ${sql.value(`%${input}%`)}::${codec.sqlType}`
					)
				}
			},
			paradedb(attrName) {
				return (cond, input) => {
					const id = sql`${cond.alias}.${sql.identifier(attrName)}`
					return cond.where(sql`${id} @@@ ${sql.value(`"${input}"`)}`)
				}
			}
		}
	}
}