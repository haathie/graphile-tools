import type { PgCodec, PgCodecWithAttributes } from 'postgraphile/@dataplan/pg'
import type { GraphQLInputType } from 'postgraphile/graphql'
import { FILTER_METHODS_CONFIG, FILTER_TYPES_MAP } from './filter-implementations/index.ts'
import type { FilterMethod, FilterType } from './types.ts'

export function getBuildGraphQlTypeByCodec(
	codec: PgCodec,
	build: GraphileBuild.Build
) {
	codec = codec.arrayOfCodec || codec
	return () => {
		const type = build.getGraphQLTypeByPgCodec(codec, 'input')
		if(!type) {
			throw new Error(`No input type found for codec ${codec.name}`)
		}

		return type as GraphQLInputType
	}
}

export function *getFilterTypesForAttribute(
	pgCodec: PgCodecWithAttributes,
	attrName: string,
	{ behavior }: GraphileBuild.Build
) {
	for(const _filterType in FILTER_TYPES_MAP) {
		const filterType = _filterType as FilterType
		if(
			!behavior
				.pgCodecAttributeMatches([pgCodec, attrName], `filterType:${filterType}`)
		) {
			continue
		}

		yield filterType
	}
}


export function *getFilterMethodsForAttribute(
	pgCodec: PgCodecWithAttributes,
	attrName: string,
	{ behavior }: GraphileBuild.Build
) {
	for(const _method in FILTER_METHODS_CONFIG) {
		const method = _method as FilterMethod
		if(
			!behavior
				.pgCodecAttributeMatches([pgCodec, attrName], `filterMethod:${method}`)
		) {
			continue
		}

		yield method
	}
}