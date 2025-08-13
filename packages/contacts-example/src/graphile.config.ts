import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
import { FancyMutationsPlugin } from '@haathie/postgraphile-fancy-mutations'
import { OTELPlugin } from '@haathie/postgraphile-otel'
import { RateLimitsPlugin } from '@haathie/postgraphile-rate-limits'
import { PgRealtimePlugin } from '@haathie/postgraphile-realtime'
import { ReasonableLimitsPlugin } from '@haathie/postgraphile-reasonable-limits'
import { TargetedConditionsPlugin } from '@haathie/postgraphile-targeted-conditions'
import { makePgService } from 'postgraphile/adaptors/pg'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'

const preset: GraphileConfig.Preset = {
	extends: [
		PostGraphileAmberPreset,
		PgSimplifyInflectionPreset
	],
	plugins: [
		OTELPlugin,
		ReasonableLimitsPlugin,
		PgRealtimePlugin,
		FancyMutationsPlugin,
		TargetedConditionsPlugin,
		RateLimitsPlugin,
	],
	disablePlugins: [
		'NodePlugin',
	],
	pgServices: [
		/* list of PG database configurations, e.g.: */
		makePgService({
			// Database connection string, read from an environmental variable:
			connectionString: process.env.PG_URI,
			superuserConnectionString: process.env.PG_URI,
			poolConfig: { min: 20, max: 20 },
			pgSettings(ctx) {
				let teamId = getHeader('org-id')
				if(typeof teamId !== 'string') {
					teamId = 'default-org-id'
				}

				let userId = getHeader('user-id')
				if(typeof userId !== 'string') {
					userId = 'default-user-id'
				}

				return {
					'role': 'app_user',
					'app.org_id': teamId,
					'app.user_id': userId,
					'app.has_full_contacts_access': (
						getHeader('has_full_contacts_access') !== 'false'
					).toString(),
				}

				function getHeader(name: string) {
					if(ctx.http) {
						return ctx.http.getHeader(name)
					}

					if(ctx.ws) {
						return ctx.ws.normalizedConnectionParams?.[name]
					}
				}
			},
			pgSettingsForIntrospection: {
				'role': 'app_user'
			},
			// List of database schemas to expose:
			schemas: ['app'],
		}),
	],
	pgRealtime: {
		deviceId: process.env.DEVICE_ID || 'default-device',
		pollIntervalMs: 500
	},
	grafserv: {
		websockets: true,
		maxRequestLength: 1_000_000
	},
	// grafast: { explain: true },
	schema: {
		dontSwallowErrors: true,
		defaultBehavior: '-single',
		haathieRateLimits: {
			rateLimiterPgOpts: l => ({ inMemoryBlockOnConsumed: l.max }),
			rolesToGiveAccessTo: ['app_user'],
			isAuthenticated(ctx) {
				return !!ctx.pgSettings?.['app.user_id']
			},
			addRateLimitsToDescription: true,
			rateLimitsConfig: {
				authenticated: {
					default: { max: 100, durationS: 60 },
					getRateLimitingKey({ pgSettings }) {
						return pgSettings?.['app.org_id']
					},
				}
			},
		}
	},
}

export default preset