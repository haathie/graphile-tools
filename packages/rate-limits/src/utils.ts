import { Pool } from 'pg'
import type {} from 'postgraphile'
import type {} from 'postgraphile/adaptors/pg'
import { GraphQLError } from 'postgraphile/graphql'
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible'
import type { RateLimit, RateLimitParsedTag, RateLimitsConfig, RateLimitsConfigMap, RateLimitsOptions, RateLimitType } from './types.ts'

type RateLimitableContext = GraphileBuild.ContextObjectFieldsField

type _RateLimiterInput = {
	limit: RateLimit
	name: string
	key: string
	apiName: string
}

export async function executeRateLimitsDdl(
	pool: Pool,
	{
		rateLimitsTableName = 'rate_limits',
		rateLimitsTableType = 'unlogged',
	}: RateLimitsOptions
) {
	const ddl = DDL
		.replaceAll('{{schema_name}}', 'postgraphile_meta')
		.replaceAll('{{table_name}}', rateLimitsTableName)
		.replaceAll('{{table_type}}', rateLimitsTableType)
	await pool.query(`BEGIN;\n${ddl}\nCOMMIT;`)
}

const DDL = `
CREATE SCHEMA IF NOT EXISTS {{schema_name}};
-- see: https://github.com/animir/node-rate-limiter-flexible/blob/2906f1a95e9b39d11e9706bdc19e210d11f815b5/lib/RateLimiterPostgres.js#L161
CREATE {{table_type}} TABLE IF NOT EXISTS "{{schema_name}}"."{{table_name}}" (
	key VARCHAR(255) PRIMARY KEY,
	points INT NOT NULL DEFAULT 0,
	expire BIGINT -- timestamp of expiry in ms
);
`

export async function executeRateLimitStep(
	ctx: Grafast.Context,
	apiName: string,
	rateLimits: RateLimitParsedTag[],
	configs: { [name: string]: RateLimitsConfig }
) {
	const finalLimits: _RateLimiterInput[] = []
	for(const rateLimit of rateLimits) {
		const { rateLimitName } = rateLimit
		const { getRateLimitingKey } = configs[rateLimitName]
		const key = getRateLimitingKey(ctx)
		if(!key) {
			continue // no key to limit
		}

		const limit = rateLimit.limit || configs[rateLimitName].default
		if(!limit) {
			continue
		}

		finalLimits.push({
			limit: limit,
			name: rateLimitName,
			key,
			apiName,
		})
	}

	if(!finalLimits.length) {
		return // no rate limits to apply
	}

	await ctx.withPgClient(ctx.pgSettings, async client => {
		for(const input of finalLimits) {
			const { limit, name, key, apiName } = input
			const limiter = new RateLimiterPostgres({
				storeClient: client.rawClient,
				storeType: 'client',
				schemaName: 'postgraphile_meta',
				tableName: 'rate_limits',
				tableCreated: true,
				points: limit.limit,
				duration: limit.durationS,
				keyPrefix: name + '_' + apiName,
			})
			try {
				await limiter.consume(key)
			} catch(err) {
				if(err instanceof RateLimiterRes) {
					const error = mapResToError(err, input)
					if(error) {
						throw error
					}
				}

				throw err
			}
		}
	})
}

function mapResToError(
	res: RateLimiterRes,
	{ limit, key, name, apiName }: _RateLimiterInput
): GraphQLError {
	return new GraphQLError(
		`You (${key}) have exceeded the "${name}" rate limit for "${apiName}". `
		+ `${res.consumedPoints}/${limit.limit} points consumed over ${limit.durationS}s`,
		{
			extensions: {
				statusCode: 429,
				headers: {
					'Retry-After': res.msBeforeNext / 1000,
					'X-RateLimit-Limit': limit.limit,
					'X-RateLimit-Remaining': res.remainingPoints,
					'X-RateLimit-Reset': Math.ceil((Date.now() + res.msBeforeNext) / 1000)
				}
			}
		}
	)
}

/**
 * Parses rate limit tag from a string.
 * @example "connection,create:unauthenticated:5/60s" ->
 * [
 * 	{
 * 		types: ['connection', 'create'],
 * 		rateLimitName: 'unauthenticated',
 * 		limit: { limit: 5, duration: 60 }
 * 	}
 * ]
 */
export function parseRateLimitTag(tag: unknown): RateLimitParsedTag[] | undefined {
	if(typeof tag !== 'string' || !tag.trim()) {
		return
	}

	const limits = tag.trim().split(' ')
	const parsed: RateLimitParsedTag[] = []
	for(const limitStr of limits) {
		const [typesStr, rateLimitName, limitStrWithDuration] = limitStr.split(':')
		if(!typesStr || !rateLimitName) {
			throw new Error(
				`Invalid rate limit tag format: ${limitStr}.
					Expected format: "type1,type2,...:rateLimitName:limit/duration".`
			)
		}

		const types = typesStr.split(',') as RateLimitType[]
		const parsedLimit: RateLimitParsedTag = {
			types,
			rateLimitName,
			limit: limitStrWithDuration
				? parseDuration(limitStrWithDuration)
				: undefined
		}
		parsed.push(parsedLimit)
	}

	return parsed
}

function parseDuration(durationStr: string): RateLimit | undefined {
	const [limit, duration] = durationStr.split('/')
	if(!limit || !duration) {
		return
	}

	return {
		limit: parseInt(limit, 10),
		durationS: parseInt(duration, 10)
	}
}

export function getRateLimitsToApply(
	parsedTags: RateLimitParsedTag[],
	availableConfigs: RateLimitsConfigMap,
	ctx: RateLimitableContext
): RateLimitParsedTag[] {
	const currentTypes = new Set(getRateLimitTypes(ctx))
	return parsedTags.filter(({ types }) => types.some(t => currentTypes.has(t)))
}

function *getRateLimitTypes(
	ctx: RateLimitableContext
): Generator<RateLimitType, void, void> {
	switch (ctx.type) {
	case 'GraphQLObjectType':
		const {
			isConnectionType,
			isPgFieldConnection,
		} = ctx.scope
		if(isConnectionType || isPgFieldConnection) {
			yield 'connection'
		}

		break
	default:
		throw new Error(`Unsupported type for rate limits: ${ctx.type}`)
	}
}