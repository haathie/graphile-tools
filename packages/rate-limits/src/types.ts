import { LRUCache } from 'lru-cache'
import { IRateLimiterPostgresOptions, RateLimiterPostgres } from 'rate-limiter-flexible'

export interface RateLimit {
	max: number
	durationS: number // in seconds
}

export type RateLimitType = 'connection' | 'create' | 'field'

export interface RateLimitsConfig {
	/**
	 * Specify a default rate limit to be applied to all
	 * root level queries, mutations, and subscriptions.
	 * Leave undefined to not apply a default rate limit.
	 *
	 * This will also be used if a @rateLimits tag does not specify a limit.
	 */
	default?: RateLimit
	/**
	 * Get the rate limiting key for the current request.
	 * Eg. user ID, organisation ID, etc.
	 */
	getRateLimitingKey(ctx: Grafast.Context): string | undefined
	/**
	 * Potentially override the default rate limit for this key.
	 */
	getRateLimit?(
		key: string,
		ctx: Grafast.Context
	): Promise<RateLimit | undefined> | RateLimit | undefined
}

export type RateLimitParsedTag = {
	types: RateLimitType[]
	rateLimitName: string
	limit?: RateLimit
	defaultApplied?: boolean
}

export type RateLimiter = {
	config: RateLimitsConfig
	limiter: RateLimiterPostgres
}

export type RateLimitsConfigMap = { [name: string]: RateLimitsConfig }

export type RateLimitsOptions = {
	/**
	 * Name of the table to store rate limits.
	 * Will be installed in the "postgraphile_meta" schema.
	 * @default 'rate_limits'
	 */
	rateLimitsTableName?: string
	rateLimitsTableType?: 'unlogged' | 'logged'

	rateLimiterPgOpts?: (limit: RateLimit) => Partial<IRateLimiterPostgresOptions>
	/**
	 * Tell us if the current request is authenticated.
	 * The "unauthenticated" rate limiter will use this to determine
	 * if it should apply the unauthenticated rate limits.
	 */
	isAuthenticated(ctx: Grafast.Context): boolean
	/**
	 * Specify default options for the rate limits.
	 */
	customRateLimitsCacheOpts?: LRUCache.Options<string, RateLimit, unknown>
}

export type RateLimitsCache = LRUCache<string, RateLimit>

declare global {
	namespace GraphileConfig {
		interface Preset {
			rateLimits: RateLimitsOptions
		}
	}

	namespace Grafast {
		interface Context {
			ipAddress?: string
			rateLimitsOpts: RateLimitsOptions
			customRateLimitsCache: RateLimitsCache
		}
	}

	namespace GraphileBuild {

		interface BehaviorStrings {
			'subscribable': true
		}

		interface SchemaOptions {
			/**
			 * Mention applicable rate limits in the GraphQL type description.
			 * @default true
			 */
			addRateLimitsToDescription?: boolean

			defaultUnauthenticatedLimit?: RateLimit
			rateLimits?: RateLimitsConfigMap
		}
	}

	namespace DataplanPg {
		interface PgCodecExtensions {
			rateLimits?: RateLimitParsedTag[]
		}

		interface PgCodecAttributeExtensions {
			rateLimits?: RateLimitParsedTag[]
		}
	}
}