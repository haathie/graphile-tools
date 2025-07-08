import { getRequestIp } from '@haathie/graphile-common-utils'
import { Pool } from 'pg'
import type {} from 'postgraphile'
import type {} from 'postgraphile/adaptors/pg'
import { context, sideEffect } from 'postgraphile/grafast'
import type { RateLimitsConfig } from './types.ts'
import { executeRateLimitsDdl, executeRateLimitStep, getRateLimitsToApply, parseRateLimitTag } from './utils.ts'

const RATE_LIMITS_TAG = 'rateLimits'

const UNAUTHENTICATED_RATE_LIMIT_CONFIG: RateLimitsConfig = {
	'default': { limit: 60, durationS: 60 },
	getRateLimitingKey(ctx) {
		return ctx.ipAddress || 'unknown-ip'
	}
}

export const RateLimitsPlugin: GraphileConfig.Plugin = {
	name: 'RateLimitsPlugin',
	grafast: {
		middleware: {
			prepareArgs(next, { args }) {
				if(args.contextValue.ipAddress || !args.requestContext) {
					return next()
				}

				args.contextValue.ipAddress = getRequestIp(
					// @ts-expect-error -- types may differ
					args.requestContext
				)
				return next()
			},
		}
	},
	gather: {
		'hooks': {
			'pgCodecs_PgCodec'(ctx, { pgCodec: { extensions } }) {
				const rateLimits
					= parseRateLimitTag(extensions?.tags?.[RATE_LIMITS_TAG])
				if(!rateLimits || !extensions) {
					return
				}

				extensions.rateLimits = rateLimits
			}
		}
	},
	schema: {
		hooks: {
			'build'(build) {
				build.options.rateLimits = {
					unauthenticated: UNAUTHENTICATED_RATE_LIMIT_CONFIG,
					...build.options.rateLimits,
				}

				return build
			},
			'GraphQLObjectType_fields_field'(type, build, ctx) {
				const {
					scope: { fieldName, pgFieldResource: { codec } = {} }
				} = ctx
				if(!codec?.extensions?.rateLimits) {
					return type
				}

				const applicableRateLimits = getRateLimitsToApply(
					codec.extensions.rateLimits, build.options.rateLimits!, ctx
				)
				if(!applicableRateLimits?.length) {
					return type
				}

				// ensure the rateLimit type is defined
				for(const { rateLimitName } of applicableRateLimits) {
					if(!build.options.rateLimits?.[rateLimitName]) {
						throw new Error(
							`Rate limit "${rateLimitName}" is not defined in the options.`
						)
					}
				}

				const ogPlan = type.plan
				type.plan = (plan, args, info) => {
					sideEffect(context(), ctx => (
						executeRateLimitStep(
							ctx,
							fieldName,
							applicableRateLimits,
							build.options.rateLimits!
						)
					))
					return ogPlan?.(plan, args, info) || plan
				}

				return type
			},
		}
	},
	grafserv: {
		middleware: {
			async setPreset(
				next,
				opts
			) {
				const {
					resolvedPreset: {
						pgServices,
						rateLimits: rateLimitsOpts = {},
					}
				} = opts

				let pool: Pool | undefined
				for(const service of pgServices || []) {
					pool = service.adaptorSettings?.superuserPool
					if(!pool) {
						continue
					}
				}

				if(!pool) {
					throw new Error('RateLimitsPlugin requires a PG pool to be configured.')
				}

				await executeRateLimitsDdl(pool, rateLimitsOpts)

				return next()
			},
			// async processRequest(next, event) {
			// 	const final = await next()
			// 	if(final?.type === 'graphql') {
			//
			// 	}
			// },
		}
	}
}