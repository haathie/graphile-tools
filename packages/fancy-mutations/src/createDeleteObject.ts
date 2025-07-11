import { getInputConditionForResource } from '@haathie/postgraphile-common-utils'
import { type PgCodecWithAttributes, PgResource, PgSelectStep } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, lambda, Step } from 'postgraphile/grafast'
import { type GraphQLFieldConfig, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'postgraphile/graphql'
import { PgSelectAndModify } from './PgSelectAndModify.js'

type CreateMutationOpts = {
	table: PgResource<string, PgCodecWithAttributes>
	build: GraphileBuild.Build
}

type GrafastPlanParams<T extends Step = Step> = Parameters<
	FieldPlanResolver<T, any, any>
>

export function createDeleteObject(
	{ table, build }: CreateMutationOpts
): GraphQLFieldConfig<any, any> | undefined {
	const { inflection } = build
	const { codec } = table
	const executor = codec.executor!
	if(!executor) {
		// if we don't have an executor, we can't insert
		return
	}

	if(!table.extensions?.canDelete || !table.extensions.isDeletable) {
		return
	}

	const _outputObj = build
		.getGraphQLTypeByPgCodec(codec, 'output') as GraphQLObjectType
	if(!_outputObj) {
		return
	}

	const baseName = inflection.pluralize(`delete_${table.name}`)
	const conditionArg = getInputConditionForResource(table, build)
	if(!conditionArg) {
		return
	}

	return {
		description: `Delete one or more ${table.name} items`,
		type: new GraphQLObjectType({
			name: inflection.upperCamelCase(`${baseName}_payload`),
			fields: {
				items: {
					type: new GraphQLNonNull(
						new GraphQLList(new GraphQLNonNull(_outputObj))
					),
					extensions: {
						grafast: {
							plan(parent) {
								return parent
							}
						}
					}
				},
				affected: {
					type: new GraphQLNonNull(GraphQLInt),
					extensions: { grafast: { plan: getRowCountPlan } }
				}
			},
		}),
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
		extensions: {
			grafast: {
				plan
			}
		}
	}

	function plan() {
		const step = new PgSelectAndModify({
			resource: table,
			mode: 'mutation',
			identifiers: [],
		})
		step.delete()

		return step
	}
}

function getRowCountPlan(
	...[plan]: GrafastPlanParams<PgSelectAndModify>
) {
	return lambda(plan, arg => {
		if(!Array.isArray(arg.items)) {
			throw new Error('Expected an array of results')
		}

		return arg.items.length
	})
}