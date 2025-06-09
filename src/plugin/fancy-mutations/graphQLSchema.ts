import { type GraphQLFieldConfig, GraphQLInputObjectType, GraphQLList, GraphQLObjectType, type GraphQLObjectTypeConfig } from 'graphql'
import { listOfCodec, type PgClient, type PgCodecWithAttributes, PgResource, recordCodec, TYPES, withPgClientTransaction } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, object, sideEffect, type Step } from 'postgraphile/grafast'
import { sql } from 'postgraphile/pg-sql2'
import { insertData, type SimplePgClient } from './pg-utils.ts'

const MAX_BULK_MUTATION_LENGTH = 100

type Hook = NonNullable<
	NonNullable<
		GraphileConfig.Plugin['schema']
	>['hooks']
>['GraphQLSchema']

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
				inflection.upperCamelCase(`insert_${codec.name}`)
			] = obj
			delete existingFields[inflection.createField(table)]
		}
	}

	const newMutations
		= new GraphQLObjectType({ name: 'Mutations', fields: mutations })
	Object.assign(existingFields, newMutations.getFields())
	return config
}

type CreateMutationOpts = {
	table: PgResource<string, PgCodecWithAttributes>
	build: GraphileBuild.Build
}

type GrafastPlanParams = Parameters<FieldPlanResolver<any, any, any>>

type MutationInput<T = any> = { items: T[] }

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

	const pkeyColumnsJoined = sql
		.join(primaryKey.attributes.map(a => sql.identifier(a)), ',')
	const propToColumnMap: Record<string, string> = {}
	const primaryKeyNames: string[] = []
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
	const inputObj = new GraphQLInputObjectType({
		name: inflection.upperCamelCase(`${codec.name}InsertItem`),
		fields: Object.entries(_inputObj.getFields()).reduce(
			(acc, [fieldName, field]) => {
				acc[fieldName] = field
				return acc
			},
			{} as Record<string, any>
		)
	})

	return {
		description: `Insert one or more ${inflection.pluralize(codec.name)}`,
		args: {
			'input': {
				type: new GraphQLInputObjectType({
					name: inflection.upperCamelCase(`${codec.name}Insert`),
					fields: { items: { type: new GraphQLList(inputObj) } }
				})
			}
		},
		// we'll just return an object containing all the inserted
		// items, i.e. { items: T[] }
		// Using an object, in case more fields are added in the future,
		// so it won't break anything
		type: new GraphQLObjectType({
			name: inflection.upperCamelCase(`${codec.name}InsertPayload`),
			fields: { items: { type: new GraphQLList(_outputObj) } }
		}),
		extensions: { grafast: { plan } }
	}

	function plan(...[, args]: GrafastPlanParams) {
		sideEffect(args.getRaw(['input', 'items']), items => {
			if(!items.length) {
				throw new Error('Must have at least 1 mutation')
			}

			if(items.length > MAX_BULK_MUTATION_LENGTH) {
				throw new Error(`Must have at most ${MAX_BULK_MUTATION_LENGTH} mutations`)
			}
		})

		const $args = args.getRaw(['input']) as Step
		const $tx = withPgClientTransaction(executor, $args, executeAsync)
		const $items = table.find()
		$items.join(
			{
				type: 'inner',
				from: sql`unnest(${$items.placeholder($tx, listOfCodec(TYPES.jsonb), true)}) WITH ORDINALITY`,
				alias: sql`items(data, ord)`,
				conditions: primaryKey.attributes.map(a => (
					sql`${$items.alias}.${sql.identifier(a)} = items.data->>'${sql.raw(a)}'`
				))
			}
		)
		// order by the ordinal position
		// so that the items are returned in the same order as they were inserted
		$items.orderBy({
			fragment: sql`items.ord`,
			codec: TYPES.int,
			direction: 'ASC'
		})
		$items.setOrderIsUnique()

		return object({ items: $items })
	}

	async function executeAsync(
		client: PgClient,
		{ items }: MutationInput
	): Promise<any[]> {
		const { rows } = await insertData(
			items,
			mapToSimplePgClient(client),
			undefined,
			primaryKeyNames,
			{
				tableName: fqTableName,
				propertyColumnMap: propToColumnMap,
				idProperties: primaryKeyNames
			}
		)

		return rows
	}
}

function mapToSimplePgClient(client: PgClient): SimplePgClient {
	return {
		async query(query, params) {
			const rslt = await client.query({ text: query, values: params })
			return { rows: rslt.rows, rowCount: rslt.rowCount || 0 }
		},
	}
}