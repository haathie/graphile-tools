import { GraphQLList, GraphQLNonNull, GraphQLScalarType } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'
import type { FilterImplementation, FilterMethod, FilterMethodConfig, FilterType } from './types.ts'

export const FILTER_METHODS_CONFIG: { [K in FilterMethod]: FilterMethodConfig } = {
	'paradedb': {
		supportedOnSubscription: false
	}
}

export const FILTER_METHODS = Object.keys(FILTER_METHODS_CONFIG) as FilterMethod[]

export const FILTER_TYPES_MAP: { [K in FilterType]: FilterImplementation } = {
	'eq': {
		getType(codec, getGraphQlType) {
			// for eq -- we just return the field type
			return getGraphQlType()
		},
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

					return cond
						.where(sql`${id} = ${sql.value(input)}::${codec.sqlType}`)
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
		getType(codec, getGraphQlType) {
			return new GraphQLList(getGraphQlType())
		},
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

					return cond.where(sql`(${whereClause} OR ${id} IS NULL)`)
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
		getRegisterTypeInfo(fieldCodec, getGraphQlType, { inflection }) {
			return {
				name: inflection.rangeConditionTypeName(fieldCodec),
				spec: () => ({
					description: 'Filter values falling in a range',
					fields() {
						const fieldType = getGraphQlType()
						if(!('name' in fieldType)) {
							throw new Error('Cannot build range condition on a non-named type')
						}

						return {
							from: { type: fieldType },
							to: { type: fieldType }
						}
					}
				}),
			}
		},
		getType(fieldCodec, _, { inflection, getInputTypeByName }) {
			return getInputTypeByName(inflection.rangeConditionTypeName(fieldCodec))
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
		getType(fieldCodec, getGraphQlType) {
			let fieldType = getGraphQlType()
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
					if(attr.codec.arrayOfCodec) {
						return cond.where(
							sql`EXISTS (
								SELECT 1 FROM unnest(${id}) AS elem 
								WHERE elem ILIKE ${sql.value(`%${input}%`)}
							)`
						)
					}

					return cond.where(sql`${id} ILIKE ${sql.value(`%${input}%`)}`)
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