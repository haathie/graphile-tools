import { type GraphQLFieldConfig, type GraphQLInputFieldConfig, GraphQLInputObjectType, type GraphQLInputObjectTypeConfig, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'
import type { QueryResult } from 'pg'
import { type PgClient, type PgCodecWithAttributes, PgResource, TYPES, withPgClientTransaction } from 'postgraphile/@dataplan/pg'
import { type FieldPlanResolver, lambda, sideEffect, type Step } from 'postgraphile/grafast'
import { GraphQLEnumType } from 'postgraphile/graphql'
import { sql } from 'postgraphile/pg-sql2'
import { insertData, type SimplePgClient } from './pg-utils.ts'
import { executeNestedMutations, getRelationFieldName } from './utils.ts'

const MAX_BULK_MUTATION_LENGTH = 100

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

export function createInsertObject(
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

	const pkeyColumnsJoined = sql.join(
		primaryKey.attributes.map(a => (
			sql`${sql.identifier(a)} ${codec.attributes[a].codec.sqlType}`
		)),
		','
	)
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

	const _outputObj = build
		.getGraphQLTypeByPgCodec(codec, 'output') as GraphQLObjectType
	if(!_outputObj) {
		return
	}

	// the individual item that'll be used for the mutation
	const inputObj = new GraphQLNonNull(new GraphQLInputObjectType({
		name: inflection.upperCamelCase(`${codec.name}CreateItem`),
		fields: getFieldsForInsert(table, build)
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
		const rslt = await executeNestedMutations({
			items,
			root: table,
			build,
			async mutate(items, resource, ctx) {
				let _onConflict = onConflict
				if(_onConflict === 'replace' && !resource.extensions?.canUpdate) {
					_onConflict = 'ignore'
				}

				const rslt = await insertData(
					items,
					mapToSimplePgClient(client),
					_onConflict === 'error' ? undefined : { type: _onConflict },
					ctx.idProperties,
					ctx
				)
				return rslt.rows
			},
		})
		return rslt
	}
}

function getFieldsForInsert(
	table: PgResource<string, PgCodecWithAttributes>,
	build: GraphileBuild.Build
) {
	const { inflection } = build
	return buildFieldsWithRelations(
		table,
		build,
		(table, relationPath, resource) => {
			const inputItemName = inflection.upperCamelCase(
				`${relationPath.join('_')}_CreateItem`
			)
			const _inputObj = build.getGraphQLTypeByPgCodec(
				resource.codec, 'input'
			) as GraphQLInputObjectType
			if(!_inputObj) {
				return
			}

			return {
				name: inputItemName,
				fields: { ..._inputObj.getFields() },
			}
		}
	)
}

function buildFieldsWithRelations(
	table: PgResource<string, PgCodecWithAttributes>,
	build: GraphileBuild.Build,
	getInputObject: (
		path: PgResource<string, PgCodecWithAttributes>,
		relationPath: string[],
		resource: PgResource
	) => GraphQLInputObjectTypeConfig | undefined,
	path: string[] = []
) {
	const { inflection, pgTableResource } = build
	const obj = getInputObject(table, [], table)
	if(!obj) {
		return {}
	}

	const fields = obj.fields as { [_: string]: GraphQLInputFieldConfig }

	for(const [
		relationName, relation
	] of Object.entries(table.getRelations())) {
		const {
			remoteResource, isUnique, isReferencee, remoteAttributes,
			localAttributes
		} = relation
		const relationCodec = remoteResource.codec as PgCodecWithAttributes
		const relationTable = pgTableResource(relationCodec)
		if(!relationTable) {
			continue
		}

		// avoid circular references, check either we've traversed this relation
		// or its inverse relation
		if(path.some(r => r === relationName || relationTable.getRelation(r))) {
			continue
		}

		const isMulti = !isUnique
		const relName = getRelationFieldName(relationName, table, build)
		const newPath = [...path, relationName]
		const inputObjConfig = getInputObject(table, newPath, remoteResource)
		if(!inputObjConfig) {
			continue
		}

		inputObjConfig.fields = buildFieldsWithRelations(
			relationTable, build, getInputObject, newPath
		)

		// we'll remove the relation field from the input object if required
		if(isReferencee && Array.isArray(remoteAttributes)) {
			for(const column of remoteAttributes) {
				const attrName = inflection
					.attribute({ codec: relationCodec, attributeName: column })
				delete inputObjConfig.fields[attrName]
			}
		}

		// also make all columns in the input object optional
		for(const column of localAttributes || []) {
			const attrName = inflection
				.attribute({ codec: table.codec, attributeName: column })
			const field = fields[attrName]
			if(!field) {
				continue
			}

			if(field.type instanceof GraphQLNonNull) {
				fields[attrName] = { ...field, type: field.type.ofType }
			}
		}

		const inputObj = new GraphQLInputObjectType(inputObjConfig)
		fields[relName] = {
			type: isMulti ? new GraphQLList(new GraphQLNonNull(inputObj)) : inputObj,
		}
	}

	return fields
}

function getRowCountPlan(...[plan]: GrafastPlanParams<Step<QueryResult>>) {
	return lambda(plan, r => r.rowCount || 0)
}

function mapToSimplePgClient(client: PgClient): SimplePgClient {
	return {
		async query(query, params) {
			console.log('Executing query:', query, params)
			const rslt = await client.query({ text: query, values: params })
			return { rows: rslt.rows, rowCount: rslt.rowCount || 0 }
		},
	}
}