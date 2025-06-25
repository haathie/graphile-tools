import { hostname } from 'os'
import { Pool } from 'pg'
import { type PgCodecWithAttributes, type PgResource, type PgResourceUnique, withPgClientTransaction } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, lambda, listen, loadMany, Step } from 'postgraphile/grafast'
import { type GraphQLFieldConfig, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'postgraphile/graphql'
import { type SQL, sql } from 'postgraphile/pg-sql2'
import { LDSSource, type PgChangeData, type PgChangeOp } from './lds.ts'
import { PgWhereBuilder } from './PgWhereBuilder.ts'

type _PgResource = PgResource<string, PgCodecWithAttributes, PgResourceUnique[], any>

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

	for(const _codec of allPgCodecs) {
		if(!_codec.extensions?.isTableLike || !_codec.attributes) {
			continue
		}

		const codec = _codec as PgCodecWithAttributes
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

		const queryType = build.getTypeByName('Query') as GraphQLObjectType
		if(!queryType) {
			continue
		}

		const queryFieldName = inflection
			.customQueryConnectionField({ resource })
		const queryField = queryType.getFields()[queryFieldName]
		if(!queryField) {
			continue
		}

		const conditionArg = queryField.args
			.find(a => a.name === 'condition')
			?.type as GraphQLInputObjectType
		if(!conditionArg) {
			continue
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
			args: {
				'condition': { type: conditionArg }
			},
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

	const newSubs = new GraphQLObjectType({ name: 'Subscriptions', fields: subs })
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
	kind: PgChangeOp
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
		const $sqlAndRaw = lambda([$whereBuilder, $argsRaw], ([cond, args]) => {
			return { cond, args }
		})

		const $subId = withPgClientTransaction(resource.executor, $sqlAndRaw, async(client, { cond, args }) => {
			const sampleJson = '{}'
			const compiledSql = cond
				? sql.compile(
					sql`select 1
						from jsonb_populate_record(
							null::${resource.from as SQL},
							${sql.value(sampleJson)}::jsonb
						) ${alias} WHERE ${cond}`
				)
				: undefined
			const [text, values] = subSrc.getCreateSubscriptionSql(
				{
					topic: {
						schema: pgInfo.schemaName,
						table: pgInfo.name,
						kind
					},
					conditionsSql: compiledSql?.text,
					// 1st param is just a placeholder
					conditionsParams: compiledSql?.values?.slice(1),
					type: 'websocket',
					additionalData: {
						inputCondition: args?.condition,
					}
				}
			)
			const { rows: [row] } = await client
				.query<{ id: string, topic: string }>({ text, values })

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