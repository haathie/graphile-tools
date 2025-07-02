import { PgResource, type WithPgClient } from 'postgraphile/@dataplan/pg'
import { type ExecutionDetails, type ExecutionResults, Step } from 'postgraphile/grafast'
import { type SQL, sql } from 'postgraphile/pg-sql2'
import { LDSSource, type PgChangeOp } from './lds.ts'
import { PgWhereBuilder } from './PgWhereBuilder.ts'

export class CreateSubscriptionStep extends Step<any> {

	#resource: PgResource
	#subSrc: LDSSource
	#kind: PgChangeOp

	#contextDepId: number
	#whereBuilderDepId: number
	#inputArgsDepId: number

	diffOnlyFields = new Set<string>()

	constructor(
		resource: PgResource,
		subSrc: LDSSource,
		kind: PgChangeOp,
		conditionWhereBuilder: PgWhereBuilder,
		inputArgs: Step<any>,
		...moreSteps: Step<any>[]
	) {
		super()
		this.isSyncAndSafe = false
		this.hasSideEffects = true

		this.#resource = resource
		this.#subSrc = subSrc
		this.#kind = kind

		this.#contextDepId = this.addDependency(resource.executor.context())
		this.#whereBuilderDepId = this.addDependency(conditionWhereBuilder)
		this.#inputArgsDepId = this.addDependency(inputArgs)
		for(const step of moreSteps) {
			this.addDependency(step)
		}
	}

	execute({ indexMap, values, stream }: ExecutionDetails): ExecutionResults<any> {
		if(!stream) {
			throw new Error(
				'CreateSubscriptionStep must be executed in a streaming context'
			)
		}

		return indexMap(async(i) => {
			const cond = values[this.#whereBuilderDepId].at(i) as SQL | undefined
			const args = values[this.#inputArgsDepId].at(i)
			const {	withPgClient, pgSettings } = values[this.#contextDepId]
				.at(i) as { withPgClient: WithPgClient, pgSettings: {} }
			const sampleJson = '{}'
			const alias = sql`t`
			const compiledSql = cond
				? sql.compile(
					sql`select 1
						from jsonb_populate_record(
							null::${this.#resource.from as SQL},
							${sql.value(sampleJson)}::jsonb
						) ${alias} WHERE ${cond}`
				)
				: undefined
			const pgInfo = this.#resource.codec.extensions?.pg
			if(!pgInfo) {
				throw new Error(`Resource ${this.#resource.name} does not have pg info`)
			}

			const [text, params] = this.#subSrc.getCreateSubscriptionSql(
				{
					topic: {
						schema: pgInfo.schemaName,
						table: pgInfo.name,
						kind: this.#kind
					},
					conditionsSql: compiledSql?.text,
					// 1st param is just a placeholder
					conditionsParams: compiledSql?.values?.slice(1),
					type: 'websocket',
					additionalData: {
						inputCondition: args?.condition,
					},
					diffOnlyFields: this.#kind === 'update'
						? Array.from(this.diffOnlyFields)
						: undefined,
				}
			)

			const { rows: [row] } = await withPgClient(
				pgSettings,
				client => client
					.query<{ id: string, topic: string }>({ text, values: params })
			)

			console.log(
				`Created subscription ${row.id}, on topic ${row.topic}`
				+ (
					this.#kind === 'update'
						? `, fields: ${Array.from(this.diffOnlyFields).join(',') || 'all'}`
						: ''
				)
			)
			return this.#subSrc.subscribe(row.id, true)
		})
	}
}