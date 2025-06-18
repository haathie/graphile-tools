import { PgSelectStep } from 'postgraphile/@dataplan/pg'
import { sql } from 'postgraphile/pg-sql2'

/**
 * @typedef {import('postgraphile/pg-sql2').SQL} SQL
 * @typedef {(whereMatch: SQL, resourceFrom: SQL) => SQL} ModificationFunction
 */

/**
 * Selects some rows from a resource and then modifies them.
 */
export class PgSelectAndModify extends PgSelectStep {

	/**
	 * The function that will be used to perform the modification.
	 * @type {ModificationFunction}
	 */
	modification
	/**
	 * @param {import('postgraphile/@dataplan/pg').PgSelectOptions} opts
	 */
	constructor(opts) {
		super({ ...opts, mode: 'mutation' })
	}

	execute(...args) {
		if(!this.modification) {
			return super.execute(...args)
		}

		const primaryUnique = this.resource.uniques.find(u => u.isPrimary)
		if(!primaryUnique) {
			throw new Error(`Cannot delete from ${this.resource.name} without a primary key`)
		}

		// ensure primary key attributes are selected -- as they'll be
		// used to identify the rows to modify
		const primaryUqIdxs = primaryUnique.attributes.map(attr => (
			[
				attr,
				this.selectAndReturnIndex(
					sql.join([this.alias, sql.identifier(attr)], '.')
				)
			]
		))
		const resourceFrom = this.resource.from
		const selectionsId = sql.identifier('selections')
		const whereMatch = sql.join(
			primaryUqIdxs.map(([attr, idx]) => (
				sql`${selectionsId}.${sql.identifier(idx.toString())} = t.${sql.identifier(attr)}`)
			),
			' AND '
		)

		const modSql = this.modification(whereMatch, resourceFrom)
		const { text: modTxt } = sql.compile(modSql)
		const ogExecuteWithout = this.resource['executeWithoutCache']
		this.resource['executeWithoutCache'] = (ctx, args) => {
			args.text = args.text.trim()
			if(args.text.endsWith(';')) {
				args.text = args.text.slice(0, -1)
			}

			args.text = `
				WITH selections AS (${args.text}),
				modifications AS (${modTxt})
				SELECT * FROM selections
				`

			return ogExecuteWithout.call(this.resource, ctx, args).finally(() => (
				this.resource['executeWithoutCache'] = ogExecuteWithout
			))
		}

		return super.execute(...args)
	}
}