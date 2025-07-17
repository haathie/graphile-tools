import { PgResource, PgSelectStep } from 'postgraphile/@dataplan/pg'
import { sql } from 'postgraphile/pg-sql2'

/**
 * @typedef {import('postgraphile/pg-sql2').SQL} SQL
 */

/**
 * Selects some rows from a resource and then modifies them.
 */
export class PgSelectAndModify extends PgSelectStep {

	/**
	 * @type {'delete' | 'update'}
	 */
	#modificationType
	/**
	 * @type {Record<string, SQL>}
	 */
	#attrsToSet = {}
	/**
	 * @param {import('postgraphile/@dataplan/pg').PgSelectOptions} opts
	 */
	constructor(opts) {
		super({
			...opts,
			resource: new CustomisablePgResource(opts.resource, this.#buildModifiedSql.bind(this)),
			mode: 'mutation'
		})
	}

	/**
	 * @param {string} text
	 * @param {any[]} params
	 */
	#buildModifiedSql(text, params) {
		const resourceFrom = this.resource.from
		const compiledFrom = sql.compile(resourceFrom).text
		const primaryUnique = this.resource.uniques.find(u => u.isPrimary)
		if(!primaryUnique) {
			throw new Error(
				`Cannot delete/update from ${this.resource.name} without a primary key`
			)
		}

		if(this.#modificationType === 'delete') {
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
			const whereMatch = primaryUqIdxs.map(([attr, idx]) => (
				`selections."${idx}" = t."${attr}"`
			)).join(' AND ')
			return `
				WITH selections AS (${text}),
				modifications AS (
					DELETE FROM ${compiledFrom} AS t
					USING selections
					WHERE ${whereMatch}
				)
				SELECT * FROM selections
				`
		}

		const attrsEntries = Object.entries(this.#attrsToSet)
		const updates = attrsEntries
			.map(([name, value]) => {
				params.push(value)
				return `"${name}" = $${params.length}`
			})
			.join(', ')

		const compiledAlias = sql.compile(this.alias).text
		const whereIdx = text.indexOf('where ')
		const selectionsTxt = `SELECT * FROM ${compiledFrom} AS ${compiledAlias}
		${whereIdx > 0 ? text.slice(whereIdx) : ''}
		`
		const whereMatch = primaryUnique.attributes
			.map(attr => `t."${attr}" = selections."${attr}"`)
			.join(' AND ')

		const finalSelect = text
			.slice(0, whereIdx > 0 ? whereIdx : text.length)
			.replace(`from ${compiledFrom}`, 'from updated')

		const txt = `
		WITH selections AS (
			${selectionsTxt}
		),
		updated AS (
			UPDATE ${compiledFrom} AS t
			SET ${updates}
			FROM selections
			WHERE ${whereMatch}
			RETURNING t.*
		)
		${finalSelect}
		`

		return { text: txt, params }
	}

	delete() {
		if(this.#modificationType === 'update') {
			throw new Error('Cannot delete on an update operation')
		}

		this.#modificationType = 'delete'
	}

	update() {
		if(this.#modificationType === 'delete') {
			throw new Error('Cannot update on a delete operation')
		}

		this.#modificationType = 'update'
	}

	/**
	 * @param {string} name
	 * @param {import('postgraphile/grafast').Step} value
	 */
	set(name, value) {
		this.update()
		this.#attrsToSet[name] = value
	}
}

class CustomisablePgResource extends PgResource {

	/**
	 * @param {PgResource} resource
	 * @param {(text: string, params: any[]) => ({ text: string, params: any[] })} modifySql
	 */
	constructor(resource, modifySql) {
		super(
			resource.registry,
			{
				'codec': resource.codec,
				executor: resource.executor,
				name: resource.name,
				identifier: resource.identifier,
				from: resource.from,
				uniques: resource.uniques,
				extensions: resource.extensions,
				parameters: resource.parameters,
				description: resource.description,
				isUnique: resource.isUnique,
				sqlPartitionByIndex: resource.sqlPartitionByIndex,
				isMutation: resource.isMutation,
				hasImplicitOrder: resource.hasImplicitOrder,
				isList: resource.isList,
				isVirtual: resource.isVirtual,
			}
		)

		this.modifySql = modifySql
	}

	execute(ctx, args) {
		args.text = args.text.trim()
		if(args.text.endsWith(';')) {
			args.text = args.text.slice(0, -1)
		}

		const { text, params } = this.modifySql(args.text, args.rawSqlValues)
		args.text = text
		args.rawSqlValues = params

		return super.executeWithoutCache(ctx, args)
	}
}