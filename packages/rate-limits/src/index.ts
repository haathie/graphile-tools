export type * from './types.ts'
import { getRequestIp } from '@haathie/postgraphile-common-utils'
import { LRUCache } from 'lru-cache'
import type { Pool } from 'pg'
import type {} from 'postgraphile'
import type {} from 'postgraphile/adaptors/pg'
import { get, Step } from 'postgraphile/grafast'
import { RateLimiterPostgres } from 'rate-limiter-flexible'
import { RateLimitsStep } from './RateLimitsStep.ts'
import type { RateLimit, RateLimitsCache, RateLimitsConfig } from './types.ts'
import { DEBUG_LOG, DEFAULT_SCHEMA_NAME, DEFAULT_TABLE_NAME, executeRateLimitsDdl, getRateLimitsDescription, getRateLimitsToApply, parseRateLimitTag, scrapeCodecFromContext } from './utils.ts'

const RATE_LIMITS_TAG = 'rateLimits'

const UNAUTHENTICATED_KEY = 'unauthenticated'

const DEFAULT_CACHE_OPTS: LRUCache.Options<string, RateLimit, unknown> = {
	max: 2000,
	ttl: 10 * 60 * 1000, // 10 minutes
}

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
				const { options } = build
				if(!options.haathieRateLimits) {
					options.haathieRateLimits = {
						isAuthenticated() {
							return false
						},
					}
				}

				if(!options.haathieRateLimits.rateLimitsConfig?.[UNAUTHENTICATED_KEY]) {
					options.haathieRateLimits.rateLimitsConfig = {
						[UNAUTHENTICATED_KEY]: {
							...UNAUTHENTICATED_RATE_LIMIT_CONFIG,
							default: options.haathieRateLimits.defaultUnauthenticatedLimit
								|| UNAUTHENTICATED_RATE_LIMIT_CONFIG.default,
						},
						...options.haathieRateLimits.rateLimitsConfig,
					}
				}

				return build
			},
			'GraphQLObjectType_fields_field'(type, build, ctx) {
				const codec = scrapeCodecFromContext(ctx, build)
				if(!codec) {
					// no codec found, skip
					return type
				}

				const {
					scope: {
						fieldName,
					},
					Self
				} = ctx

				const rlsTags = codec.extensions?.haathieRateLimits
				const {
					options: {
						haathieRateLimits: {
							rateLimitsConfig = {},
							addRateLimitsToDescription
						} = {}
					}
				} = build
				const rateLimits = getRateLimitsToApply(
					rlsTags, rateLimitsConfig, ctx
				)

				if(!rateLimits?.length) {
					return type
				}

				const apiName = `${Self.name}.${fieldName}`
				DEBUG_LOG(
					`set rate limits for "${apiName}": `
					+ rateLimits.map(({ rateLimitName }) => rateLimitName).join(', ')
				)

				// ensure the rateLimit type is defined
				for(const { rateLimitName } of rateLimits) {
					if(!rateLimitsConfig[rateLimitName]) {
						throw new Error(
							`Rate limit "${rateLimitName}" is not defined in the options.`
						)
					}
				}

				if(addRateLimitsToDescription !== false) {
					const rlsDesc = getRateLimitsDescription(rateLimits, rateLimitsConfig)
					type.description = type.description
						? `${type.description}\n${rlsDesc}`
						: rlsDesc
				}

				const ogPlan = type.plan || type.extensions?.grafast?.plan
				// we'll wrap the existing plan to add the rate limits step
				type.plan = (plan, args, info) => {
					// we'll find if an existing RateLimitsStep is present at
					// some level in the plan. If it is, we'll apply the rate limit
					// to that step, otherwise we'll create a new RateLimitsStep.
					// Using this slightly hacky way as "deduplication" of the
					// "side effects" steps doesn't seem to work
					let step: RateLimitsStep | undefined
					if(plan instanceof Step) {
						const existingSteps = plan.operationPlan
							.getStepsByStepClass(RateLimitsStep)
						step = existingSteps.at(0)
					}

					if(!step) {
						step = new RateLimitsStep()
					}

					step.setRateLimits(apiName, rateLimits)
					return ogPlan?.(plan, args, info) || get(plan, fieldName)
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
					contextValue.ipAddress = getRequestIp(requestContext)
				}

				if(!schema?.haathieRateLimits) {
					return next()
				}

				if(!customRateLimitsCache) {
					customRateLimitsCache = new LRUCache({
						...DEFAULT_CACHE_OPTS,
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