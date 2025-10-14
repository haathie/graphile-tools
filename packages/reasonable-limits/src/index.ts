import type {} from 'postgraphile'
import type { PgCodec } from 'postgraphile/@dataplan/pg'

export const MAX_RECORDS_PER_PAGE = 100
export const DEFAULT_RECORDS_PER_PAGE = 10
const MAX_RECORDS_TAG = 'maxRecordsPerPage'
const DEFAULT_RECORDS_TAG = 'defaultRecordsPerPage'

export const ReasonableLimitsPlugin: GraphileConfig.Plugin = {
	name: 'ReasonableLimitsPlugin',
	schema: {
		hooks: {
			'GraphQLObjectType_fields_field'(fields, build, ctx) {
				const {
					scope: {
						pgFieldResource,
						isPgFieldConnection,
						isPgManyRelationConnectionField,
						isRootQuery,
					},
				} = ctx
				const {
					grafast: { sideEffect },
					graphql: { GraphQLError }
				} = build
				const codec = pgFieldResource?.codec as PgCodec
				const isLimitField = codec && isRootQuery && (
					isPgFieldConnection || isPgManyRelationConnectionField
				)
				if(!isLimitField || !pgFieldResource) {
					return fields
				}

				const maxValue = getIntTag(codec, MAX_RECORDS_TAG) || MAX_RECORDS_PER_PAGE

				const ogPlan = fields.plan
				fields.plan = (...params) => {
					const [, args] = params
					sideEffect(args.getRaw(), arg => {
						assertLessThanMax(arg, 'first', maxValue)
						assertLessThanMax(arg, 'last', maxValue)

						if(
							typeof arg.first === 'number'
							|| typeof arg.last === 'number'
						) {
							return
						}

						if(arg.first === null || arg.last === null) {
							throw new GraphQLError(
								'"first" or "last" cannot be null without a number being provided'
								+ ' for the other',
								{ extensions: { statusCode: 400 } }
							)
						}
					})

					return ogPlan?.(...params)
				}

				return fields

				function assertLessThanMax(obj: any, key: string, max: number) {
					const value = obj[key]
					if(typeof value === 'number' && value > max) {
						throw new GraphQLError(
							`Maximum of ${max} ${key} records can be requested per page`,
							{ extensions: { statusCode: 400 } }
						)
					}
				}
			},
			'GraphQLObjectType_fields_field_args_arg'(input, build, ctx) {
				const {
					scope: {
						pgFieldResource,
						isPgFieldConnection,
						isPgManyRelationConnectionField,
						argName
					}
				} = ctx
				const codec = pgFieldResource?.codec as PgCodec
				const isLimitField = codec
					&& (isPgFieldConnection || isPgManyRelationConnectionField)
					&& (argName === 'first' || argName === 'last')
				if(!isLimitField || !pgFieldResource) {
					return input
				}

				const maxValue = getIntTag(codec, MAX_RECORDS_TAG) || MAX_RECORDS_PER_PAGE

				input.description ||= ''
				input.description += `\nMax: ${maxValue}`

				if(argName !== 'first') {
					return input
				}

				const defaultValue = getIntTag(codec, DEFAULT_RECORDS_TAG)
					|| DEFAULT_RECORDS_PER_PAGE

				if(
					typeof input.defaultValue === 'undefined'
					&& typeof defaultValue === 'number'
				) {
					input.defaultValue = defaultValue
				}

				return input
			}
		}
	}
}

function getIntTag(codec: PgCodec, tag: string) {
	const tags = codec.extensions?.tags
	const value = tags?.[tag]
	if(typeof value !== 'number' && typeof value !== 'string') {
		return undefined
	}

	const num = +value
	if(!Number.isInteger(num) || num <= 0) {
		throw new Error(
			`"${DEFAULT_RECORDS_TAG}" must be a +int, got "${value}"`
		)
	}

	return num
}