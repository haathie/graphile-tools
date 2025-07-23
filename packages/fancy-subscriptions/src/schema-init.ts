import { buildFieldNameToAttrNameMap } from '@haathie/postgraphile-common-utils'
import type { GrafastFieldConfig, Step } from 'postgraphile/grafast'
import type { GraphQLFieldConfig, GraphQLFieldExtensions, GraphQLObjectType } from 'postgraphile/graphql'
import { CreateSubscriptionStep } from './CreateSubscriptionStep.ts'
import { LDSSource, type PgChangeEvent } from './lds.ts'
import type { PgTableResource } from './types.ts'
import { isSubscribable } from './utils.ts'

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['init']

export const schemaInitHook: Hook = (init, build) => {
	const subSrc = LDSSource.current
	const { input: { pgRegistry: { pgResources } }, inflection } = build

	for(const resource of Object.values(pgResources)) {
		if(!isSubscribable(resource, build)) {
			continue
		}

		const pgInfo = resource.codec.extensions!.pg!

		subSrc.tablePatterns.push(`${pgInfo.schemaName}.${pgInfo.name}`)

		registerPkType(resource, build)

		registerPureType(resource, build)

		registerPartialType(inflection.pureTypeName(resource), build)

		registerCreateType(resource, build)

		registerDeleteType(resource, build)

		registerUpdateType(resource, build)
	}

	return init
}

function registerCreateType(
	resource: PgTableResource,
	build: GraphileBuild.Build
) {
	const {
		inflection,
		graphql: { GraphQLNonNull, GraphQLList },
		grafast: { loadMany },
		registerObjectType,
		getTypeByName
	} = build

	registerObjectType(
		inflection.subscriptionTypeName(resource, 'created'),
		{
			subscriptionType: 'created',
			pgTypeResource: resource,
		},
		() => ({
			description: `Created ${resource.name} items`,
			fields: () => {
				const createdType =	getTypeByName(
					inflection.pureTypeName(resource)
				)! as GraphQLObjectType
				return {
					eventId: createEventIdField(build),
					items: {
						type: new GraphQLNonNull(
							new GraphQLList(new GraphQLNonNull(createdType))
						),
						description: `New ${resource.name} items created`,
						plan(parent: Step<PgChangeEvent>) {
							return loadMany(parent, (values) => (
								values.map(v => v.items.map(v => v.row_data))
							))
						}
					}
				}
			}
		}),
		`${resource.name} - created subscription type`
	)
}

function registerDeleteType(
	resource: PgTableResource,
	build: GraphileBuild.Build
) {
	const {
		inflection,
		graphql: { GraphQLNonNull, GraphQLList },
		grafast: { loadMany },
		registerObjectType,
		getTypeByName
	} = build

	registerObjectType(
		inflection.subscriptionTypeName(resource, 'deleted'),
		{
			subscriptionType: 'deleted',
			pgTypeResource: resource,
		},
		() => ({
			description: `Deleted ${resource.name} items`,
			fields: () => {
				const pkType =	getTypeByName(
					inflection.primaryKeyTypeName(resource)
				)! as GraphQLObjectType
				return {
					eventId: createEventIdField(build),
					items: {
						type: new GraphQLNonNull(
							new GraphQLList(new GraphQLNonNull(pkType))
						),
						description: `The ${resource.name} items that were deleted`,
						plan(parent: Step<PgChangeEvent>) {
							return loadMany(parent, (values) => (
								values.map(({ items }) => items.map(v => v.row_data))
							))
						}
					}
				}
			}
		}),
		`${resource.name} - delete subscription type`
	)
}

function registerUpdateType(
	resource: PgTableResource,
	build: GraphileBuild.Build
) {
	const {
		inflection,
		graphql: { GraphQLNonNull, GraphQLList },
		grafast: { loadMany },
		registerObjectType,
		getTypeByName
	} = build

	registerObjectType(
		inflection.subscriptionUpdateObjectTypeName(resource),
		{ isSubscriptionUpdateObjectType: true },
		() => ({
			fields: () => {
				const pkType = getTypeByName(
					inflection.primaryKeyTypeName(resource)
				)! as GraphQLObjectType
				const partialType = getTypeByName(
					inflection.partialTypeName(
						inflection.pureTypeName(resource)
					)
				) as GraphQLObjectType
				return {
					key: { type: new GraphQLNonNull(pkType) },
					patch: { type: new GraphQLNonNull(partialType) }
				}
			}
		}),
		`${resource.name} - update subscription object type`
	)

	registerObjectType(
		inflection.subscriptionTypeName(resource, 'updated'),
		{
			subscriptionType: 'updated',
			pgTypeResource: resource,
		},
		() => ({
			description: `Updated ${resource.name} items`,
			fields: () => {
				const updatedType = getTypeByName(
					inflection.subscriptionUpdateObjectTypeName(resource)
				)! as GraphQLObjectType
				return {
					eventId: createEventIdField(build),
					items: {
						type: new GraphQLNonNull(
							new GraphQLList(new GraphQLNonNull(updatedType))
						),
						description: `The ${resource.name} items that were updated`,
						plan(parent: Step<PgChangeEvent>) {
							return loadMany(parent, (values) => (
								values.map(v => (
									v.items.map(v => ({ key: v.row_before!, patch: v.diff! }))
								))
							))
						}
					}
				}
			}
		}),
		`${resource.name} - updated subscription type`
	)
}

