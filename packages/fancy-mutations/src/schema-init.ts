import type { lambda } from 'postgraphile/grafast'
import type { GraphQLObjectType } from 'postgraphile/graphql'
import { PgSelectAndModify } from './PgSelectAndModify.js'
import type { GrafastPlanParams, PgTableResource } from './types.ts'
import { isDeletable, isUpdatable } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['init']

export const initHook: Hook = (
	config, build
) => {
	const { input: { pgRegistry: { pgResources } } } = build
	for(const resource of Object.values(pgResources)) {
		if(isDeletable(build, resource)) {
			registerDeletePayload(build, resource)
		}

		if(isUpdatable(build, resource)) {
			registerUpdatePayload(build, resource)
		}
	}

	return config
}

function registerDeletePayload(
	build: GraphileBuild.Build,
	resource: PgTableResource
) {
	const {
		inflection,
		grafast: { lambda },
		graphql: { GraphQLInt, GraphQLNonNull }
	} = build
	const payloadName = inflection.bulkDeletePayloadName(resource)

	return build.registerObjectType(
		payloadName,
		{
			isMutationPayload: true,
			isBulkDeleteObject: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Payload for the bulk delete operation on ${resource.name}`,
			fields({ fieldWithHooks }) {
				return {
					affected: {
						type: new GraphQLNonNull(GraphQLInt),
						extensions: { grafast: { plan: createRowCountPlan(lambda) } }
					},
					items: getOutputItems(
						resource, { isBulkDeleteItems: true }, build, fieldWithHooks
					)
				}
			}
		}),
		`Payload for the bulk delete operation on ${resource.name}`
	)
}


function registerUpdatePayload(
	build: GraphileBuild.Build,
	resource: PgTableResource
) {
	const {
		inflection,
		grafast: { lambda },
		graphql: { GraphQLInt, GraphQLNonNull }
	} = build
	const payloadName = inflection.bulkUpdatePayloadName(resource)

	return build.registerObjectType(
		payloadName,
		{
			isMutationPayload: true,
			isBulkUpdateObject: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Payload for the bulk update operation on ${resource.name}`,
			fields({ fieldWithHooks }) {
				return {
					affected: {
						type: new GraphQLNonNull(GraphQLInt),
						extensions: { grafast: { plan: createRowCountPlan(lambda) } }
					},
					items: getOutputItems(
						resource, { isBulkDeleteItems: true }, build, fieldWithHooks
					)
				}
			}
		}),
		`Payload for the bulk update operation on ${resource.name}`
	)
}

function createRowCountPlan(
	_lambda: typeof lambda,
) {
	return (...[plan]: GrafastPlanParams<PgSelectAndModify>) => (
		_lambda(plan, arg => {
			if(!Array.isArray(arg.items)) {
				throw new Error('Expected an array of results')
			}

			return arg.items.length
		})
	)
}

function getOutputItems(
	resource: PgTableResource,
	scope: Partial<GraphileBuild.ScopeObjectFieldsField>,
	build: GraphileBuild.Build,
	fieldWithHooks: GraphileBuild.ContextObjectFields['fieldWithHooks'],
) {
	return fieldWithHooks(
		{ fieldName: 'items', ...scope },
		() => {
			const outputObj = build.getGraphQLTypeByPgCodec(
				resource.codec, 'output'
			) as GraphQLObjectType
			if(!outputObj) {
				throw new Error(
					`No output type for resource ${resource.name}`
				)
			}

			return {
				type: new build.graphql.GraphQLList(outputObj),
				extensions: { grafast: { plan: p => p } }
			}
		}
	)
}