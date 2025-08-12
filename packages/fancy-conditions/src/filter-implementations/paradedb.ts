import { sql } from 'postgraphile/pg-sql2'
import { registerFilterMethod } from './declaration.ts'

declare global {
	namespace GraphileBuild {
		interface FilterMethodMap {
			paradedb: true
		}
	}
}

registerFilterMethod<{ fieldName: string }>(
	'paradedb',
	{ supportedOnSubscription: false },
	{
		'eq': (cond, input, { scope: { attrName, attr } }) => {
			const codec = attr.codec.arrayOfCodec || attr.codec
			const id = sql`${cond.alias}.${sql.identifier(attrName)}`
			if(input === null) {
				return cond.where(sql`NOT ${id} @@@ paradedb.exists(${sql.literal(attrName)})`)
			}

			return cond.where(
				sql`${id} @@@ paradedb.term(${sql.literal(attrName)}, ${sql.value(input)}::${codec.sqlType})`
			)
		},
		'eqIn': (cond, input, { scope: { attr, attrName } }) => {
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
		},
		'range': (cond, { from, to }, { scope: { attr, attrName } }) => {
			const id = sql`${cond.alias}.${sql.identifier(attrName)}`
			const { sqlType } = attr.codec.arrayOfCodec || attr.codec
			const fromSql = from
				? sql`jsonb_build_object('included', ${sql.value(from)}::${sqlType})`
				: sql.null
			const toSql = to
				? sql`jsonb_build_object('included', ${sql.value(to)}::${sqlType})`
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
		},
		'icontains': (cond, input, { scope: { attrName, config } }) => {
			const fieldName = config?.fieldName || attrName
			const id = sql`${cond.alias}.${sql.identifier(attrName)}`
			return cond.where(
				sql`${id} @@@ paradedb.parse(${sql.value(`${fieldName}:"${input}"`)})`
			)
		}
	}
)