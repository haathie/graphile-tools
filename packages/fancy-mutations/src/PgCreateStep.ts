import type { NodePostgresPgClient } from 'postgraphile/adaptors/pg'
import { context, type ExecutionDetails, type ExecutionResults, type Maybe, Modifier, Step } from 'postgraphile/grafast'
import { GraphQLError } from 'postgraphile/graphql'
import { insertData } from './pg-utils.ts'
import type { OnConflictOption, PgTableResource } from './types.ts'
import { getEntityCtx } from './utils.ts'

type PgCreateCallback = (pgCreate: PgCreateStep) => void

type PlainObject = { [_: string]: unknown }

type RowValue<T> = { constant: T }
	| {
		dependency: PgRowBuilder
		key: string
	}

const MAX_BULK_MUTATION_LENGTH = 1000

export class PgCreateStep extends Step<{ items: PlainObject[] }> {

	readonly resource: PgTableResource
	readonly #contextId: number
	readonly #onConflictId: number
	readonly #argsDepIds: number[] = []
	pendingRowMap: { [rscName: string]: PgRowBuilder[] } = {}
	selectPrimaryColumns = false

	constructor(
		resource: PgTableResource,
		onConflict: Step<OnConflictOption>
	) {
		super()
		this.resource = resource
		this.#onConflictId = this.addUnaryDependency(onConflict)
		this.#contextId = this.addUnaryDependency(context())
		this.isSyncAndSafe = false
	}

	apply($step: Step<Maybe<PgCreateCallback | ReadonlyArray<PgCreateCallback>>>) {
		this.#argsDepIds.push(this.addDependency($step))
	}

	execute({
		indexMap,
		values
	}: ExecutionDetails): ExecutionResults<{ items: PlainObject[] }> {
		const onConflict = values[this.#onConflictId]
			.unaryValue() as OnConflictOption
		const {
			withPgClient,
			pgSettings
		} = values[this.#contextId].unaryValue() as Grafast.Context

		return indexMap(async i => {
			this.pendingRowMap = {}

			for(const applyDepId of this.#argsDepIds) {
				const callback = values[applyDepId].at(i)
				if(Array.isArray(callback)) {
					for(const cb of callback) {
						cb(this)
					}
				} else if(callback !== null) {
					callback(this)
				}

				console.log('applyDepId', applyDepId, 'callback', callback)
			}

			const rootMutsLength = Object.keys(this.pendingRowMap).length
			if(!rootMutsLength) {
				throw new GraphQLError('Must have at least 1 mutation')
			}

			if(rootMutsLength > MAX_BULK_MUTATION_LENGTH) {
				throw new GraphQLError(
					`Must have at most ${MAX_BULK_MUTATION_LENGTH} mutations`
				)
			}

			const resolvedRowMap = await withPgClient(pgSettings, async pgClient => {
				await pgClient.query({ text: 'BEGIN' })
				try {
					const rslt = await this.#execute(pgClient, onConflict)
					await pgClient.query({ text: 'COMMIT' })
					return rslt
				} catch(err) {
					await pgClient.query({ text: 'ROLLBACK' })
					throw err
				}
			})

			return {
				items: resolvedRowMap[this.resource.name]
					.map(rb => rb.plainObject())
			}
		})
	}

	addRowBuilder(): PgRowBuilder {
		return new PgRowBuilder(this)
	}

	async #execute(client: NodePostgresPgClient, onConflict: OnConflictOption) {
		const resolvedRowMap: { [rscName: string]: PgRowBuilder[] } = {}

		let builders: { [rscName: string]: PgRowBuilder[] } | undefined
		while(builders = this.#getDependencyFreeRowBuilders()) {
			for(const [rscName, pendingRows] of Object.entries(builders)) {
				const rsc = this.resource.registry
					.pgResources[rscName] as PgTableResource
				const ctx = getEntityCtx(rsc)

				let _onConflict = onConflict
				if(_onConflict === 'replace' && !rsc.extensions?.canUpdate) {
					_onConflict = 'ignore'
				}

				const colsToReturn = new Set<string>()
				if(this.selectPrimaryColumns && rsc === this.resource) {
					for(const attr of ctx.idProperties) {
						colsToReturn.add(attr)
					}
				}

				const values: PlainObject[] = []
				for(const rb of pendingRows) {
					values.push(rb.plainObject())
					for(const key of rb.getDependents()) {
						colsToReturn.add(key)
					}
				}

				const {
					rows,
					rowCount,
				} = await insertData<{ [_: string]: unknown }>(
					values,
					client.rawClient,
					_onConflict === 'error' ? undefined : { type: _onConflict },
					Array.from(colsToReturn),
					ctx
				)

				if(rowCount !== values.length) {
					throw new Error(
						'INTERNAL: Expected the number of rows returned to match the number'
						+ ` of rows inserted, got ${rowCount} vs ${values.length}, `
						+ `for resource ${rsc.name}`
					)
				}

				if(rows) {
					// we'll mark the rows as resolved
					// and remove from pendingRows
					for(const [i, row] of rows.entries()) {
						const rb = pendingRows[i]
						rb.onValuesResolved(row as PlainObject)
						resolvedRowMap[rscName] ||= []
						resolvedRowMap[rscName].push(rb)
					}
				} else {
					// no rows returned, so we just remove the pending rows
					resolvedRowMap[rscName] ||= []
					resolvedRowMap[rscName].push(...pendingRows)
				}

				this.pendingRowMap[rscName] = this.pendingRowMap[rscName]
					.filter(r => !pendingRows.includes(r))
			}
		}

		return resolvedRowMap
	}

	#getDependencyFreeRowBuilders(): { [rscName: string]: PgRowBuilder[] } | undefined {
		const builders: { [rscName: string]: PgRowBuilder[] } = {}

		let hasValues = false
		for(const [rscName, pendingRows] of Object.entries(this.pendingRowMap)) {
			const depFreeBuilders = pendingRows.filter(rb => !rb.hasDependencies())
			if(!depFreeBuilders.length) {
				continue
			}

			builders[rscName] = depFreeBuilders
			hasValues = true
		}

		if(!hasValues) {
			return
		}

		return builders
	}
}

