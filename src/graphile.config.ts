// Only needed for TypeScript types support
import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
// Use the 'pg' module to connect to the database
import { makePgService } from 'postgraphile/adaptors/pg'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import 'postgraphile'
import { FancyMutationsPlugin } from './plugin/fancy-mutations/index.ts'
import { ReasonableLimitsPlugin } from './plugin/reasonable-limits.ts'

const preset: GraphileConfig.Preset = {
	extends: [
		PostGraphileAmberPreset,
		PgSimplifyInflectionPreset
	],
	plugins: [
		ReasonableLimitsPlugin,
		FancyMutationsPlugin
	],
	disablePlugins: ['NodePlugin'],
	pgServices: [
		/* list of PG database configurations, e.g.: */
		makePgService({
			// Database connection string, read from an environmental variable:
			connectionString: process.env.PG_URI,
			pgSettings(ctx) {
				let teamId = ctx.node.req.headers['org-id']
				if(typeof teamId !== 'string') {
					teamId = 'default-org-id'
				}

				return { 'role': 'app_user', 'app.org_id': teamId, 'app.user_id': 'ad_singh' }
			},
			pgSettingsForIntrospection: {
				'role': 'app_user'
			},
			pubsub: true,
			// List of database schemas to expose:
			schemas: ['app'],
		}),
	],
	grafserv: { watch: true },
	grafast: {
		explain: true,
	},
	schema: {
		defaultBehavior: '-single',
	},
}

export default preset