import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancySubscriptionsPlugin } from '../src/index.ts'

declare global {
	namespace Grafast {
		interface Context {
			userId?: string
		}
	}
}

export const CONFIG: TestGraphileConfig = {
	ddl: `
	DROP SCHEMA IF EXISTS subs_test CASCADE;
	CREATE SCHEMA IF NOT EXISTS subs_test;
	CREATE TABLE IF NOT EXISTS "subs_test"."books" (
		id SERIAL PRIMARY KEY,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
		creator_id VARCHAR(64) NOT NULL DEFAULT current_setting('app.user_id'),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	);

	CREATE INDEX IF NOT EXISTS books_creator_id_idx
		ON "subs_test"."books" (creator_id);

	CREATE TABLE IF NOT EXISTS "subs_test"."authors" (
		id SERIAL PRIMARY KEY,
		name TEXT NOT NULL
	);
	
	COMMENT ON TABLE "subs_test"."books" IS $$
	@behavior +subscribable 
	$$;
	`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [FancySubscriptionsPlugin],
		grafserv: { websockets: true },
		subscriptions: {
			deviceId: process.env.DEVICE_ID!,
			publishChanges: true,
		},
		pgServices: [
			makePgService({
				// Database connection string, read from an environmental variable:
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				// List of database schemas to expose:
				schemas: ['subs_test'],
				pgSettings(ctx) {
					const userId = getHeader('x-user-id')
					if(!userId) {
						return {}
					}

					return { 'app.user_id': userId }

					function getHeader(name: string) {
						if(ctx.http) {
							return ctx.http.getHeader(name)
						}

						if(ctx.ws) {
							const str = ctx.ws.normalizedConnectionParams?.[name]
							if(typeof str === 'string') {
								return str
							}
						}
					}
				}
			}),
		],
	}
}