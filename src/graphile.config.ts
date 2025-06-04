// Only needed for TypeScript types support
import { PgSimplifyInflectionPreset } from '@graphile/simplify-inflection'
// Use the 'pg' module to connect to the database
import { makePgService } from 'postgraphile/adaptors/pg'
// The standard base preset to use, includes the main PostGraphile features
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import 'postgraphile'

const preset: GraphileConfig.Preset = {
	extends: [
		PostGraphileAmberPreset,
		PgSimplifyInflectionPreset
	],
	disablePlugins: ['NodePlugin'],
	pgServices: [
		/* list of PG database configurations, e.g.: */
		makePgService({
			// Database connection string, read from an environmental variable:
			connectionString: process.env.PG_URI,
			pgSettings(ctx) {
				const teamId = ctx.node.req.headers['org-id']
				if(typeof teamId !== 'string') {
					throw new Error('Missing org-id header')
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
	grafast: {
		explain: true,
	},
}

export default preset