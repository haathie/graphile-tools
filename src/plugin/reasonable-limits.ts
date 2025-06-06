import { sideEffect } from 'postgraphile/grafast'
import type { GraphQLArgument, GraphQLFieldMap } from 'postgraphile/graphql'
import { makeProcessSchemaPlugin } from 'postgraphile/utils'

const MAX_RECORDS_PER_PAGE = 100
const DEFAULT_RECORDS_PER_PAGE = 10

export const ReasonableLimitsPlugin = makeProcessSchemaPlugin(schema => {
	// Get the Query type
	const queryType = schema.getType('Query')
	if(!('getFields' in queryType)) {
		console.warn('ReasonableLimits: Query type does not have fields, skipping plugin application.')
		return schema
	}

	const fields = queryType.getFields() as GraphQLFieldMap<any, any>
	const allQueries = Object.entries(fields)
	for(const [name, field] of allQueries) {
		if(!('args' in field)) {
			continue
		}

		const offsetArgIdx = field.args.findIndex(a => a.name === 'offset')
		if(offsetArgIdx !== -1) {
			// Remove the "offset" argument
			field.args = field.args.filter((_, idx) => idx !== offsetArgIdx)
			console.debug(
				`ReasonableLimits: Removed "offset" argument from field "${name}"`
			)
		}

		const lastArg = field.args.find(a => a.name === 'last')
		if(lastArg) {
			setLimitOnIntArg(lastArg, MAX_RECORDS_PER_PAGE)
			console.debug(
				`ReasonableLimits: Updated "last" argument for field "${name}"`
			)
		}

		const firstArg = field.args.find(a => a.name === 'first')
		if(firstArg) {
			firstArg.defaultValue = DEFAULT_RECORDS_PER_PAGE
			setLimitOnIntArg(firstArg, MAX_RECORDS_PER_PAGE)

			console.debug(
				`ReasonableLimits: Updated "first" argument for field "${name}"`
			)
		}
	}

	return schema
})

function setLimitOnIntArg(arg: GraphQLArgument, max: number) {
	const ogPlan = arg.extensions.grafast.applyPlan
	arg.extensions.grafast.applyPlan = (plan, fieldPlan, input, info) => {
		sideEffect(input.getRaw(), f => {
			if(typeof f === 'number' && f > max) {
				throw new Error(
					`Maximum of ${max} records can be requested per page`
				)
			}
		})

		return ogPlan(plan, fieldPlan, input, info)
	}
}