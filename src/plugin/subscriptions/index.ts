import { type PgCodecWithAttributes, type PgResource, withPgClientTransaction } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, listen, loadMany, type Step } from 'postgraphile/grafast'
import { type GraphQLFieldConfig, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'postgraphile/graphql'
import { LDSSource, type PgChangeData } from './lds.ts'
import { hostname } from 'os'
import { Pool } from 'pg'

type _PgResource = PgResource<string, PgCodecWithAttributes>

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLSchema']

type PlanResolver = FieldPlanResolver<any, any, any>

declare global {
	namespace GraphileConfig {
		interface Preset {
			subscriptions?: {
				deviceId: string
				publishChanges?: boolean
			}
		}
	}
}

let subSrc: LDSSource

const graphQLSchemaHook: Hook = (config, build) => {
	// todo: use behaviours to determine this
	subSrc.tablePattern = 'app.*'

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

		const pureType = getPureType(resource, model)
		const partialType = getPartialType(pureType)
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
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(pureType))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, subSrc, 'insert'),
					plan(parent: Step<PgChangeData[]>) {
						return loadMany(parent, (values) => (
							values.map(v => v.map(v => v.row_data))
						))
					}
				}
			}
		}
		subs[deletedEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(pkType))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, subSrc, 'delete'),
					plan(parent: Step<PgChangeData[]>) {
						return loadMany(parent, (values) => (
							values.map(v => v.map(v => v.row_data))
						))
					}
				}
			}
		}

		const updateObj = new GraphQLObjectType({
			name: inflection.upperCamelCase(`${model.name}Update`),
			fields: {
				key: { type: new GraphQLNonNull(pkType) },
				changes: { type: new GraphQLNonNull(partialType) }
			}
		})

		subs[updatedEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateObj))),
			extensions: {
				grafast: {
					subscribePlan: createSubscriptionPlan(resource, subSrc, 'update'),
					plan(parent: Step<PgChangeData[]>) {
						return loadMany(parent, (values) => (
							values.map(v => v.map(v => ({ key: v.row_before!, changes: v.diff! })))
						))
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
			const { type, extensions } = ogFields[fieldName]

			map[fieldName] = { type, extensions }
			return map
		}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
		return new GraphQLObjectType({ name: typeName, fields: newFields })
	}

	function getPureType(resource: _PgResource, ogModel: GraphQLObjectType) {
		const typeName = inflection.upperCamelCase(`pure_${ogModel.name}`)
		const ogFields = ogModel.getFields()
		const newFields = Object.keys(resource.codec.attributes)
			.reduce((map, attr) => {
				const fieldName = inflection.attribute({
					attributeName: attr,
					codec: resource.codec
				})
				const { type, extensions } = ogFields[fieldName]

				map[fieldName] = { type, extensions }
				return map
			}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
		return new GraphQLObjectType({ name: typeName, fields: newFields })
	}

	function getPartialType(model: GraphQLObjectType) {
		return new GraphQLObjectType({
			name: inflection.upperCamelCase(`partial_${model.name}`),
			fields: Object.entries(model.getFields()).reduce((map, [name, field]) => {

				map[name] = {
					type: field.type instanceof GraphQLNonNull
						? field.type.ofType
						: field.type,
					extensions: field.extensions
				}
				return map
			}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
		})
	}
}

function createSubscriptionPlan(
	resource: _PgResource,
	subSrc: LDSSource,
	kind: 'insert' | 'delete' | 'update'
) {
	const { codec: { extensions: { pg: pgInfo } = {} } } = resource
	if(!pgInfo) {
		throw new Error(`Resource ${resource.name} does not have pg info`)
	}

	const plan: PlanResolver = (parent) => {
		const $subId = withPgClientTransaction(resource.executor, parent, async client => {
			const { rows: [row] } = await client.query<{ id: string, topic: string }>({
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

			console.log(`created sub ${row.id}, on topic ${row.topic}`)

			return row.id
		})

		return listen(subSrc, $subId)
	}

	return plan
}

export const SubscriptionsPlugin: GraphileConfig.Plugin = {
	name: 'SubscriptionsPlugin',
	grafserv: {
		middleware: {
			async setPreset(
				next,
				{
					resolvedPreset: {
						pgServices = [],
						subscriptions: {
							deviceId,
							publishChanges
						} = {}
					}
				}
			) {
				if(subSrc) {
					return next()
				}

				if(!deviceId) {
					deviceId = getCleanedDeviceId(hostname())
					console.log(
						'No deviceId provided, using hostname as deviceId:',
						deviceId
					)
				}

				let superuserPool: Pool | undefined
				for(const service of pgServices) {
					superuserPool = service.adaptorSettings?.superuserPool
					if(!superuserPool) {
						continue
					}

					const { pgSettings, release } = service
					service.pgSettings = (...args) => {
						const settings = typeof pgSettings === 'function'
							? pgSettings?.(...args)
							: pgSettings || {}
						// ensure device_id is set
						settings['app.device_id'] = deviceId
						return settings
					}

					service.release = async(...args) => {
						console.log('Releasing subscriptions source...')
						await subSrc?.release()
						await release?.(...args)
						console.log('Subscriptions source released.')
					}

					break
				}

				if(!superuserPool) {
					throw new Error('No superuser pool found in preset.')
				}

				subSrc = new LDSSource({
					pool: superuserPool,
					// will populate later
					tablePattern: '',
					deviceId: deviceId,
				})
				await subSrc.listen()
				console.log('Subscriptions source initialized.')

				if(publishChanges) {
					await subSrc.startPublishChangeLoop()
					console.log('Publish change loop started.')
				}

				return next()
			}
		}
	},
	schema: {
		hooks: {
			GraphQLSchema: graphQLSchemaHook
		}
	},
}

function getCleanedDeviceId(deviceId: string) {
	// Remove any non-alphanumeric characters and convert to lowercase
	return deviceId.replace(/[^a-z0-9\_]/gi, '').toLowerCase()
}