// Only needed for TypeScript types support
import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
// Use the 'pg' module to connect to the database
import { makePgService } from 'postgraphile/adaptors/pg'
import { SubscriptionPlugin } from 'postgraphile/graphile-build'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { FancyConditionsPlugin } from './plugin/fancy-conditions/index.ts'
import { FancyMutationsPlugin } from './plugin/fancy-mutations/index.ts'
import { ReasonableLimitsPlugin } from './plugin/reasonable-limits.ts'
import { SubscriptionsPlugin } from './plugin/subscriptions/index.ts'

const preset: GraphileConfig.Preset = {
	extends: [
		PostGraphileAmberPreset,
		PgSimplifyInflectionPreset
	],
	plugins: [
		SubscriptionPlugin,
		ReasonableLimitsPlugin,
		FancyMutationsPlugin,
		SubscriptionsPlugin,
		FancyConditionsPlugin,
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
	grafserv: {
		// watch: true,
		// websockets: true,
		maxRequestLength: 1_000_000
	},
	grafast: { explain: true },
	schema: {
		defaultBehavior: '-single',
	},
}

export default preset