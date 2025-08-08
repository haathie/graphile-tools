export type * from './types.ts'

import { hostname } from 'os'
import type { Pool } from 'pg'
import type {} from 'postgraphile'
import type { } from 'postgraphile/adaptors/pg'
import { inflection } from './inflection.ts'
import { SubscriptionManager } from './manager.ts'
import { schemaFieldsHook } from './schema-fields.ts'
import { schemaInitHook } from './schema-init.ts'
import { DEBUG } from './utils.ts'

export const PgRealtimePlugin: GraphileConfig.Plugin = {
	name: 'PgRealtimePlugin',
	inflection: inflection,
	schema: {
		behaviorRegistry: {
			'add': {
				'subscribable': {
					description:
						'Creates create, update, and delete subscriptions for the resource',
					entities: ['pgResource']
				}
			}
		},
		hooks: {
			'init': schemaInitHook,
			'GraphQLObjectType_fields': schemaFieldsHook,
		}
	},
	grafserv: {
		middleware: {
			async setPreset(
				next,
				{
					resolvedPreset: {
						pgServices = [],
						pgRealtime: {
							deviceId,
							readChunkSize,
							pollIntervalMs,
							subscribableRoles = []
						} = {}
					}
				}
			) {
				if(SubscriptionManager.isCurrentInitialized) {
					return next()
				}

				if(!deviceId) {
					deviceId = getCleanedDeviceId(hostname())
					DEBUG(
						`No deviceId provided, using hostname as deviceId: ${deviceId}`
					)
				}

				let superuserPool: Pool | undefined
				let introspectionRole: string | undefined
				for(const service of pgServices) {
					superuserPool = service.adaptorSettings?.superuserPool
					if(!superuserPool) {
						continue
					}

					const { pgSettings, release } = service
					service.pgSettings = (...args) => {
						const settings = typeof pgSettings === 'function'
							? pgSettings?.(...args)
							: pgSettings || {}
						// ensure device_id is set
						settings['app.device_id'] = deviceId
						return settings
					}

					service.release = async(...args) => {
						if(SubscriptionManager.isCurrentInitialized) {
							DEBUG('Releasing subscriptions source...')
							await SubscriptionManager.current.release()
							DEBUG('Subscriptions source released.')
						}

						await release?.(...args)
					}

					introspectionRole = service.pgSettingsForIntrospection?.role

					break
				}

				if(!superuserPool) {
					throw new Error('No superuser pool found in preset.')
				}

				const src = SubscriptionManager.init({
					pool: superuserPool,
					deviceId: deviceId,
					sleepDurationMs: pollIntervalMs,
					chunkSize: readChunkSize,
				})
				await src.listen()
				DEBUG('Subscriptions source initialized.')

				const rolesToGiveAccessTo = [
					...subscribableRoles,
					introspectionRole
				]

				for(const role of rolesToGiveAccessTo) {
					if(!role) {
						continue
					}

					await superuserPool.query({
						text: ACCESS_DDL.replaceAll('<username>', role)
					})

					DEBUG(`Granted access to ${role}`)
				}

				return next()
			}
		}
	},
}

function getCleanedDeviceId(deviceId: string) {
	// Remove any non-alphanumeric characters and convert to lowercase
	return deviceId.replace(/[^a-z0-9\_]/gi, '').toLowerCase()
}

const ACCESS_DDL = `
BEGIN;
GRANT USAGE, CREATE ON SCHEMA postg_realtime TO "<username>";
GRANT
	SELECT,
	INSERT(
		topic,
		type,
		additional_data,
		conditions_sql,
		conditions_params,
		is_temporary,
		diff_only_fields
	),
	DELETE
ON postg_realtime.subscriptions TO "<username>";
COMMIT;`