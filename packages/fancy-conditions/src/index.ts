export * from './filter-implementations/declaration.ts'

import { FILTER_METHODS_CONFIG, FILTER_TYPES_MAP } from './filter-implementations/index.ts'
import { inflection } from './inflection.ts'
import { fields } from './schema-fields.ts'
import { init } from './schema-init.ts'
import type { FilterMethod, FilterType } from './types.ts'

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
				...Object.entries(FILTER_METHODS_CONFIG).reduce(
					(acc, [filterMethod, { description }]) => {
						const name = `filterMethod:${filterMethod as FilterMethod}` as const
						acc[name] = {
							description: description
								|| `Allow filtering this field using ${filterMethod} operators`,
							entities: ['pgCodecAttribute'],
						}

						return acc
					},
					{} as BehaviourMap
				)
			},
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