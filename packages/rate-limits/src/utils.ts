import { Pool } from 'pg'
import type {} from 'postgraphile'
import type {} from 'postgraphile/adaptors/pg'
import { GraphQLError } from 'postgraphile/graphql'
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible'
// @ts-expect-error
import BlockedKeys from 'rate-limiter-flexible/lib/component/BlockedKeys/index.js'
import type { RateLimit, RateLimitParsedTag, RateLimitsConfigMap, RateLimitsOptions, RateLimitType } from './types.ts'

type RateLimitableContext = GraphileBuild.ContextObjectFieldsField

type _RateLimiterInput = {
	limit: RateLimit
	name: string
	key: string
	apiName: string
}

export const DEFAULT_TABLE_NAME = 'rate_limits'
export const DEFAULT_SCHEMA_NAME = 'postgraphile_meta'

const DDL = `
CREATE SCHEMA IF NOT EXISTS {{schema_name}};
-- see: https://github.com/animir/node-rate-limiter-flexible/blob/2906f1a95e9b39d11e9706bdc19e210d11f815b5/lib/RateLimiterPostgres.js#L161
CREATE {{table_type}} TABLE IF NOT EXISTS "{{schema_name}}"."{{table_name}}" (
	key VARCHAR(255) PRIMARY KEY,
	points INT NOT NULL DEFAULT 0,
	expire BIGINT -- timestamp of expiry in ms
);
`

// As we have a RateLimiterPostgres instance per request,
// we need to ensure that the blocked keys are shared across all instances,
// if in memory blocking is enabled
const GLOBAL_BLOCKED_KEYS = new BlockedKeys()

export async function executeRateLimitsDdl(
	pool: Pool,
	{
		rateLimitsTableName = DEFAULT_TABLE_NAME,
		rateLimitsTableType = 'unlogged',
		rolesToGiveAccessTo = []
	}: RateLimitsOptions,
) {
	let ddl = DDL
	for(const role of rolesToGiveAccessTo) {
		if(!role) {
			continue
		}

		ddl += `GRANT SELECT, INSERT, UPDATE, DELETE ON
			"{{schema_name}}"."{{table_name}}" TO "${role}";\n`
	}

	ddl = ddl
		.replaceAll('{{schema_name}}', DEFAULT_SCHEMA_NAME)
		.replaceAll('{{table_name}}', rateLimitsTableName)
		.replaceAll('{{table_type}}', rateLimitsTableType)

	await pool.query(`BEGIN;\n${ddl}\nCOMMIT;`)
}

