import { getInputConditionForResource } from '@haathie/postgraphile-common-utils'
import { type PgSelectStep } from 'postgraphile/@dataplan/pg'
import type { GraphQLEnumType, GraphQLInputObjectType } from 'postgraphile/graphql'
import { PgCreateStep } from './PgCreateStep.ts'
import { PgSelectAndModify } from './PgSelectAndModify.js'
import type { GrafastPlanParams, PgTableResource } from './types.ts'
import { isDeletable, isInsertable, isUpdatable } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLObjectType_fields']

export const fieldsHook: Hook = (
	fields, build, ctx
) => {
	const {
		input: { pgRegistry: { pgResources } },
	} = build
	const { scope: { isRootMutation } } = ctx
	if(!isRootMutation) {
		return fields
	}

	for(const resource of Object.values(pgResources)) {
		if(isDeletable(build, resource)) {
			build.extend(
				fields,
				getBulkDeleteFields(build, resource, ctx),
				`Add bulk delete operation for ${resource.name}`
			)
		}

		if(isUpdatable(build, resource)) {
			build.extend(
				fields,
				getBulkUpdateFields(build, resource, ctx),
				`Add bulk update operation for ${resource.name}`
			)
		}

		if(isInsertable(build, resource)) {
			build.extend(
				fields,
				getBulkCreateFields(build, resource, ctx),
				`Add bulk create operation for ${resource.name}`
			)
		}
	}

	return fields
}

function getBulkDeleteFields(
	build: GraphileBuild.Build,
	resource: PgTableResource,
	{ fieldWithHooks }: GraphileBuild.ContextObjectFields
) {
	const { inflection, getOutputTypeByName } = build
	const deleteFieldName = inflection.bulkDeleteOperationName(resource)

	const conditionArg = getInputConditionForResource(resource, build)
	if(!conditionArg) {
		throw new Error(
			`No input condition for resource ${resource.name}, cannot create bulk delete field`
		)
	}

	return {
		[deleteFieldName]: fieldWithHooks(
			{
				fieldName: deleteFieldName,
				isBulkDeleteOperation: true,
				pgFieldResource: resource
			},
			{
				args: {
					condition: {
						type: conditionArg,
						extensions: {
							grafast: {
								applyPlan(plan, fields: PgSelectStep, input) {
									input.apply(fields, rslt => rslt.whereBuilder())
								}
							}
						}
					}
				},
				type: getOutputTypeByName(
					inflection.bulkMutationPayloadName(resource)
				),
				plan,
				description: `Delete one or more ${resource.name} items`
			}
		)
	}

	function plan() {
		const step = new PgSelectAndModify({ resource, identifiers: [] })
		step.delete()

		return step
	}
}

function getBulkUpdateFields(
	build: GraphileBuild.Build,
	resource: PgTableResource,
	{ fieldWithHooks }: GraphileBuild.ContextObjectFields
) {
	const { inflection, getOutputTypeByName } = build
	const fieldName = inflection.bulkUpdateOperationName(resource)

	const conditionArg = getInputConditionForResource(resource, build)
	if(!conditionArg) {
		throw new Error(
			`No input condition for resource ${resource.name}, cannot create bulk update field`
		)
	}

	const patchType = build
		.getGraphQLTypeByPgCodec(resource.codec, 'patch') as GraphQLInputObjectType
	if(!patchType) {
		throw new Error(
			`No patch type for resource ${resource.name}, cannot create bulk update field`
		)
	}

	return {
		[fieldName]: fieldWithHooks(
			{
				fieldName: fieldName,
				isBulkUpdateOperation: true,
				pgFieldResource: resource
			},
			{
				args: {
					condition: {
						type: conditionArg,
						extensions: {
							grafast: {
								applyPlan(plan, fields: PgSelectStep, input) {
									input.apply(fields, rslt => rslt.whereBuilder())
								}
							}
						}
					},
					patch: {
						type: patchType,
						extensions: {
							grafast: {
								applyPlan(plan, fields: PgSelectAndModify, input) {
									input.apply(fields, () => fields)
								}
							}
						}
					}
				},
				type: getOutputTypeByName(
					inflection.bulkMutationPayloadName(resource)
				),
				plan,
				description: `Update one or more ${resource.name} items`
			}
		)
	}

	function plan() {
		const step = new PgSelectAndModify({ resource, identifiers: [] })
		step.update()

		return step
	}
}

function getBulkCreateFields(
	build: GraphileBuild.Build,
	resource: PgTableResource,
	{ fieldWithHooks }: GraphileBuild.ContextObjectFields
) {
	const {
		inflection,
		getOutputTypeByName,
		graphql: { GraphQLNonNull, GraphQLList }
	} = build
	const fieldName = inflection.bulkCreateOperationName(resource)

	const inputObj = build.getTypeByName(
		inflection.bulkCreateInputObjectName(resource)
	)	as GraphQLInputObjectType

	const OnConflictOptions = build.getTypeByName(
		inflection.onConflictEnumName()
	) as GraphQLEnumType

	return {
		[fieldName]: fieldWithHooks(
			{
				fieldName: fieldName,
				isBulkCreateOperation: true,
				pgFieldResource: resource
			},
			{
				args: {
					onConflict: {
						type: OnConflictOptions,
						defaultValue: 'error',
					},
					items: {
						type: new GraphQLNonNull(
							new GraphQLList(new GraphQLNonNull(inputObj))
						),
						extensions: {
							grafast: {
								applyPlan(_, plan: PgCreateStep, input) {
									return input.apply(plan, p => (
										// returning a fn, as "items" is a list
										// this'll create a new row builder for
										// each item
										() => p.addRowBuilder()
									))
								}
							}
						}
					}
				},
				type: getOutputTypeByName(
					inflection.bulkMutationPayloadName(resource)
				),
				plan,
				description: `Create one or more ${resource.name} items`
			}
		)
	}

	function plan(...[, args]: GrafastPlanParams) {
		return new PgCreateStep(resource, args.getRaw('onConflict'))
	}
}