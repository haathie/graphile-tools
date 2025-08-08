import type { PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'

export type PgTableResource = PgResource<string, PgCodecWithAttributes>

declare global {
	namespace GraphileConfig {
		interface Preset {
			pgRealtime?: {
				/**
				 * A unique identifier for this device/machine that will
				 * persist across restarts.
				 * Eg. EC2 instance ID, k8s FQDN in a stateful set, etc.
				 */
				deviceId: string
				/**
				 * How many events to read in a single read operation.
				 * @default 1000
				 */
				readChunkSize?: number
				/**
				 * How often to poll the database for new events.
				 * @default 500
				 */
				pollIntervalMs?: number

				/**
				 * Roles that will be granted access to create subscriptions.
				 * By default, the introspection role will be granted access.
				 */
				subscribableRoles?: string[]
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