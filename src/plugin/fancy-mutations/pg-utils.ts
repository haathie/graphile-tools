export type PGEntityCtx<T> = {
	tableName: string
	propertyColumnMap: { [k in keyof T]: string }
	idProperties: (keyof T)[]
	uniques: { columns: (keyof T)[] }[]
}

type QueryResult = {
	rowCount: number
	rows: readonly unknown[]
}

export type SimplePgClient = {
	query(query: string, params?: unknown[]): Promise<QueryResult>
}

type BulkUpdateEntity<T> = {
	id: T
	update: Partial<T>
}

/**
 * Defines how to handle conflicts when inserting data
 */
type ConflictHandlingOpts<T> = {
	/**
	 * "replace" will replace the full entity if there is a conflict.
	 * "ignore" will skip the entity if there is a conflict.
	 */
	type: 'replace' | 'ignore'
} | {
	/**
	 * "update" will update the specified properties of the entity, in
	 * case of a conflict.
	 */
	type: 'update'
	properties: (keyof T)[]
}

const PG_MAX_PARAMS = 32_000

/**
 * Inserts the following entities into Postgres.
 *
 * @param onConflict If specified, will update the specified
 *  columns of the entity if there is a conflict. If undefined, it'll
 *  skip the entity if there is a conflict.
 */
export async function insertData<T>(
	entities: T[],
	client: SimplePgClient,
	onConflict: ConflictHandlingOpts<T> | undefined,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>,
) {
	// simple insert if there are no conflict handling options
	switch (onConflict?.type) {
	// when replacing, we want to be careful to only replace the columns
	// that the entity has. If entity[0] has properties a, b, c
	// and entity[1] has properties a, b, d, then we want to replace
	// a, b, c for the first entity and a, b, d for the second entity.
	case 'replace':
		const buckets = Object.values(
			bucketEntitiesByProperties(entities, ctx)
		)
		const rslts = await Promise.all(buckets.map(
			(bucket) => _mergeData(bucket, client, onConflict, returningColumns, ctx)
		))
		return sortAndMergeResultsByBuckets(buckets, entities, rslts)
	case 'update':
	case 'ignore':
		return _mergeData(entities, client, onConflict, returningColumns, ctx)
	case undefined:
		return _insertDataSimple(entities, client, returningColumns, ctx)
	default:
		throw new Error(`Unknown conflict handling type: ${onConflict}`)
	}
}

/**
 * Inserts the following entities into Postgres. This is
 * safe to execute for all sizes of data. It'll automatically
 * trim to the max number of parameters allowed by Postgres.
 */
async function _mergeData<T>(
	data: T[],
	client: SimplePgClient,
	onConflict: ConflictHandlingOpts<T>,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>
) {
	const { tableName, propertyColumnMap, uniques } = ctx
	const tmpTableName = getTmpTableName(tableName)
		+ '_'
		+ Math.random().toString(36).slice(2)
	const propsToInsert = getUsedProperties(data, ctx)
	const propsToUpdate = onConflict.type === 'update'
		? onConflict.properties
		: onConflict.type === 'replace'
			? propsToInsert
			: undefined
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
	let updateStr = propsToUpdate
		?.map(c => `"${propertyColumnMap[c]}" = i."${propertyColumnMap[c]}"`)
		?.join(',')
	if(!updateStr) {
		const firstProp = propertyColumnMap[propsToInsert[0]]
		updateStr = `${firstProp} = t."${firstProp}"`
	}

	const returningColumnsStr = returningColumns?.length
		? `RETURNING
				merge_action() as action,
				${returningColumns.map(c => `t."${propertyColumnMap[c]}"`).join(',')}`
		: ''
	const matchClauseStr = uniques
		.map(u => (
			u.columns.reduce((acc, p) => {
				const col = propertyColumnMap[p]
				return acc + (acc ? ' AND ' : '') + `t."${col}" = i."${col}"`
			}, '')
		))
		.map(c => `(${c})`)
		.join(' OR ')
	const mergeQuery = `WITH inserted AS (
		INSERT INTO ${tmpTableName} (${columnsToInsertStr})
		VALUES ???
		RETURNING *
	)
	MERGE INTO ${tableName} AS t
	USING inserted AS i
	ON ${matchClauseStr}
	WHEN MATCHED THEN
		UPDATE SET ${updateStr}
	WHEN NOT MATCHED THEN
		INSERT (${columnsToInsertStr})
		VALUES (${propsToInsert.map(c => `i."${propertyColumnMap[c]}"`).join(',')})
	${returningColumnsStr}
	`

	await client.query(
		`CREATE TEMP TABLE ${tmpTableName}
		(LIKE ${tableName} INCLUDING DEFAULTS) ON COMMIT DROP;`
	)
	const rslt = await executePgParameteredQuery(
		data,
		propsToInsert,
		valuePlaceholders => {
			const placeholders = valuePlaceholders.map(p => `(${p.join(',')})`)
			return mergeQuery.replace('???', placeholders.join(','))
		},
		client
	)
	await client.query(`DROP TABLE ${tmpTableName};`)

	if(returningColumnsStr && rslt.rows.length !== data.length) {
		throw new Error(
			`INTERNAL(_mergeData): ${rslt.rows.length} rows `
			+ `returned, expected ${data.length}`
		)
	}

	return rslt
}

