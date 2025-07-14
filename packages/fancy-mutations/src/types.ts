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

			onConflictEnumName(): string

			bulkCreateOperationName(resource: PgResource): string
			bulkCreatePayloadName(resource: PgResource): string

			bulkCreateInputObjectName(resource: PgResource): string
			bulkCreateInputObjectRelationName(
				path: string[]
			): string
		}

		interface ScopeObject {
			isBulkDeleteObject?: boolean
			isBulkUpdateObject?: boolean
			isBulkCreateObject?: boolean
		}

		interface ScopeInputObject {
			isBulkCreateInputObject?: boolean
			isBulkCreateInputObjectRelation?: boolean
			path?: string[]
		}

		interface ScopeInputObjectFieldsField {
			isBulkCreateInputObjectField?: boolean
		}

		interface ScopeObjectFields {
			isBulkDeleteItems?: boolean
			isBulkUpdateItems?: boolean
			isBulkCreateItems?: boolean

			isBulkDeleteOperation?: boolean
			isBulkUpdateOperation?: boolean
			isBulkCreateOperation?: boolean
		}
	}
}
