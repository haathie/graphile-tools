import type { PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'

export const inflection: GraphileConfig.PluginInflectionConfig = {
	add: {
		conditionContainerTypeName(options, resource, attrName) {
			const attrFieldName = this._attributeName({
				codec: resource.codec as PgCodecWithAttributes,
				attributeName: attrName,
			})
			return this.upperCamelCase(
				`${this._resourceName(resource)}_${attrFieldName}_condition`
			)
		},
		rangeConditionTypeName(options, codec) {
			return this.upperCamelCase(
				`${this._codecName(codec)}_range_condition`
			)
		},
	}
}