/**
 * Inserts the following entities into Postgres. This is
 * safe to execute for all sizes of data. It'll automatically
 * trim to the max number of parameters allowed by Postgres.
 */
function _insertDataSimple<T>(
	data: T[],
	client: SimplePgClient,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>
) {
	const { tableName, propertyColumnMap } = ctx
	const propsToInsert = getUsedProperties(data, ctx)
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
	const returningColumnsStr = returningColumns
		? `RETURNING ${returningColumns.map(c => `"${propertyColumnMap[c]}"`).join(',')}`
		: ''
	return executePgParameteredQuery(
		data,
		propsToInsert,
		valuePlaceholders => {
			const placeholders = valuePlaceholders
				.map(p => `(${p.join(',')})`)
			return `
			INSERT INTO ${tableName} (${columnsToInsertStr})
			VALUES ${placeholders.join(',')}
			${returningColumnsStr}
			`
		},
		client
	)
}

function bucketEntitiesByProperties<T>(entities: T[], ctx: PGEntityCtx<T>) {
	const buckets: { [key: string]: T[] } = {}
	for(const entity of entities) {
		const usedProperties = getUsedProperties([entity], ctx)
		const key = usedProperties.join(',')
		buckets[key] ||= []
		buckets[key].push(entity)
	}

	return buckets
}

function sortAndMergeResultsByBuckets<T>(
	buckets: T[][],
	entities: T[],
	results: QueryResult[]
) {
	let rowCount = 0
	const rows: unknown[] = []
	const entityToIndexMap = new Map<T, number>()
	for(const [index, entity] of entities.entries()) {
		entityToIndexMap.set(entity, index)
	}

	for(const [bucketIndex, bucket] of buckets.entries()) {
		const result = results[bucketIndex]
		rowCount += result.rowCount
		if(!result.rows.length) {
			continue
		}

		for(const [index, row] of result.rows.entries()) {
			const entity = bucket[index]
			const entityIndex = entityToIndexMap.get(entity)
			// Ensure the row is in the same order as the original entities
			rows[entityIndex!] = row
		}
	}

	return { rowCount, rows }
}

function getUsedProperties<T>(
	entities: T[], { propertyColumnMap }: PGEntityCtx<T>
): (keyof T)[] {
	const usedProperties = new Set<keyof T>()
	for(const entity of entities) {
		for(const prop in entity) {
			if(typeof entity[prop] !== 'undefined' && propertyColumnMap[prop]) {
				usedProperties.add(prop as keyof T)
			}
		}
	}

	return Array.from(usedProperties)
}

/**
 * Bulk remove the following entities from Postgres. It'll
 * automatically trim to the max number of parameters allowed
 */
export function deleteData<T>(
	data: T[],
	client: SimplePgClient,
	{ tableName, idProperties, propertyColumnMap }: PGEntityCtx<T>
) {
	const idTuple = idProperties
		.map(p => `"${propertyColumnMap[p]}"`)
		.join(',')
	return executePgParameteredQuery(
		data,
		idProperties,
		placeholders => {
			const joined = placeholders
				.map(p => `(${p.join(',')})`)
				.join(',')
			return `
			DELETE FROM "${tableName}"
			WHERE (${idTuple}) IN (VALUES ${joined})
			`
		},
		client
	)
}

/**
 * Bulk update the following entities in Postgres. It'll group
 * together updates that have the same properties to update and
 * execute them in a single query.
 */
