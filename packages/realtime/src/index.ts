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
							pollIntervalMs
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
				try {
					await src.listen()
					DEBUG('Subscriptions source initialized.')
				} catch(err) {
					console.error('Error initializing subscriptions source:', err)
					throw err
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