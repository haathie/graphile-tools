
export const inflection: GraphileConfig.PluginInflectionConfig = {
	'add': {
		bulkUpdateOperationName(options, resource) {
			return this.camelCase(this.pluralize(`update_${resource.name}`))
		},
		bulkMutationPayloadName(options, resource) {
			return this.upperCamelCase(`${resource.name}_bulk_mutation_payload`)
		},
		bulkDeleteOperationName(options, resource) {
			return this.camelCase(this.pluralize(`delete_${resource.name}`))
		},
		onConflictEnumName() {
			return this.upperCamelCase('on_conflict_options')
		},
		bulkCreateOperationName(options, resource) {
			return this.camelCase(this.pluralize(`create_${resource.name}`))
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