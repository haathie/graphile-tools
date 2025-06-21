import { jsonParse } from 'postgraphile/@dataplan/json'
import { pgSelectFromRecords, withPgClientTransaction, withSuperuserPgClientFromPgService, type PgCodecWithAttributes, type PgResource } from 'postgraphile/@dataplan/pg'
import { constant, context, list, listen, object, type FieldPlanResolver } from 'postgraphile/grafast'
import { type GraphQLFieldConfig, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'postgraphile/graphql'
import { gql, makeExtendSchemaPlugin } from 'postgraphile/utils'

type _PgResource = PgResource<string, PgCodecWithAttributes>

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLSchema']

type PlanResolver = FieldPlanResolver<any, any, any>

const graphQLSchemaHook: Hook = (config, build) => {
	const subs: GraphQLObjectTypeConfig<any, any>['fields'] = {}
	const { allPgCodecs, inflection } = build
	const existingFields = config.subscription?.getFields()

	for(const codec of allPgCodecs) {
		if(!codec.extensions?.isTableLike) {
			continue
		}

		const resource = build.pgTableResource(codec) as _PgResource
		const model = build
			.getGraphQLTypeByPgCodec(codec, 'output') as GraphQLObjectType
		if(!model) {
			continue // no model, cannot subscribe
		}

		const pkType = getPkType(resource, model)
		if(!pkType) {
			continue // no model, cannot subscribe
		}

		const createdEvName = inflection.camelCase(
			inflection.pluralize(`created_${model.name}`)
		)
		const deletedEvName = inflection.camelCase(
			inflection.pluralize(`deleted_${model.name}`)
		)
		const updatedEvName = inflection.camelCase(
			inflection.pluralize(`updated_${model.name}`)
		)

		subs[createdEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(model))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, 'insert'),
					plan(parent) {
						return pgSelectFromRecords(resource, parent)
					}
				}
			}
		}
		subs[deletedEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(pkType))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, 'delete'),
					plan(parent) {
						console.log('Subscription plan for deleted:', parent)
						return parent
					}
				}
			}
		}

		const updateObj = new GraphQLObjectType({
			name: inflection.upperCamelCase(`${model.name}Update`),
			fields: {
				key: { type: new GraphQLNonNull(pkType) },
				changes: { type: new GraphQLNonNull(model) }
			}
		})

		subs[updatedEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateObj))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, 'update'),
					plan(parent) {
						console.log('plan for updated:', parent)
						return parent
					}
				}
			}
		}
	}

	const newSubs = new GraphQLObjectType({
		name: 'Subscriptions',
		fields: subs,
	})
	if(existingFields) {
		Object.assign(existingFields, newSubs.getFields())
	} else {
		config.subscription = newSubs
	}

	return config

	function getPkType(resource: _PgResource, ogModel: GraphQLObjectType) {
		const pk = resource.uniques.find(u => u.isPrimary)
		if(!pk) {
			return
		}

		const typeName = inflection.upperCamelCase(`${ogModel.name}Id`)
		const ogFields = ogModel.getFields()
		const newFields = pk.attributes.reduce((map, attr) => {
			const fieldName = inflection.attribute({
				attributeName: attr,
				codec: resource.codec
			})

			map[fieldName] = { type: ogFields[fieldName].type }
			return map
		}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
		return new GraphQLObjectType({ name: typeName, fields: newFields })
	}
}


function createSubscriptionPlan(
	resource: _PgResource,
	kind: 'insert' | 'delete' | 'update'
) {
	const { codec: { extensions: { pg: pgInfo } = {} } } = resource
	if(!pgInfo) {
		throw new Error(`Resource ${resource.name} does not have pg info`)
	}

	const plan: PlanResolver = (parent, args) => {
		return withPgClientTransaction(resource.executor, parent, async client => {
			const { rows } = await client.query({
				text: `INSERT INTO postgraphile_meta.subscriptions(topic,conditions_input)
					VALUES(
						postgraphile_meta.get_topic_from_change_json(
							jsonb_object(
								ARRAY['schema', 'table', 'kind'],
								ARRAY[$1, $2, $3]::text[]
							)
						),
						$4::jsonb
					)
					RETURNING id, topic`,
				values: [pgInfo.schemaName, pgInfo.name, kind, '{}']
			})

			console.log('row ', rows)
			throw new Error('LOL')
		})
	}

	return plan
}

// export const SubscriptionsPlugin: GraphileConfig.Plugin = makeExtendSchemaPlugin(build => {
// 	return {
// 		typeDefs: gql`
// 		extend type Subscription {
// 			demo: DemoPayload
// 		}

// 		type DemoPayload {
// 			value: Int
// 		}
// 		`,
// 		objects: {
// 			Subscription: {
// 				plans: {
// 					demo: {
// 						subscriptionPlan(...args) {
// 							console.log('Demo subscription plan args:', args)
// 						},
// 						plan(parent) {
// 							return parent
// 						}
// 					}
// 				}
// 			},
// 			DemoPayload: {
// 				plans: {
// 					value($event) {
// 						return constant(1)
// 					},
// 				},
// 			},
// 		}
// 	}
// })
// SubscriptionsPlugin.schema!.hooks!.GraphQLSchema = graphQLSchemaHook

export const SubscriptionsPlugin: GraphileConfig.Plugin = {
	name: 'SubscriptionsPlugin',
	schema: {
		hooks: {
			GraphQLSchema: graphQLSchemaHook
		}
	}
}