export class PgRowBuilder extends Modifier<PgCreateStep> {

	readonly resource: PgTableResource
	readonly #values: Record<string, RowValue<unknown>> = {}
	readonly #dependents: Record<string, { rbKey: string, rb: PgRowBuilder }[]> = {}
	readonly #dependencies = new Set<string>()

	constructor(
		parent: PgCreateStep,
		resource: PgTableResource = parent.resource
	) {
		super(parent)
		this.resource = resource
	}

	apply(): void {
		this.parent.pendingRowMap[this.resource.name] ||= []
		this.parent.pendingRowMap[this.resource.name].push(this)
	}

	set(key: string, value: unknown): void {
		if(this.#values[key]) {
			throw new Error(`Value for ${key} already set for ${this.resource.name}`)
		}

		this.#values[key] = { constant: value }
	}

	setRelation(relationName: string) {
		const rel = this.resource.getRelation(relationName)
		if(!rel) {
			throw new Error(
				`Relation ${relationName} not found on resource ${this.resource.name}`
			)
		}

		const rb = new PgRowBuilder(
			this.parent,
			rel.remoteResource as PgTableResource
		)

		// this is the source of the relation
		if(rel.isReferencee) {
			this.#setReferencedRelation(relationName, rb)
		// this is the target of the relation
		} else {
			const invRelation = rb.resource.getReciprocal(
				this.resource.codec,
				relationName
			)?.[0]
			if(typeof invRelation !== 'string') {
				throw new Error(
					'INTERNAL ERROR: No reciprocal relation found for ' +
					`${this.resource.name}.${relationName} on ` +
					`${rb.resource.name}`
				)
			}

			rb.#setReferencedRelation(invRelation, this)
		}

		return rb
	}

	hasDependencies() {
		return !!this.#dependencies.size
	}

	getDependents() {
		return Object.keys(this.#dependents)
	}

	#setReferencedRelation(relationName: string, rb: PgRowBuilder) {
		const rel = this.resource.getRelation(relationName)
		for(const [i, attr] of rel.localAttributes.entries()) {
			const remoteAttrName = rel.remoteAttributes[i]
			rb.#values[remoteAttrName] = { dependency: this, key: attr }
			rb.#dependencies.add(remoteAttrName)

			this.#dependents[attr] ||= []
			this.#dependents[attr].push({ rbKey: remoteAttrName, rb })
		}
	}

	onValuesResolved(values: Record<string, unknown>): void {
		for(const [key, value] of Object.entries(values)) {
			this.#values[key] = { constant: value }
			const dependentsOnKey = this.#dependents[key]
			if(!dependentsOnKey) {
				continue
			}

			for(const { rbKey, rb } of dependentsOnKey) {
				rb.#onDependencyResolved(rbKey, value)
			}

			delete this.#dependents[key]
		}
	}

	plainObject() {
		const obj: PlainObject = {}
		for(const [key, value] of Object.entries(this.#values)) {
			if(('constant' in value)) {
				obj[key] = value.constant
			} else if(value.dependency) {
				throw new Error(
					`Cannot get plain values for ${this.resource.name}, `
					+ `dependency "${key}" is not resolved`
				)
			}
		}

		return obj
	}

	#onDependencyResolved(key: string, value: unknown): void {
		this.#values[key] = { constant: value }
		// if other row builders are waiting for this value,
		// notify them
		const deps = this.#dependents[key]
		if(deps?.length) {
			for(const { rbKey, rb } of deps) {
				rb.#onDependencyResolved(rbKey, value)
			}

			delete this.#dependents[key]
		}

		// delete the dependency
		this.#dependencies.delete(key)
	}
}