function registerPkType(
	resource: PgTableResource,
	build: GraphileBuild.Build,
) {
	const { inflection, registerObjectType } = build
	const pk = resource.uniques.find(u => u.isPrimary)
	if(!pk) {
		return
	}

	registerObjectType(
		inflection.primaryKeyTypeName(resource),
		{
			isPrimaryKeyType: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Unique identifier for ${resource.name} items`,
			fields: () => {
				const model = build
					.getGraphQLTypeByPgCodec(resource.codec, 'output') as GraphQLObjectType
				if(!model) {
					throw new Error(
						`No model found for resource ${resource.name}, cannot create PK type`
					)
				}

				const ogFields = model.getFields()

				// if the NodeID plugin is enabled, we'll use that
				const nodeIdFieldName = inflection.nodeIdFieldName?.()
				const nodeIdField = ogFields[nodeIdFieldName]

				const fieldMap = pk.attributes.reduce((map, attr) => {
					const fieldName = inflection.attribute({
						attributeName: attr,
						codec: resource.codec
					})
					const { type, extensions, description } = ogFields[fieldName]

					map[fieldName] = { type, extensions, description }
					return map
				}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })

				if(nodeIdField) {
					fieldMap[nodeIdFieldName] = {
						type: nodeIdField.type,
						extensions: nodeIdField.extensions,
						description: nodeIdField.description
					}
				}

				return fieldMap
			}
		}),
		`${resource.name} - primary key`
	)
}

function registerPureType(
	resource: PgTableResource,
	build: GraphileBuild.Build,
) {
	const { inflection, registerObjectType, getGraphQLTypeByPgCodec } = build
	const fieldToAttrMap
		= buildFieldNameToAttrNameMap(resource.codec, inflection)!

	registerObjectType(
		inflection.pureTypeName(resource),
		{
			isPureType: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Pure ${resource.name} type, without any relations`,
			fields: () => {
				const ogModel
					= getGraphQLTypeByPgCodec(resource.codec, 'output') as GraphQLObjectType
				if(!ogModel) {
					throw new Error(
						`No model found for resource ${resource.name}, cannot create pure type`
					)
				}

				const ogFields = ogModel.getFields()
				return Object.entries(ogFields).reduce((map, [fieldName, field]) => {
					// we'll skip all relations
					const attrName = typeof fieldToAttrMap[fieldName] === 'string'
						? fieldToAttrMap[fieldName]
						: fieldToAttrMap[fieldName]?.[0]
					if(
						!attrName
						// we'll allow the nodeId field to be present
						&& fieldName !== inflection.nodeIdFieldName?.()
					) {
						return map
					}

					const { type, extensions } = field
					map[fieldName] = {
						type,
						extensions: attrName
							? wrapWithSetAccess(extensions, attrName, fieldName, build)
							: extensions
					}
					return map
				}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
			}
		}),
		`${resource.name} - pure type`
	)
}

function registerPartialType(
	typeName: string,
	{
		inflection,
		graphql: { GraphQLNonNull },
		registerObjectType,
		getTypeByName
	}: GraphileBuild.Build,
) {
	registerObjectType(
		inflection.partialTypeName(typeName),
		{ isPartialType: true },
		() => ({
			description: `Partial type for ${typeName}`,
			fields: () => {
				const model = getTypeByName(typeName) as GraphQLObjectType
				if(!model) {
					throw new Error(
						`No model found for type ${typeName}, cannot create partial type`
					)
				}

				return Object.entries(model.getFields()).reduce((map, [name, field]) => {
					map[name] = {
						type: field.type instanceof GraphQLNonNull
							? field.type.ofType
							: field.type,
						extensions: field.extensions
					}
					return map
				}, {} as { [fieldName: string]: GraphQLFieldConfig<any, any> })
			}
		}),
		'partial - ' + typeName
	)
}

function createEventIdField(
	{
		graphql: { GraphQLNonNull, GraphQLString },
		grafast: { lambda },
	}: GraphileBuild.Build
): GrafastFieldConfig<any, any> {
	return {
		type: new GraphQLNonNull(GraphQLString),
		description: 'ID of the event',
		plan(parent: Step<PgChangeEvent>) {
			return lambda(parent, p => p.eventId)
		}
	}
}

function wrapWithSetAccess(
	extensions: GraphQLFieldExtensions<any, any> | undefined,
	attributeName: string,
	fieldName: string,
	{ grafast: { AccessStep, LoadedRecordStep } }: GraphileBuild.Build
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

				if(parent instanceof AccessStep || parent instanceof LoadedRecordStep) {
					return parent.get(fieldName)
				}

				throw new Error(
					'Expected parent to be an AccessStep/LoadedRecordStep, but got: ' +
					`${parent.constructor.name} for field ${fieldName}`
				)
			}
		}
	}
}