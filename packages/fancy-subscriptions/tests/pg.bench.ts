// benchmark the latency of receiving events, given a load of active
import { getSuperuserPool, runDdl } from '@haathie/postgraphile-common-utils/tests'
import { Chance } from 'chance'
import { Pool } from 'pg'
import { type PgChangeEvent, SubscriptionManager } from '../src/manager.ts'
import { CONFIG } from './config.ts'

// txs
type Matcher = {
	createSub(idx: number): {
		conditionsSql: string
		conditionsParams: any[]
	}
	createItem(idx: number): {
		title: string
		author: string
		creatorId: string
	}
}

const chance = new Chance()

const SUB_COUNT_PER_MATCHER = 15_000

const MATCHERS: Matcher[] = [
	{
		createSub(idx) {
			return {
				conditionsSql: "e.row_data->>'creator_id' = s.conditions_params[1]",
				conditionsParams: [`creator_${idx}`]
			}
		},
		createItem(idx) {
			return {
				title: chance.name(),
				author: chance.name(),
				creatorId: `creator_${idx}`
			}
		}
	},
	{
		createSub(idx) {
			return {
				conditionsSql: "e.row_data->>'creator_id' = s.conditions_params[1] ",
				conditionsParams: [`creator2_${idx}`]
			}
		},
		createItem(idx) {
			return {
				title: chance.name(),
				author: chance.name(),
				creatorId: `creator2_${idx}`
			}
		}
	},
	{
		createSub(idx) {
			return {
				conditionsSql: `e.row_data->>'creator_id' = s.conditions_params[1]
					AND e.row_data->>'title' LIKE s.conditions_params[2] || '%'`,
				conditionsParams: [`creator3_${idx}`, 'SOMETHING']
			}
		},
		createItem(idx) {
			return {
				title: `SOMETHING_${chance.word({ length: 5 })}`,
				author: chance.name(),
				creatorId: `creator3_${idx}`
			}
		}
	},
	{
		createSub(idx) {
			return {
				conditionsSql: `e.row_data->>'creator_id' = s.conditions_params[1]
					AND e.row_data->>'author' LIKE s.conditions_params[2] || '%'`,
				conditionsParams: [`creator4_${idx}`, 'AUTHOR_']
			}
		},
		createItem(idx) {
			return {
				title: chance.name(),
				author: `AUTHOR_${chance.word()}`,
				creatorId: `creator4_${idx}`
			}
		}
	}
]

async function bench() {
	const deviceName = 'test_device'
	const pool = getSuperuserPool(CONFIG.preset)
	const createPool = new Pool({
		max: 20,
		connectionString: pool.options.connectionString!
	})

	await pool.query('DROP SCHEMA IF EXISTS postgraphile_meta CASCADE;')

	await runDdl(CONFIG)

	const manager = new SubscriptionManager({
		pool,
		deviceId: deviceName,
		sleepDurationMs: 250,
		chunkSize: 5_000
	})

	await manager.listen()
	await manager.makeSubscribable('subs_test.books')

	const matcherSubIds: AsyncIterableIterator<PgChangeEvent>[][] = []

	for(const { createSub } of MATCHERS) {
		const subs = Array.from({ length: SUB_COUNT_PER_MATCHER }, (_, idx) => {
			return createSub(idx)
		})

		const { rows } = await pool.query(
			`INSERT INTO postgraphile_meta.subscriptions (worker_device_id, topic, conditions_sql, conditions_params)
			VALUES ${subs.map((_, idx) => (`('${deviceName}', 'subs_test.books.INSERT', $${idx * 2 + 1}, $${idx * 2 + 2})`)).join(',')}
			RETURNING id
			`,
			subs.flatMap(sub => [sub.conditionsSql, sub.conditionsParams])
		)

		console.log(`Inserted ${subs.length} subscriptions.`)
		matcherSubIds.push(rows.map(row => manager.subscribe(row.id, false)))
	}

	const createBenches: (() => Promise<{ matcherIdx: number, ms: number }>)[] = []
	for(const [i, { createItem }] of MATCHERS.entries()) {
		for(const [idx, sub] of matcherSubIds[i].entries()) {
			createBenches.push(async() => {
				const item = createItem(idx)
				await createPool.query(
					'INSERT INTO subs_test.books (title, author, creator_id) VALUES ($1, $2, $3)',
					[item.title, item.author, item.creatorId]
				)
				const now = Date.now()
				await sub.next()
				const elapsed = Date.now() - now
				return { matcherIdx: i, ms: elapsed }
			})
		}
	}

	const shuffledBenches = chance.shuffle(createBenches)
	const rslts = await Promise.all(shuffledBenches.map(b => b()))

	const avg = rslts.reduce((acc, { ms }) => acc + ms, 0) / rslts.length
	console.log(`Average latency for ${rslts.length} events: ${avg.toFixed(2)}ms`)

	const norms = await shuffledBenches[0]()
	console.log(`single latency: ${norms.ms}ms for matcher ${norms.matcherIdx}`)

	await manager.release()
	await pool.end()
}

bench()