export async function updateData<T>(
	objects: BulkUpdateEntity<T>[],
	client: SimplePgClient,
	ctx: PGEntityCtx<T>
) {
	if(!objects.length) {
		return
	}

	const updateMap: { [key: string]: T[] } = {}
	for(const { id, update } of objects) {
		let updatedColsStr = ''
		for(const key in update) {
			if(update[key] !== undefined) {
				updatedColsStr += key + ','
			}
		}

		if(!updatedColsStr) {
			continue
		}

		updateMap[updatedColsStr] ||= []
		updateMap[updatedColsStr].push({ ...id, ...update })
	}

	await Promise.all(
		Object.entries(updateMap).map(async([updatedColsStr, bulkUpdates]) => (
			updateDataSpecific(
				bulkUpdates,
				// remove last comma (as we added an extra one in the loop)
				updatedColsStr.split(',').slice(0, -1) as (keyof T)[],
				client,
				ctx
			)
		))
	)
}

/**
 * Bulk update the specfied properties "propertiesToUpdate" of the
 * provided entities.
 */
async function updateDataSpecific<T>(
	objects: T[],
	propertiesToUpdate: (keyof T)[],
	client: SimplePgClient,
	{ tableName, idProperties, propertyColumnMap }: PGEntityCtx<T>
) {
	const allProperties = [...idProperties, ...propertiesToUpdate]
	const props = propertiesToUpdate
		.map(p => `"${propertyColumnMap[p]}" = u."${propertyColumnMap[p]}"`)
		.join(',')
	const allCols = allProperties
		.map(p => `"${propertyColumnMap[p]}"`)
		.join(',')
	const idMatch = idProperties
		.map(p => `t."${propertyColumnMap[p]}" = u."${propertyColumnMap[p]}"`)
		.join(' AND ')

	return executePgParameteredQuery(
		objects,
		allProperties,
		valuePlaceholders => {
			const values = valuePlaceholders
				.map(p => `(${p.join(',')})`)
				.join(',')
			return `
			UPDATE "${tableName}" AS t
			SET ${props} FROM (VALUES ${values}) AS u(${allCols})
			WHERE ${idMatch}
			`
		},
		client
	)
}

async function executePgParameteredQuery<T>(
	data: T[],
	propertiesToExtract: (keyof T)[],
	buildQuery: (valuePlaceholders: string[][]) => string,
	client: SimplePgClient
) {
	const queries = buildPgParameteredQuery(
		data,
		propertiesToExtract,
		buildQuery
	)

	const results = await Promise.all(queries.map(([q, p]) => client.query(q, p)))
	let rowCount = 0
	const rows: unknown[] = []
	for(const r of results) {
		rowCount += r.rowCount
		rows.push(...r.rows)
	}

	return { rowCount, rows }
}

/**
 * Safely builds a parametered query for Postgres. Ensures
 * the number of parameters doesn't exceed the maximum allowed.
 *
 * It'll go through each "entity", extract the properties specified
 * and add them as a parameter. Whenever the threshold is reached,
 * or there are no more entities, it'll build a query via the provided
 * "buildQuery" function.
 */
function buildPgParameteredQuery<T>(
	data: T[],
	propertiesToExtract: (keyof T)[],
	buildQuery: (valuePlaceholders: string[][]) => string
) {
	const queries: [string, unknown[]][] = []

	// Generate the parameterized query placeholders
	let values: unknown[] = []
	let valuePlaceholders: string[][] = []

	for(const row of data) {
		if(values.length + propertiesToExtract.length >= PG_MAX_PARAMS) {
			flush()
		}

		const placeholders = propertiesToExtract.map(prop => {
			const value = mapValueForPg(row[prop])
			if(value === null) {
				return 'NULL'
			}

			if(value === undefined) {
				return 'DEFAULT'
			}

			values.push(value)
			return `$${values.length}`
		})
		valuePlaceholders.push(placeholders)
	}

	flush()

	return queries

	function flush() {
		if(!valuePlaceholders.length) {
			return
		}

		queries.push([buildQuery(valuePlaceholders), values])
		values = []
		valuePlaceholders = []
	}
}

function mapValueForPg(value: unknown) {
	if(value instanceof Date) {
		return value.toJSON()
	}

	if(value instanceof Buffer || value instanceof Uint8Array) {
		throw new Error('TODO')
	}

	if(Array.isArray(value)) {
		return `{${value.map(mapValueForCopy).join(',')}}`
	}

	if(typeof value === 'object' && value) {
		value = JSON.stringify(value)
	}

	return value
}

function mapValueForCopy(value: unknown) {
	if(value === null) {
		return '\\N'
	}

	if(value === undefined) {
		return '_D_'
	}

	value = mapValueForPg(value)
	if(typeof value === 'string') {
		return value.replaceAll('\t', '\\t').replaceAll('\n', '\\n')
	}

	return value
}

function getTmpTableName(tableName: string) {
	// Create an acceptable temporary table name
	// (i.e. remove quotes, special characters, etc.)
	return tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() + '_tmp'
}