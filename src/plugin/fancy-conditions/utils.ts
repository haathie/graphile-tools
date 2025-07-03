import { Modifier, Step } from 'postgraphile/grafast'
import { OperationTypeNode } from 'postgraphile/graphql'

export function isSubscriptionPlan(plan: Step | Modifier<any>) {
	if(plan instanceof Modifier) {
		// hack to access parent
		return isSubscriptionPlan(plan['parent'])
	}

	if(!(plan instanceof Step)) {
		return
	}

	return plan.operationPlan.operation.operation
		=== OperationTypeNode.SUBSCRIPTION
}