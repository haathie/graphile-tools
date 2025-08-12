import { sql } from 'postgraphile/pg-sql2'
import { registerFilterMethod } from './declaration.ts'

declare global {
	namespace GraphileBuild {
		interface FilterMethodMap {
			plainSql: true
		}
	}
}

registerFilterMethod(
	'plainSql',
	{ supportedOnSubscription: true },
	{
		eq: (cond, input, { scope: { attrName, attr, serialiseToSql } }) => {
			const id = sql`${cond.alias}.${sql.identifier(attrName)}`
			const codec = attr.codec.arrayOfCodec || attr.codec
			if(input === null) {
				return cond.where(sql`${id} IS NULL`)
			}

			if(attr.codec.arrayOfCodec) {
				// If the attribute is an array, we need to check for equality
				return cond
					.where(sql`${serialiseToSql()}::${codec.sqlType} = ANY(${id})`)
			}

			return cond.where(sql`${id} = ${serialiseToSql()}::${codec.sqlType}`)
		},
		eqIn: (cond, input, { scope: { attrName, attr, serialiseToSql } }) => {
			const id = sql`${cond.alias}.${sql.identifier(attrName)}`
			const codec = attr.codec.arrayOfCodec || attr.codec
			const whereClause = attr.codec.arrayOfCodec
				? sql`${id} && ${serialiseToSql()}::${codec.sqlType}[] -- TRUE`
				: sql`${id} IN (
					SELECT arr FROM unnest(${serialiseToSql()}::${codec.sqlType}[]) arr
				)`

			const hasNull = Array.isArray(input) && input.includes(null)
			if(!hasNull) {
				return cond.where(whereClause)
			}

			return cond.where(sql`(${whereClause} OR ${id} IS NULL)`)
		},
		range: (cond, { from, to }, { scope: { attrName, attr } }) => {
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
		},
		'icontains': (cond, input, { scope: { attr, attrName } }) => {
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
)