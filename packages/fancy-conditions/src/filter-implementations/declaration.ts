import type { FilterApply, FilterImplementation, FilterMethod, FilterMethodConfig, FilterType } from '../types.ts'

/**
 * Store configuration for each filter method.
 */
export const FILTER_METHODS_CONFIG: { [K in FilterMethod]?: FilterMethodConfig } = {}
/**
 * Store implementations for each filter type.
 */
export const FILTER_TYPES_MAP: { [K in FilterType]?: FilterImplementation } = {}

/**
 * Register implementations for the given filter types.
 * If a filter type is already registered, and you attempt to re-register it,
 * it will throw an error.
 */
export function registerFilterImplementations(
	impls: { [K in FilterType]?: FilterImplementation }
) {
	for(const [type, impl] of Object.entries(impls)) {
		if(FILTER_TYPES_MAP[type as FilterType]) {
			throw new Error(`Filter type ${type} is already registered.`)
		}

		FILTER_TYPES_MAP[type as FilterType] = impl
	}
}

export function registerFilterMethod<T = unknown>(
	method: FilterMethod,
	config: FilterMethodConfig,
	applys: { [K in FilterType]?: FilterApply<T> }
) {
	if(FILTER_METHODS_CONFIG[method]) {
		throw new Error(`Filter method ${method} is already registered.`)
	}

	FILTER_METHODS_CONFIG[method] = config
	for(const [type, apply] of Object.entries(applys)) {
		const impl = FILTER_TYPES_MAP[type as FilterType]
		if(!impl) {
			continue
		}

		impl.applys ||= {}
		impl.applys[method] = apply as FilterApply<unknown>
	}
}

registerFilterImplementations({
	'eq': {
		getType(codec, getGraphQlType) {
			// for eq -- we just return the field type
			return getGraphQlType()
		},
	},
	'eqIn': {
		getType(codec, getGraphQlType, { graphql: { GraphQLList } }) {
			return new GraphQLList(getGraphQlType())
		},
	},
	'range': {
		getRegisterTypeInfo(fieldCodec, getGraphQlType, { inflection }) {
			return {
				name: inflection.rangeConditionTypeName(fieldCodec),
				spec: () => ({
					description: 'Filter values falling in an inclusive range',
					fields() {
						const fieldType = getGraphQlType()
						if(!('name' in fieldType)) {
							throw new Error('Cannot build range condition on a non-named type')
						}

						return {
							from: { type: fieldType },
							to: { type: fieldType }
						}
					}
				}),
			}
		},
		getType(fieldCodec, _, { inflection, getInputTypeByName }) {
			return getInputTypeByName(inflection.rangeConditionTypeName(fieldCodec))
		},
	},
	'icontains': {
		getType(fieldCodec, getGraphQlType, { graphql: { GraphQLNonNull, GraphQLScalarType } }) {
			let fieldType = getGraphQlType()
			fieldType = fieldType instanceof GraphQLNonNull
				? fieldType.ofType
				: fieldType
			if(!(fieldType instanceof GraphQLScalarType)) {
				throw new Error('Cannot build contains condition on a non-scalar type')
			}

			return fieldType
		},
	}
})