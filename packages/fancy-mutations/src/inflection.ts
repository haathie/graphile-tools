
export const inflection: GraphileConfig.PluginInflectionConfig = {
	'add': {
		bulkUpdateOperationName(options, resource) {
			return this.camelCase(this.pluralize(`update_${resource.name}`))
		},
		bulkUpdatePayloadName(options, resource) {
			return this.upperCamelCase(
				`${this.bulkUpdateOperationName(resource)}_payload`
			)
		},
		bulkDeleteOperationName(options, resource) {
			return this.camelCase(this.pluralize(`delete_${resource.name}`))
		},
		bulkDeletePayloadName(options, resource) {
			return this.upperCamelCase(
				`${this.bulkDeleteOperationName(resource)}_payload`
			)
		},
	}
}