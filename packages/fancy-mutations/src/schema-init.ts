import type { lambda } from 'postgraphile/grafast'
import type { GraphQLFieldConfig, GraphQLObjectType } from 'postgraphile/graphql'
import { PgCreateStep } from './PgCreateStep.ts'
import { PgSelectAndModify } from './PgSelectAndModify.js'
import type { GrafastPlanParams, PgTableResource } from './types.ts'
import { buildFieldsForCreate, isDeletable, isInsertable, isUpdatable } from './utils.ts'

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
		const isInsertableResource = isInsertable(build, resource)
		if(
			isDeletable(build, resource)
			|| isUpdatable(build, resource)
			|| isInsertableResource
		) {
			registerBulkMutationPayload(build, resource)
		}

		if(isInsertableResource) {
			registerCreateInputObject(build, resource)
		}
	}

	return config
}

function registerBulkMutationPayload(
	build: GraphileBuild.Build,
	resource: PgTableResource
) {
	const {
		inflection,
		grafast: { lambda },
		graphql: { GraphQLInt, GraphQLNonNull }
	} = build
	const payloadName = inflection.bulkMutationPayloadName(resource)

	build.registerObjectType(
		payloadName,
		{
			isBulkMutationPayloadObject: true,
			pgTypeResource: resource,
		},
		() => ({
			description: `Payload for the bulk create operation on ${resource.name}`,
			fields() {
				return {
					affected: {
						type: new GraphQLNonNull(GraphQLInt),
						extensions: { grafast: { plan: createRowCountPlan(lambda) } }
					},
					items: getOutputItems(resource, build),
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
	build: GraphileBuild.Build,
): GraphQLFieldConfig<unknown, unknown> {
	const {
		getGraphQLTypeByPgCodec,
		graphql: { GraphQLList, GraphQLNonNull }
	} = build
	const outputObj = getGraphQLTypeByPgCodec(
		resource.codec, 'output'
	) as GraphQLObjectType
	if(!outputObj) {
		throw new Error(`No output type for resource ${resource.name}`)
	}

	return {
		type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(outputObj))),
		extensions: { grafast: { plan: createSelectAffectedRowsPlan(build) } }
	}
}

function createSelectAffectedRowsPlan(build: GraphileBuild.Build) {
	const { sql, grafast: { lambda }, dataplanPg: { TYPES } } = build
	return (...[$plan]: GrafastPlanParams<PgCreateStep | PgSelectAndModify>) => {
		if($plan instanceof PgSelectAndModify) {
			return $plan
		}

		if(!($plan instanceof PgCreateStep)) {
			throw new Error(`Expected a PgCreateStep, got ${$plan}`)
		}

		$plan.selectPrimaryColumns = true

		const table = $plan.resource
		const primaryKey = table.uniques.find(u => u.isPrimary)!
		if(!primaryKey) {
			// if we don't have a primary key, we can't insert
			// because we won't be able to return the inserted item
			throw new Error(
				`No primary key for resource ${table.name}, cannot select`
			)
		}

		const pkeyColumnsJoined = sql.join(
			primaryKey.attributes.map(a => (
				sql`${sql.identifier(a)} ${table.codec.attributes[a].codec.sqlType}`
			)),
			','
		)

		const $items = table.find()
		const $rowsParam = $items
			.placeholder(lambda($plan, r => JSON.stringify(r.items)), TYPES.jsonb, true)
		$items.join(
			{
				type: 'inner',
				from: sql`ROWS FROM (
					jsonb_to_recordset(${$rowsParam})
					AS (${pkeyColumnsJoined})) WITH ORDINALITY`,
				alias: sql`items`,
				conditions: primaryKey.attributes.map(a => (
					sql`${$items.alias}.${sql.identifier(a)} = items.${sql.identifier(a)}`
				))
			}
		)
		// order by the ordinal position
		// so that the items are returned in the same order as they were inserted
		$items.orderBy({
			fragment: sql`items.ordinality`,
			codec: TYPES.int,
			direction: 'ASC'
		})
		$items.setOrderIsUnique()

		return $items
	}
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