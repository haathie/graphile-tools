
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
		onConflictEnumName() {
			return this.upperCamelCase('on_conflict_options')
		},
		bulkCreateOperationName(options, resource) {
			return this.camelCase(this.pluralize(`create_${resource.name}`))
		},
		bulkCreatePayloadName(options, resource) {
			return this.upperCamelCase(
				`${this.bulkCreateOperationName(resource)}_payload`
			)
		},
		bulkCreateInputObjectName(options, resource) {
			return this.upperCamelCase(
				`${resource.name}_create_item`
			)
		},
		bulkCreateInputObjectRelationName(options, path) {
			return this.upperCamelCase(
				`${path.join('_')}_create_item`
			)
		}
	}
}