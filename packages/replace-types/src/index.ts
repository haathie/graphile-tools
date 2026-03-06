import type {} from 'postgraphile'
import type { GraphQLInputType, GraphQLOutputType } from 'postgraphile/graphql'

export const ReplaceTypesPlugin: GraphileConfig.Plugin = {
	name: 'ReplaceTypesPlugin',
	version: '0.1.0',
	schema: {
		hooks: {
			'GraphQLObjectType_fields_field': (field, build, ctx) => {
				const { scope: { pgFieldAttribute, pgCodec, fieldName } } = ctx
				if(!pgFieldAttribute || !pgCodec || !fieldName) {
					return field
				}

				const attr = pgCodec.attributes?.[fieldName]
				if(!attr) {
					return field
				}

				const replaceType = attr.extensions?.tags?.replaceType
				if(!replaceType) {
					return field
				}

				const replacementType = build.getTypeByName(replaceType)

				if(!replacementType) {
					console.warn(
						`[ReplaceTypesPlugin] Type '${replaceType}' not found. `
						+ `Cannot replace field '${fieldName}'.`
					)
					return field
				}

				return {
					...field,
					type: replacementType as GraphQLOutputType,
				}
			},
			'GraphQLInputObjectType_fields_field': (field, build, ctx) => {
				const { scope: { pgCodec, fieldName } } = ctx
				if(!pgCodec || !fieldName) {
					return field
				}

				const attr = pgCodec.attributes?.[fieldName]
				if(!attr) {
					return field
				}

				const replaceType = attr.extensions?.tags?.replaceType
				if(typeof replaceType !== 'string') {
					return field
				}

				const replacementType = build.getTypeByName(replaceType + 'Input')
					|| build.getTypeByName(replaceType)

				if(!replacementType) {
					console.warn(
						`[ReplaceTypesPlugin] Type '${replaceType}Input' (or '${replaceType}') not found. `
						+ `Cannot replace input field '${fieldName}'.`
					)
					return field
				}

				return {
					...field,
					type: replacementType as GraphQLInputType,
				}
			},
		},
	},
}
