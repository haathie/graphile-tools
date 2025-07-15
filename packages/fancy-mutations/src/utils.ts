import * as debug from 'debug'
import type { PgCodecAttribute, PgResource } from 'postgraphile/@dataplan/pg'
import type { PGEntityCtx } from './pg-utils.ts'
import type { PgTableResource } from './types.ts'

export const DEBUG = debug.default('@haathie/postgraphile-fancy-mutations:log')

export function getEntityCtx<T>(table: PgTableResource): PGEntityCtx<T> {
	const { identifier, executor, codec } = table
	// table ID is the executor name + '.' + table name
	// so we remove the executor name from the identifier
	// to get the fully qualified table name
	// e.g. 'main.public.users' -> 'public.users'
	const fqTableName = identifier.slice(executor.name.length + 1)

	const propToColumnMap: Record<string, string> = {}
	const primaryKeyNames: string[] = []
	const primaryKey = table.uniques.find(u => u.isPrimary)
	if(!primaryKey) {
		throw new Error(`Table ${fqTableName} does not have a primary key`)
	}

	const otherUniqueNames = table.uniques.map(u => {
		return { columns: [...u.attributes] as Array<keyof T> }
	})
	for(const attributeName in codec.attributes) {
		propToColumnMap[attributeName] = attributeName
		if(primaryKey.attributes.includes(attributeName)) {
			primaryKeyNames.push(attributeName)
		}
	}

	return {
		tableName: fqTableName,
		idProperties: primaryKeyNames as Array<keyof T>,
		uniques: otherUniqueNames,
		propertyColumnMap: propToColumnMap as Record<keyof T, string>,
	}
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationUpdateDeletePlugin.ts#L154
export const isUpdatable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	if(!resource.uniques || resource.uniques.length < 1) {
		return false
	}

	return !!build.behavior.pgResourceMatches(resource, 'resource:update')
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationUpdateDeletePlugin.ts#L154
export const isDeletable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	if(!resource.uniques || resource.uniques.length < 1) {
		return false
	}

	return !!build.behavior.pgResourceMatches(resource, 'resource:delete')
}

// from: https://github.com/graphile/crystal/blob/da7b7196c627e1151564f185f199a716206da903/graphile-build/graphile-build-pg/src/plugins/PgMutationCreatePlugin.ts#L53C1-L62C3
export const isInsertable = (
	build: GraphileBuild.Build,
	resource: PgResource<any, any, any, any, any>,
) => {
	if(resource.parameters) {
		return false
	}

	if(!resource.codec.attributes) {
		return false
	}

	if(resource.codec.polymorphism) {
		return false
	}

	if(resource.codec.isAnonymous) {
		return false
	}

	return build.behavior.pgResourceMatches(resource, 'resource:insert') === true
}

export const isInsertableAttribute = (
	build: GraphileBuild.Build,
	resource: PgCodecAttribute<any, any>,
) => {
	return resource.extensions?.canInsert || resource.extensions?.isInsertable
}