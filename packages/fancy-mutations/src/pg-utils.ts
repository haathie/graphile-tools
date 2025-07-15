export type PGEntityCtx<T> = {
	tableName: string
	propertyColumnMap: { [k in keyof T]: string }
	idProperties: (keyof T)[]
	uniques: { columns: (keyof T)[] }[]
}

type InsertQueryResult = {
	rowCount: number
	affectedCount: number
	rows?: readonly unknown[]
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
		return _mergeData(entities, client, onConflict, returningColumns, ctx)
	case 'ignore':
		// if we ignore, we can just insert the data and ignore errors
		return _insertDataOrDoNothing(entities, client, returningColumns, ctx)
	case undefined:
		return _insertDataSimple(entities, client, returningColumns, ctx)
	default:
		throw new Error(`Unknown conflict handling type: ${onConflict}`)
	}
}

async function _insertDataOrDoNothing<T>(
	data: T[],
	client: SimplePgClient,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>
): Promise<InsertQueryResult> {
	const { tableName, propertyColumnMap, uniques } = ctx
	const tmpTableName = getTmpTableNameRand(tableName)
	const propsToInsert = getUsedProperties(data, ctx)
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
		.join(',')
	const matchClauseStr = uniques
		.map(u => (
			u.columns.reduce((acc, p) => {
				const col = propertyColumnMap[p]
				return acc + (acc ? ' AND ' : '') + `t."${col}" = i."${col}"`
			}, '')
		))
		.map(c => `(${c})`)
		.join(' OR ')
	const returningColumnsStr = returningColumns
		?.map(c => `t."${propertyColumnMap[c]}"`).join(',')

	// we'll match all possible unique constraints
	// and get the "returning" columns of the existing entities
	let query = `
	WITH inserted0 AS (
		INSERT INTO ${tmpTableName} (${columnsToInsertStr})
		VALUES ???
		RETURNING *
	),
	inserted_rn AS (
		SELECT *, row_number() over () AS rn FROM inserted0
	),
	existing AS (
		SELECT ${returningColumnsStr || '1'}, i.rn
		FROM ${tableName} AS t
		INNER JOIN inserted_rn AS i ON ${matchClauseStr}
	),
	inserts AS (
		MERGE INTO ${tableName} AS t
		USING inserted_rn AS i
		ON ${matchClauseStr}
		WHEN MATCHED THEN
			DO NOTHING
		WHEN NOT MATCHED THEN
			INSERT (${columnsToInsertStr})
			VALUES (${propsToInsert.map(c => `i."${propertyColumnMap[c]}"`).join(',')})
		RETURNING ${returningColumnsStr || '1'}, i.rn
	)
	`
	if(returningColumnsStr) {
		query += `SELECT *, 'inserted' AS "row_action" FROM inserts
	UNION ALL
	SELECT *, 'existing' AS "row_action" FROM existing
	ORDER BY rn`
	} else {
		query += 'SELECT (SELECT COUNT(*) FROM inserted_rn) AS "total_count"'
			+ ', (SELECT COUNT(*) FROM inserts) AS "inserted_count"'
	}

	await client.query(
		`CREATE TEMP TABLE ${tmpTableName}
		(LIKE ${tableName} INCLUDING DEFAULTS) ON COMMIT DROP;`
	)
	const rslt = await executePgParameteredQuery(
		data,
		propsToInsert,
		valuePlaceholders => {
			const placeholders = valuePlaceholders.map(p => `(${p.join(',')})`)
			return query.replace('???', placeholders.join(','))
		},
		client
	)

	if(returningColumnsStr) {
		return {
			rowCount: rslt.rowCount,
			affectedCount: rslt.rows
				.filter((r: any) => r['row_action'] === 'inserted').length,
			rows: rslt.rows
		}
	}

	const countData = rslt
		.rows[0] as { total_count: number, inserted_count: number }
	return {
		rowCount: +countData.total_count,
		affectedCount: +countData.inserted_count,
		rows: undefined
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
): Promise<InsertQueryResult> {
	const { tableName, propertyColumnMap, uniques } = ctx
	const tmpTableName = getTmpTableNameRand(tableName)
	const propsToInsert = getUsedProperties(data, ctx)
	const propsToUpdate = onConflict.type === 'update'
		? onConflict.properties
		: propsToInsert
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
	const updateStr = propsToUpdate
		.map(c => `"${propertyColumnMap[c]}" = i."${propertyColumnMap[c]}"`)
		.join(',')

	const returningColumnsStr = returningColumns?.length
		? `RETURNING
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

	let query = `WITH items AS (
		INSERT INTO ${tmpTableName} (${columnsToInsertStr})
		VALUES ???
		RETURNING *
	),
	items_rn AS (
		SELECT *, row_number() over () AS rn FROM items
	),
	updated AS (
		UPDATE ${tableName} AS t
		SET ${updateStr}
		FROM items_rn AS i
		WHERE ${matchClauseStr}
		${returningColumnsStr || '1'}, i.rn
	),
	inserted AS (
		MERGE INTO ${tableName} AS t
		USING items_rn AS i
		ON ${matchClauseStr}
		WHEN MATCHED THEN
			DO NOTHING
		WHEN NOT MATCHED THEN
			INSERT (${columnsToInsertStr})
			VALUES (${propsToInsert.map(c => `i."${propertyColumnMap[c]}"`).join(',')})
		${returningColumnsStr || '1'}, i.rn
	)
	`
	if(returningColumnsStr) {
		query += `SELECT *, 'UPDATE' AS "row_action" FROM updated
		UNION ALL
		SELECT *, 'INSERT' AS "row_action" FROM inserted
		ORDER BY rn`
	} else {
		query += 'SELECT (SELECT COUNT(*) FROM updated) AS "updated_count"'
			+ ', (SELECT COUNT(*) FROM inserted) AS "inserted_count"'
	}

	await client.query(
		`CREATE TEMP TABLE ${tmpTableName}
		(LIKE ${tableName} INCLUDING DEFAULTS) ON COMMIT DROP;`
	)
	const rslt = await executePgParameteredQuery(
		data,
		propsToInsert,
		valuePlaceholders => {
			const placeholders = valuePlaceholders.map(p => `(${p.join(',')})`)
			return query.replace('???', placeholders.join(','))
		},
		client
	)

	if(returningColumnsStr) {
		return {
			rowCount: rslt.rowCount,
			affectedCount: rslt.rowCount,
			rows: rslt.rows
		}
	}

	const countData = rslt
		.rows[0] as { updated_count: number, inserted_count: number }
	const rowCount = +countData.updated_count + +countData.inserted_count
	return { rowCount: rowCount, affectedCount: rowCount }
}

/**
 * Inserts the following entities into Postgres. This is
 * safe to execute for all sizes of data. It'll automatically
 * trim to the max number of parameters allowed by Postgres.
 */
async function _insertDataSimple<T>(
	data: T[],
	client: SimplePgClient,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>,
): Promise<InsertQueryResult> {
	const { tableName, propertyColumnMap } = ctx
	const propsToInsert = getUsedProperties(data, ctx)
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
	const returningColumnsStr = returningColumns
		? `RETURNING ${returningColumns.map(c => `"${propertyColumnMap[c]}"`).join(',')}`
		: ''
	const rslt = await executePgParameteredQuery(
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

	return {
		rowCount: rslt.rowCount,
		affectedCount: rslt.rowCount,
		rows: returningColumnsStr ? rslt.rows : undefined
	}
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
	results: InsertQueryResult[]
) {
	let rowCount = 0
	let affectedCount = 0
	const rows: unknown[] = []
	const entityToIndexMap = new Map<T, number>()
	for(const [index, entity] of entities.entries()) {
		entityToIndexMap.set(entity, index)
	}

	for(const [bucketIndex, bucket] of buckets.entries()) {
		const result = results[bucketIndex]
		rowCount += result.rowCount
		affectedCount += result.affectedCount
		if(!result.rows?.length) {
			continue
		}

		for(const [index, row] of result.rows.entries()) {
			const entity = bucket[index]
			const entityIndex = entityToIndexMap.get(entity)
			// Ensure the row is in the same order as the original entities
			rows[entityIndex!] = row
		}
	}

	return { rowCount, affectedCount, rows }
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

function getTmpTableNameRand(tableName: string) {
	return getTmpTableName(tableName)
		+ '_'
		+ Math.random().toString(36).slice(2)
}

function getTmpTableName(tableName: string) {
	// Create an acceptable temporary table name
	// (i.e. remove quotes, special characters, etc.)
	return tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() + '_tmp'
}