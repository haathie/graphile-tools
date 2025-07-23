import debug from 'debug'
import type { PgCodec, PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'

export const DEBUG = debug.default('@haathie/postgraphile-fancy-mutations:log')

export function isSubscribable(
	codec: PgCodec,
	{ behavior }: GraphileBuild.Build
): codec is PgCodecWithAttributes {
	if(!codec.extensions?.isTableLike || !codec.attributes) {
		return false
	}

	if(!behavior.pgCodecMatches(codec, 'subscribable')) {
		return false // not subscribable
	}

	const pgInfo = codec.extensions?.pg
	if(!pgInfo) {
		return false // no pg info, cannot subscribe
	}

	return true
}