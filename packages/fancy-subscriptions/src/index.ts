import { getInputConditionForResource, getRelationFieldName } from '@haathie/graphile-common-utils'
import { hostname } from 'os'
import { Pool } from 'pg'
import type {} from 'postgraphile'
import type { PgCodecWithAttributes, PgResource, PgResourceUnique } from 'postgraphile/@dataplan/pg'
import type { } from 'postgraphile/adaptors/pg'
import { AccessStep, type FieldPlanResolver, loadMany, Step } from 'postgraphile/grafast'
import { type GraphQLFieldConfig, type GraphQLFieldExtensions, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'
import { CreateSubscriptionStep } from './CreateSubscriptionStep.ts'
import { LDSSource, type PgChangeData, type PgChangeOp } from './lds.ts'
import { PgWhereBuilder } from './PgWhereBuilder.ts'

type _PgResource = PgResource<string, PgCodecWithAttributes, PgResourceUnique[], any>

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLObjectType_fields']

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

	namespace GraphileBuild {
		interface BehaviorStrings {
			'subscribable': true
		}
	}
}

let subSrc: LDSSource

const graphQLSchemaHook: Hook = (subFields, build, ctx) => {
	if(!ctx.scope.isRootSubscription) {
		return subFields
	}

	const { allPgCodecs, inflection, behavior } = build
	const subs: GraphQLObjectTypeConfig<any, any>['fields'] = {}

	for(const _codec of allPgCodecs) {
		if(!_codec.extensions?.isTableLike || !_codec.attributes) {
			continue
		}

		const codec = _codec as PgCodecWithAttributes
		const resource = build.pgTableResource(codec) as _PgResource
		if(!behavior.pgCodecMatches(codec, 'subscribable')) {
			continue // not subscribable
		}

		const pgInfo = codec.extensions?.pg
		if(!pgInfo) {
			continue // no pg info, cannot subscribe
		}

		subSrc.tablePatterns.push(`${pgInfo.schemaName}.${pgInfo.name}`)

		const model = build
			.getGraphQLTypeByPgCodec(codec, 'output') as GraphQLObjectType
		if(!model) {
			continue // no model, cannot subscribe
		}

		const pkType = getPkType(resource, model)
		if(!pkType) {
			continue // no model, cannot subscribe
		}

		const conditionArg = getInputConditionForResource(resource, build)
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

		const subsArgs = { 'condition': { type: conditionArg } }

		subs[createdEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(pureType))),
			args: subsArgs,
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
			args: subsArgs,
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
			},
		})

		subs[updatedEvName] = {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateObj))),
			args: subsArgs,
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

	Object.assign(subFields, subs)

	return subFields

	function getPkType(resource: _PgResource, ogModel: GraphQLObjectType) {
		const pk = resource.uniques.find(u => u.isPrimary)
		if(!pk) {
			return
		}

		const typeName = inflection.upperCamelCase(`${ogModel.name}Key`)
		const ogFields = ogModel.getFields()

		// if the NodeID plugin is enabled, we'll use that
		const nodeIdFieldName = inflection.nodeIdFieldName()
		const nodeIdField = ogFields[nodeIdFieldName]

		let newFields: { [fieldName: string]: GraphQLFieldConfig<any, any> } = {}
		if(nodeIdField) {
			newFields = {
				[nodeIdFieldName]: {
					type: nodeIdField.type,
					extensions: nodeIdField.extensions
				}
			}
		} else {
			newFields = pk.attributes.reduce((map, attr) => {
				const fieldName = inflection.attribute({
					attributeName: attr,
					codec: resource.codec
				})
				const { type, extensions } = ogFields[fieldName]

				map[fieldName] = { type, extensions }
				return map
			}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
		}

		return new GraphQLObjectType({ name: typeName, fields: newFields })
	}

	function getPureType(resource: _PgResource, ogModel: GraphQLObjectType) {
		const typeName = inflection.upperCamelCase(`pure_${ogModel.name}`)
		const ogFields = ogModel.getFields()
		const relationFieldNames = Object.keys(resource.getRelations())
			.map(name => getRelationFieldName(name, resource, build))
		const fieldToAttrMap = buildFieldToAttrMap(resource)

		const newFields = Object.entries(ogFields)
			.reduce((map, [fieldName, field]) => {
				// we'll skip all relations
				if(relationFieldNames.includes(fieldName)) {
					return map
				}

				const { type, extensions } = field
				const attrName = fieldToAttrMap[fieldName]
				map[fieldName] = {
					type,
					extensions: attrName
						? wrapWithSetAccess(
							extensions,
							fieldToAttrMap[fieldName],
							fieldName
						)
						: extensions
				}
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

	function buildFieldToAttrMap(resource: _PgResource) {
		const map: Record<string, string> = {}
		for(const attrName in resource.codec.attributes) {
			const fieldName = inflection.attribute({
				codec: resource.codec,
				attributeName: attrName
			})
			map[fieldName] = attrName
		}

		return map
	}
}

function wrapWithSetAccess(
	extensions: GraphQLFieldExtensions<any, any> | undefined,
	attributeName: string,
	fieldName: string
): GraphQLFieldExtensions<any, any> {
	const ogPlan = extensions?.grafast?.plan
	return {
		grafast: {
			...extensions?.grafast,
			plan: (parent: Step, args, info) => {
				const steps = parent.operationPlan
					.getStepsByStepClass(CreateSubscriptionStep)
				for(const step of steps) {
					step.diffOnlyFields.add(attributeName)
				}

				if(ogPlan) {
					return ogPlan(parent, args, info)
				}

				if(!(parent instanceof AccessStep)) {
					throw new Error(
						'Expected parent to be an AccessStep, but got: ' +
						`${parent.constructor.name} for field ${fieldName}`
					)
				}

				return parent.get(fieldName)
			}
		}
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
		return new CreateSubscriptionStep(
			resource, subSrc, kind, $whereBuilder, $argsRaw
		)
	}

	return plan
}

export const FancySubscriptionsPlugin: GraphileConfig.Plugin = {
	name: 'FancySubscriptionsPlugin',
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
					tablePatterns: [],
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
			'GraphQLObjectType_fields': graphQLSchemaHook,
		}
	},
}

function getCleanedDeviceId(deviceId: string) {
	// Remove any non-alphanumeric characters and convert to lowercase
	return deviceId.replace(/[^a-z0-9\_]/gi, '').toLowerCase()
}