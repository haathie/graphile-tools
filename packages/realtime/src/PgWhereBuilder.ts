import {
	type PgConditionCapableParent,
	type PgWhereConditionSpec,
	pgWhereConditionSpecListToSQL,
} from 'postgraphile/@dataplan/pg'
import { type ApplyInputStep, ConstantStep, type ExecutionDetails, type ExecutionResults, Step } from 'postgraphile/grafast'
import { isSQL, type SQL } from 'postgraphile/pg-sql2'

export class PgWhereBuilder extends Step<SQL | undefined>
	implements PgConditionCapableParent {

	alias: SQL
	private condition?: SQL
	private applyDepIds: number[] = []

	constructor(alias: SQL) {
		super()
		this.alias = alias
		this.isSyncAndSafe = true
	}

	where(condition: PgWhereConditionSpec<any>): void {
		if(!isSQL(condition)) {
			throw new Error('Condition must be a SQL expression')
		}

		this.condition = condition
	}

	having(): void {
		throw new Error(
			'Having conditions are not supported in this context'
		)
	}

	execute(
		{ indexMap, values, stream }: ExecutionDetails
	): ExecutionResults<SQL | undefined> {
		if(stream) {
			throw new Error('Streaming is not supported in this context')
		}

		// If no runtime dependencies, return plan-time condition
		if(this.applyDepIds.length === 0) {
			return indexMap(() => this.condition)
		}

		// Collect conditions from runtime callbacks using a plain object
		// instead of PgCondition (which is a Modifier and cannot be created
		// outside of grafast's withModifiers() context).
		const conditions: PgWhereConditionSpec<any>[] = []
		const condTarget: PgConditionCapableParent = {
			alias: this.alias,
			where(condition: PgWhereConditionSpec<any>) {
				conditions.push(condition)
			},
			having() {
				throw new Error('Having conditions are not supported')
			}
		}

		for(const applyDepId of this.applyDepIds) {
			const val = values[applyDepId].unaryValue()
			if(Array.isArray(val)) {
				for(const v of val) {
					v?.(condTarget)
				}
			} else {
				val?.(condTarget)
			}
		}

		const result = pgWhereConditionSpecListToSQL(this.alias, conditions)
		return indexMap(() => result ?? undefined)
	}

	apply($step: ApplyInputStep<any>) {
		if($step instanceof ConstantStep) {
			$step.data(this)
		} else {
			this.applyDepIds.push(this.addUnaryDependency($step))
		}
	}
}