import type { LRUCache } from 'lru-cache'
import type { IRateLimiterPostgresOptions, RateLimiterPostgres } from 'rate-limiter-flexible'

export interface RateLimit {
	max: number
	durationS: number // in seconds
}

export type RateLimitType = 'connection'
	| 'field'
	| 'create'
	| 'update'
	| 'delete'

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
	/**
	 * Add roles that should be given access to the rate limits table.
	 * The rate limits table is read/written by the same client that is
	 * making the request, so it needs to be accessible by the client.
	 */
	rolesToGiveAccessTo?: string[]

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

	/**
	 * Mention applicable rate limits in the GraphQL type description.
	 * @default true
	 */
	addRateLimitsToDescription?: boolean

	defaultUnauthenticatedLimit?: RateLimit
	/**
	 * Configure different rate limit types
	 */
	rateLimitsConfig?: RateLimitsConfigMap
}

export type RateLimitsCache = LRUCache<string, RateLimit>

declare global {

	namespace Grafast {
		interface Context {
			haathieRateLimits?: {
				opts: RateLimitsOptions
				customRateLimitsCache: RateLimitsCache
			}
			ipAddress?: string
		}
	}

	namespace GraphileBuild {
		interface SchemaOptions {
			haathieRateLimits?: RateLimitsOptions
		}
	}

	namespace DataplanPg {
		interface PgCodecExtensions {
			haathieRateLimits?: RateLimitParsedTag[]
		}

		interface PgCodecAttributeExtensions {
			haathieRateLimits?: RateLimitParsedTag[]
		}
	}
}