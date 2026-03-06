import type { TestGraphileConfig } from '@haathie/postgraphile-common-utils/tests'
import { makePgService } from 'postgraphile/adaptors/pg'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { ReplaceTypesPlugin } from '../src/index.ts'

export const CONFIG: TestGraphileConfig = {
	ddl: `
    DROP SCHEMA IF EXISTS replace_types_test CASCADE;
    CREATE SCHEMA IF NOT EXISTS replace_types_test;

    CREATE TYPE "replace_types_test"."custom_status" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

    CREATE TABLE IF NOT EXISTS "replace_types_test"."users" (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      nullable_status TEXT,
      status_array TEXT[],
      status_array_not_null TEXT[] NOT NULL,
      metadata JSONB,
      custom_status "replace_types_test"."custom_status",
      custom_status_array "replace_types_test"."custom_status"[]
    );

    COMMENT ON COLUMN "replace_types_test"."users".status IS E'@replaceType CustomStatus';
    COMMENT ON COLUMN "replace_types_test"."users".nullable_status IS E'@replaceType CustomStatus';
    COMMENT ON COLUMN "replace_types_test"."users".status_array IS E'@replaceType CustomStatus';
    COMMENT ON COLUMN "replace_types_test"."users".status_array_not_null IS E'@replaceType CustomStatus';
    COMMENT ON COLUMN "replace_types_test"."users".custom_status IS E'@replaceType CustomStatus';
    COMMENT ON COLUMN "replace_types_test"."users".custom_status_array IS E'@replaceType CustomStatus';
	`,
	preset: {
		extends: [PostGraphileAmberPreset],
		plugins: [ReplaceTypesPlugin],
		pgServices: [
			makePgService({
				connectionString: process.env.PG_URI,
				superuserConnectionString: process.env.PG_URI,
				poolConfig: { min: 0, max: 10 },
				schemas: ['replace_types_test'],
			}),
		],
		schema: {}
	}
}
