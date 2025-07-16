export type PGEntityCtx<T> = {
	tableName: string
	propertyColumnMap: { [k in keyof T]: string }
	idProperties: (keyof T)[]
	uniques: { columns: (keyof T)[] }[]
}

type ObjectRow = { [_: string]: unknown }

type InsertRow<T = ObjectRow> = T & {
	rn: number
	row_action: 'INSERT' | 'EXISTING' | 'DUPLICATE' | 'UPDATE'
}

type InsertQueryResult<T = ObjectRow> = {
	rowCount: number
	affectedCount: number
	rows?: readonly InsertRow<T>[]
}

type QueryResult = {
	rowCount: number
	rows: readonly unknown[]
}

export type SimplePgClient = {
	query(query: string, params?: unknown[]): Promise<QueryResult>
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
			(bucket) => _deDuplicatedMerge(
				bucket, client, returningColumns, onConflict, ctx
			)
		))
		return sortAndMergeResultsByBuckets(buckets, entities, rslts)
	case 'update':
	case 'ignore':
		return _deDuplicatedMerge(entities, client, returningColumns, onConflict, ctx)
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
	const rslt = await executePgParameteredQuery<T, ObjectRow>(
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
		rows: returningColumnsStr
			? rslt.rows.map((r, i): InsertRow => (
				{ ...r, 'row_action': 'INSERT', rn: i + 1 }
			))
			: undefined
	}
}

async function _deDuplicatedMerge<T>(
	data: T[],
	client: SimplePgClient,
	returningColumns: (keyof T)[] | undefined,
	onConflict: { type: 'ignore' | 'replace' }
		| { type: 'update', properties: (keyof T)[] },
	ctx: PGEntityCtx<T>,
): Promise<InsertQueryResult> {
	const { tableName, propertyColumnMap } = ctx
	const tmpTableName = getTmpTableNameRand(tableName)
	const propsToInsert = getUsedProperties(data, ctx)
	const columnsToInsertStr = propsToInsert
		.map(c => `"${propertyColumnMap[c]}"`)
		.join(',')
	const returningColumnsStr = returningColumns
		?.map(c => `t."${propertyColumnMap[c]}"`).join(',')

	const propsToUpdate = onConflict.type === 'update'
		? onConflict.properties
		: (onConflict.type === 'replace' ? propsToInsert : undefined)
	const updateStr = propsToUpdate
		?.map(c => `"${propertyColumnMap[c]}" = i."${propertyColumnMap[c]}"`)
		.join(',')
	const whenMatchedClause = updateStr
		? `WHEN MATCHED THEN
			UPDATE SET ${updateStr}`
		: undefined

	const {
		sql: dedupeSql, dupMatchClause
	} = getDeDuplicatedRowBuilder(propsToInsert, ctx)

	// we'll match all possible unique constraints
	// and get the "returning" columns of the existing entities
	let query = `
	${dedupeSql},
	inserted_rows AS (
		MERGE INTO ${tableName} AS t
		USING rows_to_insert_deduped AS i
		ON ${dupMatchClause}
		${whenMatchedClause || ''}
		WHEN NOT MATCHED THEN
			INSERT (${columnsToInsertStr})
			VALUES (${propsToInsert.map(c => `i."${propertyColumnMap[c]}"`).join(',')})
		RETURNING ${returningColumnsStr || '1'}, i.rn, i.dups, merge_action() as "merge_action"
	)
	`
	if(returningColumnsStr) {
		query += `,
		inserts AS (
			SELECT
				${returningColumnsStr},
				i.rn,
				(
					CASE WHEN i.rn = t.dups[1]
					THEN t.merge_action
					ELSE 'DUPLICATE'
					END
				) as "row_action"
			FROM rows_to_insert_rn AS i
			INNER JOIN inserted_rows AS t ON i.rn = ANY(t.dups)
		)`
		if(onConflict.type === 'ignore') {
			query += `SELECT * FROM inserts
			UNION ALL
			(
				SELECT ${returningColumnsStr}, i.rn, 'EXISTING' as "row_action"
				FROM ${tableName} AS t
				INNER JOIN rows_to_insert_deduped AS i
					ON (${dupMatchClause}) AND i.rn NOT IN (SELECT rn FROM inserts)
			)
			ORDER BY rn`
		} else {
			query += 'SELECT * FROM inserts ORDER BY rn'
		}
	} else {
		query += 'SELECT (SELECT COUNT(*) FROM rows_to_insert_rn) AS "total_count"'
			+ ', (SELECT COUNT(*) FROM inserted_rows) AS "inserted_count"'
	}

	await client.query(
		`CREATE TEMP TABLE ${tmpTableName}
		(LIKE ${tableName} INCLUDING DEFAULTS) ON COMMIT DROP;`
	)
	const rslt = await executePgParameteredQuery<T, InsertRow>(
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
				.filter(r => (
					r['row_action'] === 'INSERT'
					|| r['row_action'] === 'UPDATE'
				)).length,
			rows: rslt.rows
		}
	}

	const countData = rslt
		.rows[0] as unknown as { total_count: string, inserted_count: string }
	return {
		rowCount: +countData.total_count,
		affectedCount: +countData.inserted_count,
		rows: undefined
	}
}

function getDeDuplicatedRowBuilder<T>(
	propsBeingInserted: (keyof T)[],
	{ propertyColumnMap, uniques }: PGEntityCtx<T>
) {
	const columnsToInsertStr = propsBeingInserted
		.map(c => `"${propertyColumnMap[c]}"`)
		.join(',')
	const dupMatches: string[] = []
	for(const { columns } of uniques) {
		const relevantProps = columns
			.filter(c => propsBeingInserted.includes(c))
		// if no properties are being inserted that match the unique constraint,
		// we can skip this unique constraint
		if(!relevantProps.length) {
			continue
		}

		const uqPropsStr = relevantProps
			.map(p => `i."${propertyColumnMap[p]}" = t."${propertyColumnMap[p]}"`)
			.join(' AND ')
		dupMatches.push(`(${uqPropsStr})`)
	}

	const dupMatchClause = dupMatches.length
		? dupMatches.join(' OR ')
		: undefined
	const dupMatchesStr = dupMatchClause
		? `(select array_agg(rn) from rows_to_insert_rn t where ${dupMatchClause}) as dups`
		: 'ARRAY[rn] as dups'

	return {
		sql: `WITH rows_to_insert_rn AS (
			SELECT *, row_number() over () as rn
			FROM (VALUES ???) AS t(${columnsToInsertStr})
		),
		rows_to_insert_dups AS (
			SELECT *, ${dupMatchesStr} FROM rows_to_insert_rn i
		),
		rows_to_insert_deduped AS (
			SELECT * FROM rows_to_insert_dups WHERE rn = dups[1]
		)`,
		dupMatchClause,
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

function sortAndMergeResultsByBuckets<T, R>(
	buckets: T[][],
	entities: T[],
	results: InsertQueryResult<R>[]
) {
	let rowCount = 0
	let affectedCount = 0
	const rows: InsertRow<R>[] = []
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

	return { rowCount, affectedCount, rows: rows.length ? rows : undefined }
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

async function executePgParameteredQuery<T, R = unknown>(
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
	const rows: R[] = []
	for(const r of results) {
		rowCount += r.rowCount
		rows.push(...r.rows as R[])
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