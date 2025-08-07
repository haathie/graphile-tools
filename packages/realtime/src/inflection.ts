

export const inflection: GraphileConfig.PluginInflectionConfig = {
	'add': {
		primaryKeyTypeName(_, rsc) {
			return this.upperCamelCase(`${this.singularize(rsc.name)}Key`)
		},
		subscriptionFieldName(_, resource, type) {
			return this.camelCase(`${this.pluralize(resource.name)}_${type}`)
		},
		subscriptionTypeName(_, resource, type) {
			return this.upperCamelCase(
				`${this.pluralize(resource.name)}_${type}_Subscription`
			)
		},
		pureTypeName(_, resource) {
			return this.upperCamelCase(`Pure_${this.singularize(resource.name)}`)
		},
		partialTypeName(_, fullTypeName) {
			return this.upperCamelCase(`Partial_${fullTypeName}`)
		},
		subscriptionUpdateObjectTypeName(_, resource) {
			return this.upperCamelCase(
				`${this.singularize(resource.name)}_Update`
			)
		}
	}
}