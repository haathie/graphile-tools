import type { PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'
import type { FieldPlanResolver, Step } from 'postgraphile/grafast'

export type GrafastPlanParams<T extends Step = Step> = Parameters<
	FieldPlanResolver<T, any, any>
>

export type PgTableResource = PgResource<string, PgCodecWithAttributes>

declare global {
	namespace GraphileBuild {
		interface Inflection {
			bulkUpdateOperationName(resource: PgResource): string
			bulkUpdatePayloadName(resource: PgResource): string

			bulkDeleteOperationName(resource: PgResource): string
			bulkDeletePayloadName(resource: PgResource): string
		}

		interface ScopeObject {
			isBulkDeleteObject?: boolean
			isBulkUpdateObject?: boolean
		}

		interface ScopeObjectFields {
			isBulkDeleteItems?: boolean
			isBulkUpdateItems?: boolean

			isBulkDeleteOperation?: boolean
			isBulkUpdateOperation?: boolean
		}
	}
}
