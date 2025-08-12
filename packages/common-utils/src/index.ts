import type {} from 'postgraphile'
import type { PgCodec, PgResource } from 'postgraphile/@dataplan/pg'
import { type PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'
import { Modifier, Step } from 'postgraphile/grafast'
import type {} from 'postgraphile/grafserv/express/v4'
import type { GraphQLInputObjectType } from 'postgraphile/graphql'
import { GraphQLObjectType, OperationTypeNode } from 'postgraphile/graphql'

export type PgTableResource = PgResource<string, PgCodecWithAttributes>

/**
 * Field name to its internal PG attribute name.
 * If the field is a compound field, the value is an array
 * where the first element is the attribute name, and the second
 * element is a map of sub-fields to their attribute names.
 */
export type FieldNameToAttrNameMap = {
	[fieldName: string]: string | [string, FieldNameToAttrNameMap]
}

export function getRelationFieldName(
	relationName: string,
	table: PgTableResource,
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
	resource: PgTableResource,
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

export function buildFieldNameToAttrNameMap(
	codec: PgCodec,
	inflection: GraphileBuild.Inflection
): FieldNameToAttrNameMap | undefined {
	if(codec.arrayOfCodec) {
		codec = codec.arrayOfCodec
	}

	if(!codec.attributes) {
		return
	}

	const map: FieldNameToAttrNameMap = {}
	for(const [attrName, attr] of Object.entries(codec.attributes)) {
		const fieldName = inflection.attribute({
			attributeName: attrName,
			// @ts-ignore
			codec,
		})

		map[fieldName] = attr.codec.attributes
			? [attrName, buildFieldNameToAttrNameMap(attr.codec, inflection)!]
			: attrName
	}

	return map
}

/**
 * Maps an object (or list of objects) coming from the GraphQL API
 * to the internal PG attribute names.
 * @example `{ fullName: 'John Doe', age: 30 }` => `{ full_name: 'John', age: 30 }`
 */
export function mapFieldsToAttrs(
	value: unknown,
	map: FieldNameToAttrNameMap
): unknown {
	if(Array.isArray(value)) {
		return value.map(v => mapFieldsToAttrs(v, map))
	}

	if(typeof value !== 'object' || value === null) {
		return value
	}

	const attrs: Record<string, unknown> = {}
	for(const [key, _value] of Object.entries(value)) {
		const attrName = map[key]
		if(typeof attrName === 'string') {
			// simple attribute, just map it
			attrs[attrName] = _value
			continue
		}

		const [attrNameKey, subMap] = attrName
		attrs[attrNameKey] = mapFieldsToAttrs(_value, subMap)
	}

	return attrs
}