import type {} from 'postgraphile'
import type { GraphQLInputType, GraphQLNamedType, GraphQLOutputType } from 'postgraphile/graphql'

function wrapOutputType(
	originalType: GraphQLOutputType,
	replacementType: GraphQLNamedType,
	{ graphql: { GraphQLList, GraphQLNonNull } }: GraphileBuild.Build,
): GraphQLOutputType {
	let result: any = replacementType

	const wrappers: any[] = []
	let current: GraphQLOutputType = originalType

	while(current instanceof GraphQLNonNull || current instanceof GraphQLList) {
		wrappers.unshift(current.constructor)
		current = current.ofType as GraphQLOutputType
	}

	for(const Wrapper of wrappers) {
		result = new Wrapper(result)
	}

	return result
}

function wrapInputType(
	originalType: GraphQLInputType,
	replacementType: GraphQLNamedType,
	{ graphql: { GraphQLList, GraphQLNonNull } }: GraphileBuild.Build,
): GraphQLInputType {
	let result: any = replacementType

	const wrappers: any[] = []
	let current: GraphQLInputType = originalType

	while(current instanceof GraphQLNonNull || current instanceof GraphQLList) {
		wrappers.unshift(current.constructor)
		current = current.ofType as GraphQLInputType
	}

	for(const Wrapper of wrappers) {
		result = new Wrapper(result)
	}

	return result
}

function getAttributeFromScope(pgCodec: any, fieldName: string, inflection: any): any {
	if(!pgCodec.attributes) {
		return undefined
	}

	if(pgCodec.attributes[fieldName]) {
		return pgCodec.attributes[fieldName]
	}

	for(const [attrName, attr] of Object.entries(pgCodec.attributes)) {
		const graphqlName = inflection.attribute({ attributeName: attrName, codec: pgCodec })
		if(graphqlName === fieldName) {
			return attr
		}
	}

	return undefined
}

export const ReplaceTypesPlugin: GraphileConfig.Plugin = {
	name: 'ReplaceTypesPlugin',
	version: '0.1.0',
	schema: {
		hooks: {
			'GraphQLObjectType_fields_field': (field, build, ctx) => {
				const { scope: { pgFieldAttribute, pgCodec, fieldName } } = ctx as any
				if(!pgFieldAttribute || !pgCodec || !fieldName) {
					return field
				}

				const attr = getAttributeFromScope(pgCodec, fieldName, build.inflection)
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
					type: wrapOutputType(field.type, replacementType, build),
				}
			},
			'GraphQLInputObjectType_fields_field': (field, build, ctx) => {
				const { scope: { pgCodec, fieldName } } = ctx as any

				if(!pgCodec || !fieldName) {
					return field
				}

				const attr = getAttributeFromScope(pgCodec, fieldName, build.inflection)
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
					type: wrapInputType(field.type, replacementType, build),
				}
			},
		},
	},
}
