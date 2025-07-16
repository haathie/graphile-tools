import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancyMutationsPlugin } from '../src/index.ts'

export const CONFIG: TestGraphileConfig = {
	ddl: `
    DROP SCHEMA IF EXISTS fancy_mutations_test CASCADE;
    CREATE SCHEMA IF NOT EXISTS fancy_mutations_test;

		CREATE TYPE "fancy_mutations_test"."bio_data" AS (
			age INT,
			favourite_genre TEXT
		);

    CREATE TABLE IF NOT EXISTS "fancy_mutations_test"."authors" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			bio "fancy_mutations_test"."bio_data",
			metadata JSONB,
			nickname TEXT
    );
		CREATE UNIQUE INDEX IF NOT EXISTS "authors_name_idx"
			ON "fancy_mutations_test"."authors"(name);

		CREATE TABLE IF NOT EXISTS "fancy_mutations_test"."publishers" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			address TEXT,
			metadata JSONB
    );

    CREATE TABLE IF NOT EXISTS "fancy_mutations_test"."books" (
			id SERIAL PRIMARY KEY,
			title TEXT NOT NULL,
			author_id INT REFERENCES "fancy_mutations_test"."authors"(id) ON DELETE CASCADE,
			publisher_id INT REFERENCES "fancy_mutations_test"."publishers"(id) ON DELETE SET NULL,
			metadata JSONB
    );`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [FancyMutationsPlugin],
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
				schemas: ['fancy_mutations_test'],
			}),
		],
		schema: {}
	}
}