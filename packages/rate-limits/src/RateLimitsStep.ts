import { context, type ExecutionDetails, type ExecutionResults, Step } from 'postgraphile/grafast'
import type { RateLimitParsedTag } from './types.ts'
import { applyRateLimits } from './utils.ts'

export class RateLimitsStep extends Step<null> {

	rateLimits: { [apiName: string]: RateLimitParsedTag[] } = {}
	contextId: number

	constructor() {
		super()

		this.isSyncAndSafe = false
		this.hasSideEffects = true
		this.contextId = this.addDependency(context())
	}

	setRateLimits(
		apiName: string,
		applicableRateLimits: RateLimitParsedTag[]
	) {
		if(!applicableRateLimits.length) {
			return
		}

		if(this.rateLimits[apiName]) {
			throw new Error(
				`Rate limits for API "${apiName}" are already set. `
			)
		}

		this.rateLimits[apiName] = applicableRateLimits
	}

	execute({ indexMap, values }: ExecutionDetails): ExecutionResults<null> {
		const ctxValue = values[this.contextId]
		return indexMap(async i => {
			const ctx = ctxValue.at(i) as Grafast.Context
			await applyRateLimits(this.rateLimits, ctx)

			return null
		})
	}
}