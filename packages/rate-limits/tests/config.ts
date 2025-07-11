import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { RateLimitsPlugin } from '../src/index.ts'
import type { RateLimit } from '../src/types.ts'

declare global {
	namespace Grafast {
		interface Context {
			userId?: string
		}
	}
}

export const OVERRIDE_BOOKS_LIMIT: RateLimit = { max: 8, durationS: 60 }

export const CONFIG: TestGraphileConfig = {
	ddl: `
	DROP SCHEMA IF EXISTS rate_limits_test CASCADE;
	CREATE SCHEMA IF NOT EXISTS rate_limits_test;
	CREATE TABLE IF NOT EXISTS "rate_limits_test"."books" (
		id SERIAL PRIMARY KEY,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		metadata JSONB
	);
	
	COMMENT ON TABLE "rate_limits_test"."books" IS $$
	@rateLimits connection:authenticated:${OVERRIDE_BOOKS_LIMIT.max}/${OVERRIDE_BOOKS_LIMIT.durationS}s
	$$;
	`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [RateLimitsPlugin],
		grafast: {
			context(ctx) {
				const userId = ctx.http?.getHeader('x-user-id')
				if(!userId) {
					return {}
				}

				return { userId }
			},
		},
		pgServices: [
			makePgService({
				// Database connection string, read from an environmental variable:
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				// List of database schemas to expose:
				schemas: ['rate_limits_test'],
			}),
		],
		schema: {
			haathieRateLimits: {
				defaultUnauthenticatedLimit: { max: 10, durationS: 60 },
				addRateLimitsToDescription: true,
				isAuthenticated(ctx) {
					return !!ctx.userId
				},
				rateLimitsConfig: {
					authenticated: {
						'default': { max: 50, durationS: 60 },
						getRateLimitingKey(ctx) {
							return ctx.userId
						}
					}
				}
			}
		}
	}
}