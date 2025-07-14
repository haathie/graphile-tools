import { getInputConditionForResource } from '@haathie/postgraphile-common-utils'
import type { PgSelectStep } from 'postgraphile/@dataplan/pg'
import type { GraphQLInputObjectType } from 'postgraphile/graphql'
import { PgSelectAndModify } from './PgSelectAndModify.js'
import type { PgTableResource } from './types.ts'
import { isDeletable, isUpdatable } from './utils.ts'

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
				`Add bulk delete fields for ${resource.name}`
			)
		}

		if(isUpdatable(build, resource)) {
			build.extend(
				fields,
				getBulkUpdateFields(build, resource, ctx),
				`Add bulk update fields for ${resource.name}`
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
			{ fieldName: deleteFieldName, isBulkDeleteOperation: true },
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
					inflection.bulkDeletePayloadName(resource)
				),
				extensions: { grafast: { plan } },
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
			{ fieldName: fieldName, isBulkUpdateOperation: true },
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
					inflection.bulkUpdatePayloadName(resource)
				),
				extensions: { grafast: { plan } },
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