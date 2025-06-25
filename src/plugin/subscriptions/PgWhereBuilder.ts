import { PgCondition, type PgConditionCapableParent, type PgWhereConditionSpec } from 'postgraphile/@dataplan/pg'
import { ApplyInputStep, ConstantStep, type ExecutionDetails, type ExecutionResults, Step } from 'postgraphile/grafast'
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

		const cond = new PgCondition(this, false, 'AND')
		for(const applyDepId of this.applyDepIds) {
			const val = values[applyDepId].unaryValue()
			if(Array.isArray(val)) {
				for(const v of val) {
					v?.(cond)
				}
			} else {
				val?.(cond)
			}
		}

		return indexMap(() => this.condition)
	}

	apply($step: ApplyInputStep<any>) {
		if($step instanceof ConstantStep) {
			$step.data(this)
		} else {
			this.applyDepIds.push(this.addUnaryDependency($step))
		}
	}
}