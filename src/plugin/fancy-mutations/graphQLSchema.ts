import { type GraphQLFieldConfig, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'graphql'
import type { QueryResult } from 'pg'
import { type PgClient, type PgCodecWithAttributes, PgResource, TYPES, withPgClientTransaction } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, lambda, sideEffect, type Step } from 'postgraphile/grafast'
import { GraphQLEnumType } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'
import { insertData, type SimplePgClient } from './pg-utils.ts'

const MAX_BULK_MUTATION_LENGTH = 100

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLSchema']

type CreateMutationOpts = {
	table: PgResource<string, PgCodecWithAttributes>
	build: GraphileBuild.Build
}

type GrafastPlanParams<T extends Step = Step> = Parameters<
	FieldPlanResolver<any, T, any>
>

type MutationInput<T = any> = {
	items: T[]
	onConflict?: 'ignore' | 'error' | 'replace'
}

const OnConflictOptions = new GraphQLEnumType({
	name: 'OnConflictOptions',
	values: {
		'DoNothing': { value: 'ignore' },
		'Error': { value: 'error' },
		'Replace': { value: 'replace' },
	}
})

export const graphQLSchemaHook: Hook = (
	config, build
) => {
	const { inflection, pgTableResource, allPgCodecs } = build
	const existingFields = config.mutation?.getFields() || {}
	const mutations: GraphQLObjectTypeConfig<any, any>['fields'] = {}
	for(const _codec of allPgCodecs) {
		const codec = _codec as PgCodecWithAttributes
		if(!codec.extensions?.isTableLike) {
			continue
		}

		const table = pgTableResource(codec)
		if(!table) {
			continue
		}

		const obj = createInsertObject({ table, build })
		if(obj) {
			mutations[
				inflection.upperCamelCase(`create_${codec.name}`)
			] = obj
			delete existingFields[inflection.createField(table)]
		}
	}

	const newMutations
		= new GraphQLObjectType({ name: 'Mutations', fields: mutations })
	Object.assign(existingFields, newMutations.getFields())
	return config
}

function createInsertObject(
	{ table, build }: CreateMutationOpts
): GraphQLFieldConfig<any, any> | undefined {
	const { codec } = table
	const { inflection } = build
	const executor = codec.executor!
	if(!executor) {
		// if we don't have an executor, we can't insert
		return
	}

	const primaryKey = table.uniques.find(u => u.isPrimary)!
	if(!primaryKey) {
		// if we don't have a primary key, we can't insert
		// because we won't be able to return the inserted item
		return
	}

	// if we can't insert, or the table just cannot insert
	if(!table.extensions?.canInsert || !table.extensions.isInsertable) {
		return
	}

	// table ID is the executor name + '.' + table name
	// so we remove the executor name from the identifier
	// to get the fully qualified table name
	// e.g. 'main.public.users' -> 'public.users'
	const fqTableName = table.identifier.slice(
		executor.name.length + 1
	)

	const pkeyColumnsJoined = sql.join(
		primaryKey.attributes.map(a => (
			sql`${sql.identifier(a)} ${codec.attributes[a].codec.sqlType}`
		)),
		','
	)
	const propToColumnMap: Record<string, string> = {}
	const primaryKeyNames: string[] = []
	const otherUniqueNames = table.uniques.map(u => {
		return {
			columns: u.attributes
				.map(a => inflection.attribute({ codec, attributeName: a }))
		}
	})
	for(const attributeName in codec.attributes) {
		const propname = inflection
			.attribute({ codec: table.codec, attributeName })
		propToColumnMap[propname] = attributeName
		if(primaryKey.attributes.includes(attributeName)) {
			primaryKeyNames.push(propname)
		}
	}

	const _inputObj = build
		.getGraphQLTypeByPgCodec(codec, 'input') as GraphQLObjectType
	const _outputObj = build
		.getGraphQLTypeByPgCodec(codec, 'output') as GraphQLObjectType
	if(!_inputObj || !_outputObj) {
		return
	}

	// the individual item that'll be used for the mutation
	const inputObj = new GraphQLNonNull(new GraphQLInputObjectType({
		name: inflection.upperCamelCase(`${codec.name}CreateItem`),
		fields: Object.entries(_inputObj.getFields()).reduce(
			(acc, [fieldName, field]) => {
				acc[fieldName] = field
				return acc
			},
			{} as Record<string, any>
		)
	}))

	return {
		description: `Create one or more ${inflection.pluralize(codec.name)}`,
		args: {
			'input': {
				type: new GraphQLInputObjectType({
					name: inflection.upperCamelCase(`${codec.name}Create`),
					fields: {
						onConflict: { type: OnConflictOptions },
						items: { type: new GraphQLNonNull(new GraphQLList(inputObj)) }
					}
				})
			}
		},
		// we'll just return an object containing all the inserted
		// items, i.e. { items: T[] }
		// Using an object, in case more fields are added in the future,
		// so it won't break anything
		type: new GraphQLObjectType({
			name: inflection.upperCamelCase(`${codec.name}CreatePayload`),
			fields: {
				items: {
					type: new GraphQLNonNull(new GraphQLList(_outputObj)),
					extensions: { grafast: { plan: getRowsPlan } }
				},
				affected: {
					type: new GraphQLNonNull(GraphQLInt),
					extensions: { grafast: { plan: getRowCountPlan } }
				}
			}
		}),
		extensions: { grafast: { plan: executeInsertPlan } }
	}

	function executeInsertPlan(...[, args]: GrafastPlanParams) {
		sideEffect(args.getRaw(['input', 'items']), items => {
			if(!items.length) {
				throw new Error('Must have at least 1 mutation')
			}

			if(items.length > MAX_BULK_MUTATION_LENGTH) {
				throw new Error(`Must have at most ${MAX_BULK_MUTATION_LENGTH} mutations`)
			}
		})

		const $args = args.getRaw('input') as Step
		const $tx = withPgClientTransaction(executor, $args, executeAsync)

		return $tx
	}

	function getRowsPlan(...[plan]: GrafastPlanParams<Step<QueryResult>>) {
		const $items = table.find()
		const $rowsParam = $items
			.placeholder(lambda(plan, r => JSON.stringify(r.rows)), TYPES.jsonb, true)
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

	async function executeAsync(
		client: PgClient,
		{ items, onConflict = 'error' }: MutationInput
	) {
		const rslt = await insertData(
			items,
			mapToSimplePgClient(client),
			onConflict === 'error'
				? undefined
				: { type: onConflict },
			primaryKeyNames,
			{
				tableName: fqTableName,
				propertyColumnMap: propToColumnMap,
				idProperties: primaryKeyNames,
				uniques: otherUniqueNames
			}
		)

		return rslt
	}
}

function getRowCountPlan(...[plan]: GrafastPlanParams<Step<QueryResult>>) {
	return lambda(plan, r => r.rowCount || 0)
}

function mapToSimplePgClient(client: PgClient): SimplePgClient {
	return {
		async query(query, params) {
			const rslt = await client.query({ text: query, values: params })
			return { rows: rslt.rows, rowCount: rslt.rowCount || 0 }
		},
	}
}