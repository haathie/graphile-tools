// Only needed for TypeScript types support
import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
// Use the 'pg' module to connect to the database
import { makePgService } from 'postgraphile/adaptors/pg'
import { SubscriptionPlugin } from 'postgraphile/graphile-build'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import 'postgraphile'
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
		SubscriptionsPlugin
	],
	pgServices: [
		/* list of PG database configurations, e.g.: */
		makePgService({
			// Database connection string, read from an environmental variable:
			connectionString: process.env.PG_URI,
			superuserConnectionString: process.env.PG_URI,
			pgSettings(ctx) {
				let teamId = ctx.node?.req?.headers['org-id']
				if(typeof teamId !== 'string') {
					teamId = 'default-org-id'
				}

				return {
					'role': 'app_user',
					'app.org_id': teamId,
					'app.user_id': 'ad_singh',
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
	grafserv: { watch: true, websockets: true },
	grafast: { explain: true },
	schema: {
		defaultBehavior: '-single',
	},
}

export default preset