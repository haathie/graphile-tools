import { RateLimiterPostgres } from 'rate-limiter-flexible'

export interface RateLimit {
	limit: number
	durationS: number // in seconds
}

export type RateLimitType = 'connection' | 'create'

export interface RateLimitsConfig {
	default?: RateLimit
	getRateLimitingKey(ctx: Grafast.Context): string | undefined
}

export type RateLimitParsedTag = {
	types: RateLimitType[]
	rateLimitName: string
	limit?: RateLimit
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
}

declare global {
	namespace GraphileConfig {
		interface Preset {
			rateLimits?: RateLimitsOptions
		}
	}

	namespace Grafast {
		interface Context {
			ipAddress?: string
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