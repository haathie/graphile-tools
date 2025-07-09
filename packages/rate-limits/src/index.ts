import { getRequestIp } from '@haathie/graphile-common-utils'
import { LRUCache } from 'lru-cache'
import { Pool } from 'pg'
import type {} from 'postgraphile'
import type {} from 'postgraphile/adaptors/pg'
import { context, sideEffect } from 'postgraphile/grafast'
import { RateLimiterPostgres } from 'rate-limiter-flexible'
import type { RateLimitsCache, RateLimitsConfig } from './types.ts'
import { applyRateLimits, DEFAULT_SCHEMA_NAME, DEFAULT_TABLE_NAME, executeRateLimitsDdl, getRateLimitsDescription, getRateLimitsToApply, parseRateLimitTag } from './utils.ts'

const RATE_LIMITS_TAG = 'rateLimits'

const UNAUTHENTICATED_RATE_LIMIT_CONFIG: RateLimitsConfig = {
	'default': { max: 60, durationS: 60 },
	getRateLimitingKey(ctx) {
		if(ctx.rateLimitsOpts.isAuthenticated(ctx)) {
			return
		}

		return ctx.ipAddress || 'unknown-ip'
	}
}

// we'll have this rate limiter to clear expired rate limits
// in the background.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let expiredLimiterClearer: RateLimiterPostgres
let customRateLimitsCache: RateLimitsCache | undefined

export const RateLimitsPlugin: GraphileConfig.Plugin = {
	name: 'RateLimitsPlugin',
	gather: {
		'hooks': {
			'pgCodecs_PgCodec'(ctx, { pgCodec: { extensions } }) {
				const rateLimits
					= parseRateLimitTag(extensions?.tags?.[RATE_LIMITS_TAG])
				if(!rateLimits || !extensions) {
					return
				}

				extensions.rateLimits = rateLimits
			},
			'pgCodecs_attribute'(ctx, { attribute: { extensions } }) {
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
					unauthenticated: {
						...UNAUTHENTICATED_RATE_LIMIT_CONFIG,
						default: build.options.defaultUnauthenticatedLimit
							|| UNAUTHENTICATED_RATE_LIMIT_CONFIG.default,
					},
					...build.options.rateLimits,
				}

				return build
			},
			'GraphQLObjectType_fields_field'(type, build, ctx) {
				const {
					scope: {
						fieldName,
						pgFieldResource: { codec: recordCodec } = {},
						pgFieldAttribute
					},
					Self
				} = ctx
				if(!recordCodec && !pgFieldAttribute) {
					return type
				}

				const rlsTags = recordCodec?.extensions?.rateLimits
					|| pgFieldAttribute?.extensions?.rateLimits
				const {
					options: { rateLimits = {}, addRateLimitsToDescription }
				} = build
				const applicableRateLimits = getRateLimitsToApply(
					rlsTags, rateLimits, ctx
				)

				if(!applicableRateLimits?.length) {
					return type
				}

				const apiName = `${Self.name}.${fieldName}`
				console.log(
					`got ${applicableRateLimits.length} applicable rate`
						+ ` limits for "${apiName}" field`,
				)

				// ensure the rateLimit type is defined
				for(const { rateLimitName } of applicableRateLimits) {
					if(!rateLimits[rateLimitName]) {
						throw new Error(
							`Rate limit "${rateLimitName}" is not defined in the options.`
						)
					}
				}

				if(addRateLimitsToDescription !== false) {
					const rlsDesc = getRateLimitsDescription(
						applicableRateLimits, rateLimits
					)
					type.description = type.description
						? `${type.description}\n${rlsDesc}`
						: rlsDesc
				}

				const ogPlan = type.plan
				type.plan = (plan, args, info) => {
					sideEffect(context(), ctx => (
						applyRateLimits(
							ctx,
							apiName,
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
						rateLimits: rateLimitsOpts,
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

				expiredLimiterClearer = new RateLimiterPostgres({
					storeType: 'pool',
					storeClient: pool,
					schemaName: DEFAULT_SCHEMA_NAME,
					tableName: rateLimitsOpts.rateLimitsTableName || DEFAULT_TABLE_NAME,
					tableCreated: true,
					clearExpiredByTimeout: true,
				})

				return next()
			},
		}
	},
	grafast: {
		middleware: {
			prepareArgs(
				next,
				{ args: { contextValue, requestContext, resolvedPreset } }
			) {
				if(!contextValue.ipAddress && requestContext) {
					contextValue.ipAddress = getRequestIp(
						// @ts-expect-error -- types may differ
						requestContext
					)
				}

				contextValue.rateLimitsOpts = resolvedPreset?.rateLimits!
				if(!customRateLimitsCache) {
					customRateLimitsCache = new LRUCache({
						max: 2000,
						ttl: 10 * 60 * 1000, // 10 minutes
						...resolvedPreset?.rateLimits?.customRateLimitsCacheOpts,
					})
				}

				contextValue.customRateLimitsCache = customRateLimitsCache

				return next()
			},
		}
	},
}