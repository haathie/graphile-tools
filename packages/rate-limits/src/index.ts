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
		const { ipAddress, haathieRateLimits } = ctx
		if(haathieRateLimits?.opts?.isAuthenticated(ctx)) {
			return
		}

		return ipAddress || 'unknown-ip'
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

				extensions.haathieRateLimits = rateLimits
			},
			'pgCodecs_attribute'(ctx, { attribute: { extensions } }) {
				const rateLimits
					= parseRateLimitTag(extensions?.tags?.[RATE_LIMITS_TAG])
				if(!rateLimits || !extensions) {
					return
				}

				extensions.haathieRateLimits = rateLimits
			}
		}
	},
	schema: {
		hooks: {
			'build'(build) {
				const { options: { haathieRateLimits } } = build
				if(!haathieRateLimits) {
					// no rate limits configured, skip
					return build
				}

				haathieRateLimits.rateLimitsConfig = {
					unauthenticated: {
						...UNAUTHENTICATED_RATE_LIMIT_CONFIG,
						default: haathieRateLimits.defaultUnauthenticatedLimit
							|| UNAUTHENTICATED_RATE_LIMIT_CONFIG.default,
					},
					...haathieRateLimits.rateLimitsConfig,
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

				const rlsTags = recordCodec?.extensions?.haathieRateLimits
					|| pgFieldAttribute?.extensions?.haathieRateLimits
				const {
					options: {
						haathieRateLimits: {
							rateLimitsConfig = {},
							addRateLimitsToDescription
						} = {}
					}
				} = build
				const applicableRateLimits = getRateLimitsToApply(
					rlsTags, rateLimitsConfig, ctx
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
					if(!rateLimitsConfig[rateLimitName]) {
						throw new Error(
							`Rate limit "${rateLimitName}" is not defined in the options.`
						)
					}
				}

				if(addRateLimitsToDescription !== false) {
					const rlsDesc = getRateLimitsDescription(
						applicableRateLimits, rateLimitsConfig
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
							rateLimitsConfig
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
						schema: { haathieRateLimits } = {}
					}
				} = opts

				if(!haathieRateLimits) {
					// no rate limits configured, skip
					return next()
				}

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

				await executeRateLimitsDdl(pool, haathieRateLimits)

				expiredLimiterClearer = new RateLimiterPostgres({
					storeType: 'pool',
					storeClient: pool,
					schemaName: DEFAULT_SCHEMA_NAME,
					tableName: haathieRateLimits.rateLimitsTableName || DEFAULT_TABLE_NAME,
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
				{ args: { contextValue, requestContext, resolvedPreset: { schema } = {} } }
			) {
				if(!contextValue.ipAddress && requestContext) {
					contextValue.ipAddress = getRequestIp(
						// @ts-expect-error -- types may differ
						requestContext
					)
				}

				if(!schema?.haathieRateLimits) {
					return next()
				}

				if(!customRateLimitsCache) {
					customRateLimitsCache = new LRUCache({
						max: 2000,
						ttl: 10 * 60 * 1000, // 10 minutes
						...schema?.haathieRateLimits?.customRateLimitsCacheOpts,
					})
				}

				contextValue.haathieRateLimits = {
					opts: schema.haathieRateLimits,
					customRateLimitsCache
				}

				return next()
			},
		}
	},
}