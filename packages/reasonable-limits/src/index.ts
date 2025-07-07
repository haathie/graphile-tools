import type {} from 'postgraphile'
import type { PgCodec } from 'postgraphile/@dataplan/pg'
import { sideEffect } from 'postgraphile/grafast'

const MAX_RECORDS_PER_PAGE = 100
const DEFAULT_RECORDS_PER_PAGE = 10
const MAX_RECORDS_TAG = 'maxRecordsPerPage'
const DEFAULT_RECORDS_TAG = 'defaultRecordsPerPage'

export const ReasonableLimitsPlugin: GraphileConfig.Plugin = {
	name: 'ReasonableLimitsPlugin',
	schema: {
		hooks: {
			'GraphQLObjectType_fields_field_args_arg'(input, build, ctx) {
				const {
					scope: {
						pgFieldResource,
						isPgFieldConnection,
						isPgManyRelationConnectionField,
						fieldName,
						argName
					}
				} = ctx
				const codec = pgFieldResource?.codec as PgCodec
				const isLimitField = codec
					&& (isPgFieldConnection || isPgManyRelationConnectionField)
					&& (argName === 'first' || argName === 'last')
				const isFirst = argName === 'first'
				if(!isLimitField || !pgFieldResource) {
					return input
				}

				const defaultValue = isFirst
					? getIntTag(DEFAULT_RECORDS_TAG) || DEFAULT_RECORDS_PER_PAGE
					: undefined
				const maxValue = getIntTag(MAX_RECORDS_TAG) || MAX_RECORDS_PER_PAGE
				const relation = isPgManyRelationConnectionField
					? pgFieldResource.name
					: 'query'
				console.debug(
					`ReasonableLimits: Applying limits to "${argName}" argument`
					+ ` of ${relation}."${fieldName}". Max: ${maxValue}`
					+ (
						typeof defaultValue === 'number'
							? `, default: ${defaultValue}`
							: ''
					)
				)

				if(
					typeof input.defaultValue === 'undefined'
					&& typeof defaultValue === 'number'
				) {
					input.defaultValue = defaultValue
				}

				const ogPlan = input.applyPlan
				input.applyPlan = (plan, fieldPlan, input, info) => {
					sideEffect(input.getRaw(), f => {
						if(typeof f === 'number' && f > maxValue) {
							throw new Error(
								`Maximum of ${maxValue} records can be requested per page`
							)
						}
					})

					return ogPlan?.(plan, fieldPlan, input, info)
				}

				return input

				function getIntTag(tag: string) {
					const tags = codec.extensions?.tags
					const defaultValue = tags?.[tag]
					if(
						typeof defaultValue !== 'number'
						&& typeof defaultValue !== 'string'
					) {
						return undefined
					}

					const defaultValueNum = +defaultValue
					if(!Number.isInteger(defaultValueNum) || defaultValueNum <= 0) {
						throw new Error(
							`"${DEFAULT_RECORDS_TAG}" must be a +int, got "${defaultValue}"`
						)
					}

					return defaultValueNum
				}
			}
		}
	}
}