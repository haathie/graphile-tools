import { RateLimiterPostgres } from 'rate-limiter-flexible'

export interface RateLimit {
	limit: number
	durationS: number // in seconds
}

export type RateLimitType = 'connection' | 'create'

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
	getRateLimit?(key: string): Promise<RateLimit | undefined> | RateLimit | undefined
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
	 * Tell us if the current request is authenticated.
	 * The "unauthenticated" rate limiter will use this to determine
	 * if it should apply the unauthenticated rate limits.
	 */
	isAuthenticated(ctx: Grafast.Context): boolean
}

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
		}
	}

	namespace GraphileBuild {

		interface BehaviorStrings {
			'subscribable': true
		}

		interface SchemaOptions {
			rateLimits?: RateLimitsConfigMap
		}
	}

	namespace DataplanPg {
		interface PgCodecExtensions {
			rateLimits?: RateLimitParsedTag[]
		}
	}
}