export type PGEntityCtx<T> = {
	tableName: string
	propertyColumnMap: { [k in keyof T]: string }
	idProperties: (keyof T)[]
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
 * Inserts the following entities into Postgres. When there are
 * lots of entities, it'll use the COPY command to insert them. Otherwise,
 * it'll use the INSERT command.
 *
 * @param onConflict If specified, will update the specified
 *  columns of the entity if there is a conflict. If undefined, it'll
 *  skip the entity if there is a conflict.
 *
 * @returns number of rows affected
 */
export async function insertData<T>(
	entities: T[],
	client: SimplePgClient,
	onConflict: ConflictHandlingOpts<T> | undefined,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>,
) {
	// if(entities.length > 1_000) {
	// 	return copyData(entities, client, onConflict, ctx)
	// }

	return _insertData(entities, client, onConflict, returningColumns, ctx)
}

/**
 * Uses the COPY command to copy entities to a table.
 * Ensure this is executed within a transaction -- as multiple
 * SQL commands are executed.
 *
 * COPY is way faster than INSERT for large datasets.
 * See: https://www.timescale.com/learn/testing-postgres-ingest-insert-vs-batch-insert-vs-copy
 *
 * You can benchmark yourself too
 */
// async function copyData<T>(
// 	entities: T[],
// 	client: SimplePgClient,
// 	onConflict: ConflictHandlingOpts,
// 	ctx: PGEntityCtx
// ) {
// 	const { tableName, propertyColumnMap } = ctx
// 	// To resolve conflicts, we create a tmp table
// 	// and copy data to it first. Then we copy data
// 	// from the tmp table to the main table.
// 	// see: https://stackoverflow.com/questions/48019381/how-postgresql-copy-to-stdin-with-csv-do-on-conflic-do-update
// 	const tmpTableName = `tmp_${tableName}`
// 	await client.query(`
// 		CREATE TEMP TABLE ${tmpTableName} (LIKE ${tableName} INCLUDING DEFAULTS)
// 		ON COMMIT DROP;
// 	  `)

// 	const propetyColumnList = Object.entries(propertyColumnMap)
// 	const columnListStr = propetyColumnList.map(c => `"${c[1]}"`).join(',')
// 	// Execute COPY FROM STDIN
// 	const query = `
// 		COPY ${tmpTableName} (${columnListStr})
// 		FROM STDIN
// 		WITH (FORMAT text, DELIMITER E'\\t', DEFAULT '_D_');
// 	`

// 	const pgStream = client.query(copyFrom(query))
// 	const stream = new Readable({ objectMode: true, read() {} })
// 	stream.pipe(pgStream)

// 	for(const [index, entity] of entities.entries()) {
// 		const values = propetyColumnList
// 			.map(([prop]) => mapValueForCopy(entity[prop]))
// 		stream.push(
// 			values.join('\t')
// 			+ (index < entities.length - 1 ? '\n' : '')
// 		)
// 	}

// 	stream.push(null)

// 	await new Promise<void>((resolve, reject) => {
// 		pgStream.on('finish', () => resolve())
// 		pgStream.on('error', reject)
// 	})

// 	// finally copy data from temp table to main table
// 	const conflictHandle
// 		= getConflictHandlingClauseForProps(onConflict, ctx)
// 	const rslt = await client.query(`
// 		INSERT INTO ${tableName} (${columnListStr})
// 		SELECT ${columnListStr} FROM ${tmpTableName}
// 		${conflictHandle}
// 	`)

// 	// drop the temp table
// 	await client.query(`DROP TABLE ${tmpTableName}`)

// 	return rslt.rowCount
// }

/**
 * Inserts the following entities into Postgres. This is
 * safe to execute for all sizes of data. It'll automatically
 * trim to the max number of parameters allowed by Postgres.
 */
function _insertData<T>(
	data: T[],
	client: SimplePgClient,
	onConflict: ConflictHandlingOpts<T> | undefined,
	returningColumns: (keyof T)[] | undefined,
	ctx: PGEntityCtx<T>
) {
	const { tableName, propertyColumnMap } = ctx
	const returningColumnsStr = returningColumns
		? `RETURNING ${returningColumns.map(c => `"${propertyColumnMap[c]}"`).join(',')}`
		: ''
	// find all columns that need to be inserted
	const columnsToInsert = new Set<string>()
	for(const entity of data) {
		for(const prop in entity) {
			if(prop in propertyColumnMap) {
				columnsToInsert.add(propertyColumnMap[prop])
			}
		}
	}

	const columnsToInsertStr = Array.from(columnsToInsert)
		.map(c => `"${c}"`)
		.join(',')

	const conflictHandle
		= getConflictHandlingClauseForProps(onConflict, ctx)
	return executePgParameteredQuery(
		data,
		Array.from(columnsToInsert) as (keyof T)[],
		valuePlaceholders => {
			const placeholders = valuePlaceholders
				.map(p => `(${p.join(',')})`)
			return `
			INSERT INTO ${tableName} (${columnsToInsertStr})
			VALUES ${placeholders.join(',')}
			${conflictHandle}
			${returningColumnsStr}
			`
		},
		client
	)
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

function getConflictHandlingClauseForProps<T>(
	onConflict: ConflictHandlingOpts<T> | undefined,
	{ propertyColumnMap, idProperties }: PGEntityCtx<T>
) {
	if(!onConflict) {
		return ''
	}

	if(onConflict.type === 'ignore') {
		return 'ON CONFLICT DO NOTHING'
	}

	const updateCols: string[] = []
	const propsToUpdate = onConflict.type === 'update'
		? onConflict.properties
		: Object.keys(propertyColumnMap) as (keyof T)[]

	for(const prop of propsToUpdate) {
		if(idProperties.includes(prop)) {
			continue
		}

		const col = propertyColumnMap[prop]
		updateCols.push(`"${col}" = EXCLUDED."${col}"`)
	}

	const idCols = idProperties
		.map(p => `"${propertyColumnMap[p]}"`)
		.join(',')
	return `ON CONFLICT (${idCols}) DO UPDATE SET ${updateCols}`
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

function mapValueForCopy(value: any) {
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