export async function applyRateLimits(
	rateLimitMap: { [apiName: string]: RateLimitParsedTag[] },
	ctx: Grafast.Context,
) {
	const {
		pgSettings,
		withPgClient,
		haathieRateLimits: {
			opts: {
				rateLimitsTableName = DEFAULT_TABLE_NAME,
				rateLimiterPgOpts,
				rateLimitsConfig = {}
			} = {},
			customRateLimitsCache
		} = {},
	} = ctx
	const finalLimits: _RateLimiterInput[] = []

	for(const apiName in rateLimitMap) {
		for(const rateLimit of rateLimitMap[apiName]) {
			const { rateLimitName } = rateLimit
			const { getRateLimitingKey, getRateLimit } = rateLimitsConfig[rateLimitName]
			const key = getRateLimitingKey(ctx)
			if(!key) {
				continue // no key to limit
			}

			const customLimitCached = customRateLimitsCache?.get(key)
			const customLimit = customLimitCached || await getRateLimit?.(key, ctx)
			const limit = customLimit
				|| rateLimit.limit
				|| rateLimitsConfig[rateLimitName].default
			if(!limit) {
				continue
			}

			finalLimits.push({
				limit: limit,
				name: rateLimitName,
				key,
				apiName,
			})

			if(customLimit && !customLimitCached) {
				// set the custom limit in the cache
				customRateLimitsCache?.set(key, customLimit)
			}

			console.debug(
				{ key, limit, name: rateLimitName, apiName, isCustom: !!customLimit },
				'applying rate limit'
			)
		}
	}

	if(!finalLimits.length) {
		return // no rate limits to apply
	}

	await withPgClient(pgSettings, async client => {
		for(const input of finalLimits) {
			const { limit, name, key, apiName } = input
			const limiter = new RateLimiterPostgres({
				storeClient: client.rawClient,
				storeType: 'client',
				schemaName: DEFAULT_SCHEMA_NAME,
				tableName: rateLimitsTableName,
				tableCreated: true,
				points: limit.max,
				duration: limit.durationS,
				keyPrefix: name + '_' + apiName,
				clearExpiredByTimeout: false,
				...rateLimiterPgOpts?.(limit)
			})
			// @ts-expect-error -- share blocked keys globally, hack.
			limiter['_inMemoryBlockedKeys'] = GLOBAL_BLOCKED_KEYS

			try {
				await limiter.consume(key)
			} catch(err) {
				if(err instanceof RateLimiterRes) {
					throw mapResToError(err, input)
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
	// consumedPoints is set to 0, when in memory blocking is enabled
	const consumed = res.consumedPoints || limit.max
	return new GraphQLError(
		`You (${key}) have exceeded the "${name}" rate limit for "${apiName}". `
		+ `${consumed}/${limit.max} points consumed over ${limit.durationS}s`,
		{
			extensions: {
				statusCode: 429,
				headers: {
					'Retry-After': res.msBeforeNext / 1000,
					'X-RateLimit-Limit': limit.max,
					'X-RateLimit-Remaining': res.remainingPoints,
					'X-RateLimit-Reset': Math.ceil((Date.now() + res.msBeforeNext) / 1000)
				}
			}
		}
	)
}

export function getRateLimitsDescription(
	rateLimits: RateLimitParsedTag[],
	configs: RateLimitsConfigMap
) {
	const strs = ['**@rateLimits**']
	for(const { rateLimitName, limit: limitInp } of rateLimits) {
		const limit = limitInp || configs[rateLimitName]?.default
		if(!limit) {
			continue // no limit defined
		}

		strs.push(`${rateLimitName}: ${limit.max}/${limit.durationS}s`)
	}

	return strs.join('\n')
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
				`Invalid rate limit tag format: "${limitStr}".
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
		max: parseInt(limit, 10),
		// TODO: parse duration string to seconds
		durationS: parseInt(duration, 10)
	}
}

export function getRateLimitsToApply(
	parsedTags: RateLimitParsedTag[] | undefined,
	availableConfigs: RateLimitsConfigMap,
	ctx: RateLimitableContext
): RateLimitParsedTag[] {
	const currentTypes = new Set(getRateLimitTypes(ctx))
	const relevantTags = parsedTags
		?.filter(({ types }) => types.some(t => currentTypes.has(t))) || []

	if(!isRoot(ctx)) {
		return relevantTags
	}

	for(const name in availableConfigs) {
		const value = availableConfigs[name]
		if(!value.default) {
			continue
		}

		if(relevantTags.some(tag => tag.rateLimitName === name)) {
			continue // already has this rate limit
		}

		// add the default rate limit if not already present
		relevantTags.push({
			types: [],
			rateLimitName: name,
			limit: value.default,
			defaultApplied: true,
		})
	}

	return relevantTags
}

function isRoot({ scope }: RateLimitableContext) {
	return !!scope.isRootMutation
		|| !!scope.isRootQuery
		|| !!scope.isRootSubscription
}

function *getRateLimitTypes(
	{ type, scope }: RateLimitableContext
): Generator<RateLimitType, void, void> {
	switch (type) {
	case 'GraphQLObjectType':
		const {
			isConnectionType,
			isPgFieldConnection,
			pgCodec,
			pgFieldAttribute
		} = scope
		if(isConnectionType || isPgFieldConnection) {
			yield 'connection'
		}

		if(pgCodec && pgFieldAttribute) {
			yield 'field'
		}

		break
	default:
		throw new Error(`Unsupported type for rate limits: ${type}`)
	}
}