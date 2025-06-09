import { graphQLSchemaHook } from './graphQLSchema.ts'

export const FancyMutationsPlugin: GraphileConfig.Plugin = {
	name: 'FancyMutationsPlugin',
	schema: {
		hooks: {
			GraphQLSchema: graphQLSchemaHook
		}
	}
}