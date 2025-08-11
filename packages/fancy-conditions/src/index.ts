import { FILTER_METHODS, FILTER_METHODS_CONFIG, FILTER_TYPES_MAP } from './filters.ts'
import { inflection } from './inflection.ts'
import { fields } from './schema-fields.ts'
import { init } from './schema-init.ts'
import type { FilterType } from './types.ts'

type BehaviourMap = Partial<Record<keyof GraphileBuild.BehaviorStrings, {
	description: string
	entities: ReadonlyArray<keyof GraphileBuild.BehaviorEntities>
}>>

export const FancyConditionsPlugin: GraphileConfig.Plugin = {
	name: 'FancyConditionsPlugin',
	version: '0.0.1',
	inflection,
	schema: {
		behaviorRegistry: {
			add: {
				...Object.entries(FILTER_TYPES_MAP).reduce(
					(acc, [filterType, { description }]) => {
						const behaviourName = `filterType:${filterType as FilterType}` as const
						acc[behaviourName] = {
							description: description || `Add ${filterType} filter type`,
							entities: ['pgCodecAttribute'],
						}
						return acc
					},
					{} as BehaviourMap
				),
				...FILTER_METHODS.reduce(
					(acc, filterMethod) => {
						const name = `filterMethod:${filterMethod}` as const
						acc[name] = {
							description: FILTER_METHODS_CONFIG[filterMethod].description
								|| `Allow filtering this field using ${filterMethod} operators`,
							entities: ['pgCodecAttribute'],
						}

						return acc
					},
					{} as BehaviourMap
				)
			}
		},
		hooks: {
			build(build) {
				return build
					.extend(build, { inputConditionTypes: {} }, 'FancyConditionsPlugin')
			},
			init: init,
			'GraphQLInputObjectType_fields': fields,
		}
	}
}