import type {} from 'postgraphile'
import { type PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'
import { Modifier, Step } from 'postgraphile/grafast'
import type {} from 'postgraphile/grafserv/express/v4'
import { GraphQLInputObjectType, GraphQLObjectType, OperationTypeNode } from 'postgraphile/graphql'

type _PgResource = PgResource<string, PgCodecWithAttributes>

export function getRelationFieldName(
	relationName: string,
	table: _PgResource,
	{ inflection }: GraphileBuild.Build,
) {
	const { isUnique } = table.getRelation(relationName)
	const isMulti = !isUnique
	const relNameFn = isMulti ? 'manyRelationConnection' : 'singleRelation'
	return inflection[relNameFn]({
		codec: table.codec,
		relationName,
		registry: table.registry
	})
}

export function getInputConditionForResource(
	resource: _PgResource,
	{ inflection, getTypeByName }: GraphileBuild.Build,
): GraphQLInputObjectType | undefined {
	const queryType = getTypeByName('Query')
	if(!queryType || !(queryType instanceof GraphQLObjectType)) {
		return
	}

	const resourceQueryFieldName = inflection.allRowsConnection(resource)
	const queryField = queryType.getFields()[resourceQueryFieldName]
	if(!queryField) {
		return
	}

	const conditionArg = queryField.args
		.find(a => a.name === 'condition')
		?.type as GraphQLInputObjectType
	if(!conditionArg) {
		return
	}

	return conditionArg
}

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

export function getRequestIp(args: Grafast.RequestContext) {
	const ip = args.http?.getHeader('x-forwarded-for')
		|| args.http?.getHeader('x-real-ip')
	if(ip) {
		return ip
	}

	const sock = args?.node?.req?.socket
	if(!sock) {
		return
	}

	return sock.remoteAddress
}