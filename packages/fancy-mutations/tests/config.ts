import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancyMutationsPlugin } from '../src/index.ts'

export const CONFIG: TestGraphileConfig = {
	ddl: `
    DROP SCHEMA IF EXISTS mutations_test CASCADE;
    CREATE SCHEMA IF NOT EXISTS mutations_test;

		CREATE TYPE "mutations_test"."bio_data" AS (
			age INT,
			favourite_genre TEXT
		);

    CREATE TABLE IF NOT EXISTS "mutations_test"."authors" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			bio "mutations_test"."bio_data",
			metadata JSONB,
			nickname TEXT,
			UNIQUE(name)
    );

		CREATE TABLE IF NOT EXISTS "mutations_test"."publishers" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			address TEXT,
			metadata JSONB
    );

    CREATE TABLE IF NOT EXISTS "mutations_test"."books" (
			id SERIAL PRIMARY KEY,
			title TEXT NOT NULL,
			author_id INT REFERENCES "mutations_test"."authors"(id) ON DELETE CASCADE,
			publisher_id INT REFERENCES "mutations_test"."publishers"(id) ON DELETE SET NULL,
			metadata JSONB
    );
		CREATE INDEX ON "mutations_test"."books"(author_id);
		CREATE INDEX ON "mutations_test"."books"(publisher_id);
		
		comment on constraint books_author_id_fkey on mutations_test.books is $$
		@behaviour +single
		$$;
		comment on constraint books_publisher_id_fkey on mutations_test.books is $$
		@behaviour +single
		$$;`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [FancyMutationsPlugin],
		pgServices: [
			makePgService({
				// Database connection string, read from an environmental variable:
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				// List of database schemas to expose:
				schemas: ['mutations_test'],
			}),
		],
		schema: {}
	}
}