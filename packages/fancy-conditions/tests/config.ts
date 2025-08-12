import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancyConditionsPlugin } from '../src/index.ts'

export const CONFIG: TestGraphileConfig = {
	ddl: `
    DROP SCHEMA IF EXISTS conditions_test CASCADE;
    CREATE SCHEMA IF NOT EXISTS conditions_test;

		CREATE TYPE "conditions_test"."bio_data" AS (
			age INT,
			favourite_genre TEXT
		);

    CREATE TABLE IF NOT EXISTS "conditions_test"."authors" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			bio "conditions_test"."bio_data",
			metadata JSONB,
			nicknames TEXT[],
			UNIQUE(name)
    );

		CREATE TABLE IF NOT EXISTS "conditions_test"."publishers" (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			address TEXT,
			metadata JSONB
    );

    CREATE TABLE IF NOT EXISTS "conditions_test"."books" (
			id SERIAL PRIMARY KEY,
			title TEXT NOT NULL,
			author_id INT REFERENCES "conditions_test"."authors"(id) ON DELETE CASCADE,
			publisher_id INT REFERENCES "conditions_test"."publishers"(id) ON DELETE SET NULL,
			metadata JSONB
    );
		CREATE INDEX ON "conditions_test"."books"(author_id);
		CREATE INDEX ON "conditions_test"."books"(publisher_id);

		comment on column "conditions_test"."authors".bio is $$
		@behaviour filterType:eq filterType:eqIn
		$$;

		comment on column "conditions_test"."books".id is $$
		@behaviour filterType:range
		$$;

		comment on column "conditions_test"."books".title is $$
		@behaviour filterType:icontains
		$$;

		comment on table "conditions_test"."authors" is $$
		@ref books via:(id)->books(author_id) behavior:filterable
		$$;
		
		comment on constraint books_author_id_fkey on conditions_test.books is $$
		@behaviour +single
		$$;
		comment on constraint books_publisher_id_fkey on conditions_test.books is $$
		@behaviour +single
		$$;`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [FancyConditionsPlugin],
		pgServices: [
			makePgService({
				// Database connection string, read from an environmental variable:
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				// List of database schemas to expose:
				schemas: ['conditions_test'],
			}),
		],
		schema: {}
	}
}