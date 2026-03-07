import { exportSchemaAsString } from 'graphile-export'
import assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancyMutationsPlugin } from '../../fancy-mutations/src/index.ts'
import { RateLimitsPlugin } from '../../rate-limits/src/index.ts'
import { PgRealtimePlugin } from '../../realtime/src/index.ts'
import { ReasonableLimitsPlugin } from '../../reasonable-limits/src/index.ts'
import { TargetedConditionsPlugin } from '../../targeted-conditions/src/index.ts'
import { type BootedGraphileServer, runDdlAndBoot, type TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'

function makePgSvc(schemas: string[]) {
	return makePgService({
		connectionString: process.env.PG_URI,
		superuserConnectionString: process.env.PG_URI,
		poolConfig: { min: 0, max: 10 },
		schemas,
	})
}

const configs: Array<{ name: string; config: TestGraphileConfig }> = [
	{
		name: 'RateLimitsPlugin',
		config: {
			ddl: `
				DROP SCHEMA IF EXISTS export_rl CASCADE;
				CREATE SCHEMA export_rl;
				CREATE TABLE export_rl.books (
					id SERIAL PRIMARY KEY,
					title TEXT NOT NULL
				);
			`,
			preset: {
				extends: [PostGraphileAmberPreset],
				plugins: [RateLimitsPlugin],
				pgServices: [makePgSvc(['export_rl'])],
				schema: {
					haathieRateLimits: {
						defaultUnauthenticatedLimit: { max: 10, durationS: 60 },
						isAuthenticated: () => false,
						rateLimitsConfig: {},
					},
				},
			},
		},
	},
	{
		name: 'FancyMutationsPlugin',
		config: {
			ddl: `
				DROP SCHEMA IF EXISTS export_fm CASCADE;
				CREATE SCHEMA export_fm;
				CREATE TABLE export_fm.authors (
					id SERIAL PRIMARY KEY,
					name TEXT NOT NULL UNIQUE
				);
				CREATE TABLE export_fm.books (
					id SERIAL PRIMARY KEY,
					title TEXT NOT NULL,
					author_id INT REFERENCES export_fm.authors(id)
				);
				CREATE INDEX ON export_fm.books(author_id);
			`,
			preset: {
				extends: [PostGraphileAmberPreset],
				plugins: [FancyMutationsPlugin],
				pgServices: [makePgSvc(['export_fm'])],
			},
		},
	},
	{
		name: 'PgRealtimePlugin',
		config: {
			ddl: `
				DROP SCHEMA IF EXISTS export_rt CASCADE;
				CREATE SCHEMA export_rt;
				CREATE TABLE export_rt.books (
					id SERIAL PRIMARY KEY,
					title TEXT NOT NULL,
					created_at TIMESTAMPTZ NOT NULL DEFAULT now()
				);
				ALTER TABLE export_rt.books REPLICA IDENTITY FULL;
				COMMENT ON TABLE export_rt.books IS $$
				@behavior +subscribable
				$$;
			`,
			preset: {
				extends: [PostGraphileAmberPreset],
				plugins: [PgRealtimePlugin],
				pgRealtime: {
					deviceId: 'export_test_device',
					pollIntervalMs: 750,
				},
				pgServices: [makePgSvc(['export_rt'])],
			},
		},
	},
	{
		name: 'TargetedConditionsPlugin',
		config: {
			ddl: `
				DROP SCHEMA IF EXISTS export_tc CASCADE;
				CREATE SCHEMA export_tc;
				CREATE TABLE export_tc.authors (
					id SERIAL PRIMARY KEY,
					name TEXT NOT NULL UNIQUE
				);
				CREATE TABLE export_tc.books (
					id SERIAL PRIMARY KEY,
					title TEXT NOT NULL,
					author_id INT REFERENCES export_tc.authors(id)
				);
				CREATE INDEX ON export_tc.books(author_id);
			`,
			preset: {
				extends: [PostGraphileAmberPreset],
				plugins: [TargetedConditionsPlugin],
				pgServices: [makePgSvc(['export_tc'])],
			},
		},
	},
	{
		name: 'ReasonableLimitsPlugin',
		config: {
			ddl: `
				DROP SCHEMA IF EXISTS export_rlim CASCADE;
				CREATE SCHEMA export_rlim;
				CREATE TABLE export_rlim.books (
					id SERIAL PRIMARY KEY,
					title TEXT NOT NULL
				);
			`,
			preset: {
				extends: [PostGraphileAmberPreset],
				plugins: [ReasonableLimitsPlugin],
				pgServices: [makePgSvc(['export_rlim'])],
			},
		},
	},
]

for(const { name, config } of configs) {
	describe(`exportSchema: ${name}`, () => {
		let srv: BootedGraphileServer

		before(async() => {
			srv = await runDdlAndBoot(config)
		})

		after(async() => {
			await srv?.destroy()
		})

		it('should export the schema without error', async() => {
			const { code } = await exportSchemaAsString(
				srv.schema,
				{ mode: 'graphql-js' }
			)
			assert.ok(code.length > 0, 'exported schema code should not be empty')
		})
	})
}
