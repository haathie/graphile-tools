import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { ReasonableLimitsPlugin } from '../src/index.ts'

const SCHEMA_NAME = 'reasonable_limits_test'
export const CONFIG: TestGraphileConfig = {
	ddl: `
	DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE;
	CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME};
	CREATE TABLE IF NOT EXISTS "${SCHEMA_NAME}"."books" (
		id SERIAL PRIMARY KEY,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		metadata JSONB
	);
	`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [ReasonableLimitsPlugin],
		pgServices: [
			makePgService({
				// Database connection string, read from an environmental variable:
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				// List of database schemas to expose:
				schemas: [SCHEMA_NAME],
			}),
		],
	}
}