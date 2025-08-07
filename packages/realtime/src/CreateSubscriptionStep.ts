import { type PgCodecWithAttributes, type PgResource } from 'postgraphile/@dataplan/pg'
import { type ExecutionDetails, type ExecutionResults, Step } from 'postgraphile/grafast'
import { type SQL, sql } from 'postgraphile/pg-sql2'
import { type PgChangeOp, SubscriptionManager } from './manager.ts'
import { PgWhereBuilder } from './PgWhereBuilder.ts'
import { DEBUG } from './utils.ts'

export class CreateSubscriptionStep extends Step<any> {

	/**
	 * This set is used to track which roles have been granted
	 * access to the subscriptions table so they can manage their
	 * subscriptions.
	*/
	static #accessGivenSet = new Set<string>()

	#resource: PgResource
	#subSrc: SubscriptionManager
	#kind: PgChangeOp

	#contextDepId: number
	#whereBuilderDepId: number
	#inputArgsDepId: number

	diffOnlyFields = new Set<string>()

	constructor(
		resource: PgResource,
		subSrc: SubscriptionManager,
		kind: PgChangeOp,
		conditionWhereBuilder: PgWhereBuilder,
		inputArgs: Step<any>
	) {
		super()
		this.isSyncAndSafe = false
		this.hasSideEffects = true

		this.#resource = resource
		this.#subSrc = subSrc
		this.#kind = kind

		this.#contextDepId = this.addUnaryDependency(resource.executor.context())
		this.#whereBuilderDepId = this.addDependency(conditionWhereBuilder)
		this.#inputArgsDepId = this.addDependency(inputArgs)
	}

	execute({ indexMap, values, stream }: ExecutionDetails): ExecutionResults<any> {
		if(!stream) {
			throw new Error(
				'CreateSubscriptionStep must be executed in a streaming context'
			)
		}

		const {	withPgClient, pgSettings } = values[this.#contextDepId]
			.unaryValue() as Grafast.Context

		return indexMap(async(i) => {
			const cond = values[this.#whereBuilderDepId].at(i) as SQL | undefined
			const args = values[this.#inputArgsDepId].at(i)
			const compiledSql = cond
				? sql.compile(cond)
				: undefined
			const pgInfo = this.#resource.codec.extensions?.pg!

			const conditionsSql = compiledSql
				? replaceSqlWithJsonConversions(
					replaceParamsWithConditionParams(compiledSql.text),
					't',
					this.#resource.codec as PgCodecWithAttributes
				)
				: undefined

			const [text, params] = this.#subSrc.getCreateSubscriptionSql(
				{
					topic: {
						schema: pgInfo.schemaName,
						table: pgInfo.name,
						kind: this.#kind
					},
					conditionsSql,
					// 1st param is just a placeholder
					conditionsParams: compiledSql?.values,
					type: 'websocket',
					additionalData: { inputCondition: args?.condition },
					diffOnlyFields: this.#kind === 'UPDATE'
						? Array.from(this.diffOnlyFields)
						: undefined,
				}
			)

			if(
				pgSettings?.role
				&& !CreateSubscriptionStep.#accessGivenSet.has(pgSettings.role)
			) {
				await this.#subSrc.pool.query({
					text: ACCESS_DDL.replaceAll('<username>', pgSettings.role)
				})

				DEBUG(`Granted access to ${pgSettings.role}`)

				CreateSubscriptionStep.#accessGivenSet.add(pgSettings.role)
			}

			const { rows: [row] } = await withPgClient(pgSettings, async client => (
				client.query<{ id: string, topic: string }>({ text, values: params })
			))

			DEBUG(
				`Created subscription ${row.id}, on topic ${row.topic}`
				+ (
					this.#kind === 'UPDATE'
						? `, fields: ${Array.from(this.diffOnlyFields).join(',') || 'all'}`
						: ''
				)
			)
			return this.#subSrc.subscribe(row.id, true)
		})
	}
}

/**
 * When using subscriptions, we don't have the actual SQL type of the record
 * so we convert the JSONB values to the expected SQL type.
 * Eg. the normal query 't."some_field" = $1::varchar' would become
 * "((e->'row_data'->'some_field')::varchar) = $1::varchar"
 */
function replaceSqlWithJsonConversions(
	sql: string,
	sqlAlias: string,
	codec: PgCodecWithAttributes
) {
	return sql.replace(
		new RegExp(`${sqlAlias}\\."([^"]+)"`, 'gm'),
		(value, attr) => {
			const attrCodec = codec.attributes[attr]
			if(!attrCodec) {
				throw new Error(`Attribute ${attr} not found in codec`)
			}

			const sqlType = 'varchar' //attrCodec.codec.sqlType
			return `((e.row_data->>'${attr}')::${sqlType})`
		}
	)
}

/**
 * In subscriptions, params passed to the sql are stored in the
 * "conditions_params" column as an array.
 * This function replaces the params in the SQL with the actual values
 * from the "conditions_params" column.
 * Eg. the normal query 't."some_field" = $1::varchar' would
 * become "t."some_field" = (s.conditions_params[1])::varchar"
 * where 0 is the index of the param in the array.
 */
function replaceParamsWithConditionParams(sql: string) {
	return sql
		.replace(/\$([0-9]+)/gm, (_, index) => `(s.conditions_params[${index}])`)
}

const ACCESS_DDL = `
BEGIN;
GRANT USAGE, CREATE ON SCHEMA postg_realtime TO "<username>";
GRANT
	SELECT,
	INSERT(
		topic,
		type,
		additional_data,
		conditions_sql,
		conditions_params,
		is_temporary,
		diff_only_fields
	),
	DELETE
ON postg_realtime.subscriptions TO "<username>";
COMMIT;`