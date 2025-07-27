import type { PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'

export type PgTableResource = PgResource<string, PgCodecWithAttributes>

declare global {
	namespace GraphileConfig {
		interface Preset {
			subscriptions?: {
				deviceId: string
				readChunkSize?: number
				pollIntervalMs?: number
			}
		}
	}

	namespace GraphileBuild {
		interface BehaviorStrings {
			'subscribable': true
		}

		interface Inflection {
			primaryKeyTypeName(resource: PgTableResource): string

			subscriptionFieldName(
				resource: PgTableResource,
				type: 'created' | 'updated' | 'deleted'
			): string

			subscriptionTypeName(
				resource: PgTableResource,
				type: 'created' | 'updated' | 'deleted'
			): string

			subscriptionUpdateObjectTypeName(
				resource: PgTableResource
			): string

			/**
			 * Name the model without any relations
			 */
			pureTypeName(resource: PgTableResource): string

			partialTypeName(fullTypeName: string): string
		}

		interface ScopeObject {
			isPrimaryKeyType?: boolean
			isPartialType?: boolean
			isPureType?: boolean

			isSubscriptionUpdateObjectType?: boolean

			subscriptionType?: 'created' | 'updated' | 'deleted'
		}

		interface ScopeObjectFieldsField {
			isSubscriptionField?: boolean
			subscriptionType?: 'created' | 'updated' | 'deleted'
		}
	}
}