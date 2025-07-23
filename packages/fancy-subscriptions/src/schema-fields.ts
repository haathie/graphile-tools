import { getInputConditionForResource } from '@haathie/postgraphile-common-utils'
import type { FieldPlanResolver } from 'postgraphile/grafast'
import type { GraphQLObjectType } from 'postgraphile/graphql'
import { CreateSubscriptionStep } from './CreateSubscriptionStep.ts'
import { LDSSource, type PgChangeOp } from './lds.ts'
import { PgWhereBuilder } from './PgWhereBuilder.ts'
import type { PgTableResource } from './types.ts'
import { isSubscribable } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLObjectType_fields']

type PlanResolver = FieldPlanResolver<any, any, any>

export const schemaFieldsHook: Hook = (
	fields, build, ctx
) => {
	const { scope: { isRootSubscription }, fieldWithHooks } = ctx
	if(!isRootSubscription) {
		return fields
	}

	const {
		input: { pgRegistry: { pgResources } },
		inflection,
		getTypeByName,
		extend
	} = build

	for(const resource of Object.values(pgResources)) {
		if(!isSubscribable(resource, build)) {
			continue // not subscribable
		}

		const conditionArg = getInputConditionForResource(resource, build)
		if(!conditionArg) {
			continue
		}

		const subsArgs = { 'condition': { type: conditionArg } }

		const createdName = inflection
			.subscriptionFieldName(resource, 'created')
		const deletedName = inflection
			.subscriptionFieldName(resource, 'deleted')
		const updatedName = inflection
			.subscriptionFieldName(resource, 'updated')

		const createdType = getTypeByName(
			inflection.subscriptionTypeName(resource, 'created')
		) as GraphQLObjectType
		const deletedType = getTypeByName(
			inflection.subscriptionTypeName(resource, 'deleted')
		) as GraphQLObjectType
		const updatedType = getTypeByName(
			inflection.subscriptionTypeName(resource, 'updated')
		) as GraphQLObjectType

		extend(
			fields,
			{
				[createdName]: fieldWithHooks(
					{
						isSubscriptionField: true,
						subscriptionType: 'created',
						fieldName: createdName,
					},
					() => ({
						type: createdType,
						args: subsArgs,
						description: `Subscription for new ${resource.name} items`,
						subscribePlan: createSubscriptionPlan(resource, 'I', build),
						plan: p => p
					})
				),
				[deletedName]: fieldWithHooks(
					{
						isSubscriptionField: true,
						subscriptionType: 'deleted',
						fieldName: deletedName,
					},
					() => ({
						type: deletedType,
						args: subsArgs,
						description: `Subscription for deleted ${resource.name} items`,
						subscribePlan: createSubscriptionPlan(resource, 'D', build),
						plan: p => p
					})
				),
				[updatedName]: fieldWithHooks(
					{
						isSubscriptionField: true,
						subscriptionType: 'updated',
						fieldName: updatedName,
					},
					() => ({
						type: updatedType,
						args: subsArgs,
						description: `Subscription for updated ${resource.name} items`,
						subscribePlan: createSubscriptionPlan(resource, 'U', build),
						plan: p => p
					})
				)
			},
			`subscription fields for ${resource.name}`
		)
	}

	return fields
}


function createSubscriptionPlan(
	resource: PgTableResource,
	kind: PgChangeOp,
	{ sql: { sql } }: GraphileBuild.Build,
) {
	const { codec: { extensions: { pg: pgInfo } = {} } } = resource
	if(!pgInfo) {
		throw new Error(`Resource ${resource.name} does not have pg info`)
	}

	const plan: PlanResolver = (parent, args) => {
		const alias = sql`t`
		const $whereBuilder = new PgWhereBuilder(alias)
		args.apply($whereBuilder)

		const $argsRaw = args.getRaw()
		return new CreateSubscriptionStep(
			resource, LDSSource.current, kind, $whereBuilder, $argsRaw
		)
	}

	return plan
}