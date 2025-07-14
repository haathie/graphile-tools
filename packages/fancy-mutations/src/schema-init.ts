import { pgSelectFromRecords } from 'postgraphile/@dataplan/pg'
import { lambda } from 'postgraphile/grafast'
import type { GraphQLObjectType } from 'postgraphile/graphql'
import { buildFieldsForCreate } from './create-utils.ts'
import { PgCreateStep } from './PgCreateStep.ts'
import { PgSelectAndModify } from './PgSelectAndModify.js'
import type { GrafastPlanParams, PgTableResource } from './types.ts'
import { isDeletable, isInsertable, isUpdatable } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['init']

export const initHook: Hook = (
	config, build
) => {
	const { input: { pgRegistry: { pgResources } } } = build

	registerOnConflictType(build)

	for(const resource of Object.values(pgResources)) {
		if(isDeletable(build, resource)) {
			registerDeletePayload(build, resource)
		}

		if(isUpdatable(build, resource)) {
			registerUpdatePayload(build, resource)
		}

		if(isInsertable(build, resource)) {
			registerCreatePayload(build, resource)
			registerCreateInputObject(build, resource)
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

function registerCreatePayload(
	build: GraphileBuild.Build,
	resource: PgTableResource
) {
	const {
		inflection,
		grafast: { lambda },
		graphql: { GraphQLInt, GraphQLNonNull }
	} = build
	const payloadName = inflection.bulkCreatePayloadName(resource)

	build.registerObjectType(
		payloadName,
		{
			isMutationPayload: true,
			isBulkCreateObject: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Payload for the bulk create operation on ${resource.name}`,
			fields({ fieldWithHooks }) {
				return {
					affected: {
						type: new GraphQLNonNull(GraphQLInt),
						extensions: { grafast: { plan: createRowCountPlan(lambda) } }
					},
					items: getOutputItems(
						resource, { isBulkCreateItems: true }, build, fieldWithHooks
					),
				}
			}
		}),
		`Payload for the bulk create operation on ${resource.name}`
	)
}

function registerCreateInputObject(
	build: GraphileBuild.Build,
	resource: PgTableResource
) {
	const { inflection } = build

	const fields = buildFieldsForCreate(resource, build)
	build.registerInputObjectType(
		inflection.bulkCreateInputObjectName(resource),
		{
			isMutationInput: true,
			isBulkCreateInputObject: true,
			pgResource: resource,
		},
		() => ({
			description: `Input object for the bulk create operation on ${resource.name}`,
			fields,
		}),
		'Input object for the bulk create operation on ' + resource.name
	)
}

function createRowCountPlan(
	_lambda: typeof lambda,
) {
	return (...[plan]: GrafastPlanParams<PgSelectAndModify | PgCreateStep>) => (
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
	return fieldWithHooks({ fieldName: 'items', ...scope }, () => {
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
			extensions: {
				grafast: {
					plan: ($plan) => {
						if(!($plan instanceof PgCreateStep)) {
							throw new Error(
								`Expected a PgCreateStep, got ${$plan.constructor.name}`
							)
						}

						const $select = pgSelectFromRecords(
							resource,
							lambda($plan, p => (console.log(p.items), p.items))
						)
						$plan.referenceSelectForSelections($select)

						return $select
					}
				}
			}
		}
	})
}

function registerOnConflictType(
	{ registerEnumType, inflection }: GraphileBuild.Build
) {
	return registerEnumType(
		inflection.onConflictEnumName(),
		{ },
		() => ({
			description: 'Options for handling conflicts during create operations',
			values: {
				'DoNothing': {
					value: 'ignore',
					description: 'In case of a duplicate key, ignore the create.'
				},
				'Error': {
					value: 'error',
					description: 'In case of a duplicate key, throw an error.'
				},
				'Replace': { value: 'replace' },
			},
		}),
		'OnConflictOptions',
	)
}