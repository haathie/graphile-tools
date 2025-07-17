import type { PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'
import type { FieldPlanResolver, Step } from 'postgraphile/grafast'

export type GrafastPlanParams<T extends Step = Step> = Parameters<
	FieldPlanResolver<T, any, any>
>

export type PgTableResource = PgResource<string, PgCodecWithAttributes>

export type OnConflictOption = 'error' | 'ignore' | 'replace'

declare global {
	namespace GraphileBuild {

		interface BehaviorStrings {
			'bulkCreate': true
			'bulkUpdate': true
			'bulkDelete': true
		}

		interface Inflection {
			onConflictEnumName(): string

			bulkMutationPayloadName(resource: PgResource): string

			bulkUpdateOperationName(resource: PgResource): string

			bulkDeleteOperationName(resource: PgResource): string

			bulkCreateOperationName(resource: PgResource): string

			bulkCreateInputObjectName(resource: PgResource): string
			bulkCreateInputObjectRelationName(path: string[]): string
		}

		interface ScopeObject {
			isBulkMutationPayloadObject?: boolean
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
