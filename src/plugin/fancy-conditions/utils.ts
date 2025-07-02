import { Modifier, Step } from 'postgraphile/grafast'
import { OperationTypeNode } from 'postgraphile/graphql'

export function isSubscriptionPlan(plan: Step | Modifier<any>) {
	if(!(plan instanceof Step)) {
		if('parent' in plan) {
			// hack to access parent
			return isSubscriptionPlan(plan['parent'])
		}

		throw new Error('Expected a Step, but got something without a `parent`')
	}

	return plan.operationPlan.operation.operation
		=== OperationTypeNode.SUBSCRIPTION
}