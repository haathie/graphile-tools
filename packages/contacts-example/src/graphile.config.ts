import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
import { FancyConditionsPlugin } from '@haathie/fancy-conditions'
import { FancyMutationsPlugin } from '@haathie/fancy-mutations'
import { FancySubscriptionsPlugin } from '@haathie/fancy-subscriptions'
import { RateLimitsPlugin } from '@haathie/graphile-rate-limits'
import { ReasonableLimitsPlugin } from '@haathie/graphile-reasonable-limits'
import { makePgService } from 'postgraphile/adaptors/pg'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'

const preset: GraphileConfig.Preset = {
	extends: [
		PostGraphileAmberPreset,
		PgSimplifyInflectionPreset
	],
	plugins: [
		FancySubscriptionsPlugin,
		ReasonableLimitsPlugin,
		FancyMutationsPlugin,
		FancyConditionsPlugin,
		RateLimitsPlugin,
	],
	pgServices: [
		/* list of PG database configurations, e.g.: */
		makePgService({
			// Database connection string, read from an environmental variable:
			connectionString: process.env.PG_URI,
			superuserConnectionString: process.env.PG_URI,
			poolConfig: { min: 15, max: 30 },
			pgSettings(ctx) {
				let teamId = ctx.node?.req?.headers['org-id']
				if(typeof teamId !== 'string') {
					teamId = 'default-org-id'
				}

				let userId = ctx.node?.req?.headers['user-id']
				if(typeof userId !== 'string') {
					userId = 'default-user-id'
				}

				return {
					'role': 'app_user',
					'app.org_id': teamId,
					'app.user_id': userId,
					'app.has_full_contacts_access': (
						ctx.node?.req?.headers['has_full_contacts_access'] !== 'false'
					).toString(),
				}
			},
			pgSettingsForIntrospection: {
				'role': 'app_user'
			},
			// List of database schemas to expose:
			schemas: ['app'],
		}),
	],
	subscriptions: {
		deviceId: process.env.DEVICE_ID || 'default-device',
		publishChanges: true
	},
	rateLimits: {
		rateLimiterPgOpts: l => ({ inMemoryBlockOnConsumed: l.max }),
		rolesToGiveAccessTo: ['app_user'],
		isAuthenticated(ctx) {
			return !!ctx.pgSettings?.['app.user_id']
		},
	},
	grafserv: {
		// watch: true,
		websockets: true,
		maxRequestLength: 1_000_000
	},
	grafast: { explain: true },
	schema: {
		defaultBehavior: '-single',
		addRateLimitsToDescription: true,
		rateLimits: {
			authenticated: {
				default: { max: 10, durationS: 60 },
				getRateLimitingKey({ pgSettings }) {
					return pgSettings?.['app.org_id']
				},
			}
		},
	},
}

export default preset