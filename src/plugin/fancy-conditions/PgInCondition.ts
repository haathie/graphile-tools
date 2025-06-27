import { PgCondition, type PgConditionCapableParent, type PgWhereConditionSpec } from 'postgraphile/@dataplan/pg'
import { Modifier } from 'postgraphile/grafast'
import { type SQL, sql } from 'postgraphile/pg-sql2'

type PgInConditionOpts = {
	subTable: SQL
	subTableMatchCols: string[]
	matchCols: string[]
}

export class PgInCondition<T extends PgConditionCapableParent> extends Modifier<T> implements PgConditionCapableParent {

	alias = sql`t`
	opts: PgInConditionOpts
	cond: SQL | undefined

	constructor(
		parent: T,
		opts: PgInConditionOpts
	) {
		super(parent)
		this.opts = opts
	}

	where(condition: PgWhereConditionSpec<any>): void {
		if(!sql.isSQL(condition)) {
			throw new Error('Condition must be a SQL expression')
		}

		if(this.cond) {
			throw new Error('Where condition already set')
		}

		this.cond = condition
	}

	whereBuilder() {
		return new PgCondition(this, false, 'AND')
	}

	apply(): void {
		const { subTable, subTableMatchCols, matchCols } = this.opts
		const localAttrsSql = sql.join(
			matchCols.map((attr) => {
				return sql`${this.parent.alias}.${sql.identifier(attr)}`
			}),
			','
		)
		const subTableSql = sql.join(
			subTableMatchCols.map((attr) => {
				return sql`${this.alias}.${sql.identifier(attr)}`
			}),
			','
		)

		this.parent.where(
			sql`(${localAttrsSql}) IN (
				SELECT (${subTableSql}) FROM ${subTable} AS ${this.alias}
				${this.cond ? sql`WHERE ${this.cond}` : sql``}
			)`
		)
	}
}