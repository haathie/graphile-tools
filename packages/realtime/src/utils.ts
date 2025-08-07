import debug from 'debug'
import type { PgResource } from 'postgraphile/@dataplan/pg'

export const DEBUG = debug.default('@haathie/postgraphile-realtime:log')

export function isSubscribable(
	rsc: PgResource,
	{ behavior }: GraphileBuild.Build
) {
	const { codec } = rsc
	if(!codec.extensions?.isTableLike || !codec.attributes) {
		return false
	}

	if(!behavior.pgResourceMatches(rsc, 'subscribable')) {
		return false // not subscribable
	}

	const pgInfo = codec.extensions?.pg
	if(!pgInfo) {
		return false // no pg info, cannot subscribe
	}

	return true
}