import { getRelationFieldName } from '@haathie/graphile-common-utils'
import { type PgCodecWithAttributes, PgResource } from 'postgraphile/@dataplan/pg'
import type { PGEntityCtx } from './pg-utils.ts'

type _PgResource = PgResource<string, PgCodecWithAttributes>

type Item = { [_: string]: unknown }

type ItemNode = {
	item: Item
	resource: string
	dependencies: { [relation: string]: ItemNode }
}

type RelInfo = {
	name: string
	reciprocalName: string
	table: _PgResource
	isReferencee: boolean
}

type ExecuteNestedMutationsOpts<T> = {
	items: T[]
	root: _PgResource
	build: GraphileBuild.Build
	mutate(
		items: T[],
		resource: _PgResource,
		ctx: PGEntityCtx<T>
	): Promise<unknown[]>
}

export async function executeNestedMutations<T extends { [k: string]: unknown }>({
	items,
	root,
	build,
	mutate
}: ExecuteNestedMutationsOpts<T>) {
	const { inflection } = build
	let normalised = buildItemRelationGraph(items, root, build)
	if(!normalised.length) {
		return []
	}

	// map of items to be mutated => post mutation
	const resolvedMap = new Map<T, unknown>()

	// we'll go through all items, mutate all that don't have dependencies,
	// remove them from the list, and then repeat until there are no items left
	while(normalised.length) {
		const toMutate: { [resource: string]: T[] } = {}
		let hasMutations = false
		normalised = normalised.filter((node) => {
			if(Object.keys(node.dependencies).length) {
				return true // still has dependencies, keep it
			}

			toMutate[node.resource] ??= []
			toMutate[node.resource].push(node.item as T)
			hasMutations = true
			return false
		})

		if(!hasMutations) {
			throw new Error(
				'INTERNAL: No mutations found, but still have items to process.'
			)
		}

		for(const [resourceName, items] of Object.entries(toMutate)) {
			const resource = root.registry
				.pgResources[resourceName] as _PgResource
			const mutated = await mutate(
				items, resource, getEntityCtx(resource, inflection)
			)
			if(mutated.length !== items.length) {
				throw new Error(
					`Mutated items count mismatch for resource ${resourceName}: `
					+ `expected ${items.length}, got ${mutated.length}`
				)
			}

			for(const [index, item] of items.entries()) {
				const mutatedItem = mutated[index]
				resolvedMap.set(item, mutatedItem)
			}
		}

		for(const node of normalised) {
			for(const [relationName, dependency] of Object.entries(node.dependencies)) {
				const mutatedItem = resolvedMap.get(dependency.item as T)
				if(!mutatedItem) {
					continue // dependency not resolved yet
				}

				const resource = root.registry.pgResources[node.resource] as _PgResource
				const relation = resource
					.getRelation(relationName)
				const fieldName = getRelationFieldName(relationName, resource, build)

				for(const [i, attr] of relation.localAttributes.entries()) {
					const fieldName = inflection.attribute({
						codec: resource.codec,
						attributeName: attr
					})

					// @ts-ignore
					const mutatedField = mutatedItem[relation.remoteAttributes[i]]
					node.item[fieldName] = mutatedField
				}

				delete node.dependencies[relationName]
				delete node.item[fieldName] // remove the relation field
			}
		}
	}

	return {
		rows: items.map(n => resolvedMap.get(n)!),
		rowCount: resolvedMap.size
	}
}

function buildItemRelationGraph(
	items: unknown[],
	root: _PgResource,
	build: GraphileBuild.Build,
	dependencies: ItemNode['dependencies'] = {}
) {
	const normalised: ItemNode[] = []
	const relationNames = Object.entries(root.getRelations())

	const relationNameFieldMap = relationNames.reduce(
		(acc, [name, value]) => {
			const fieldName = getRelationFieldName(name, root, build)
			const reciprocalName = value.remoteResource
				.getReciprocal(root.codec, name)?.[0]
			if(typeof reciprocalName !== 'string') {
				throw new Error(
					`Relation ${name} on ${root.name} does not have a reciprocal relation`
				)
			}

			acc[fieldName] = {
				name,
				reciprocalName,
				table: value.remoteResource as _PgResource,
				isReferencee: value.isReferencee,
			}
			return acc
		},
		{} as Record<string, RelInfo>
	)
	for(const item of items) {
		if(typeof item !== 'object' || !item) {
			continue
		}

		const node: ItemNode = {
			item: item as Item,
			resource: root.name,
			dependencies: { ...dependencies }
		}

		normalised.push(node)

		if(!relationNames.length) {
			continue
		}

		for(const [key, value] of Object.entries(item)) {
			const relInfo = relationNameFieldMap[key]
			if(!relInfo || !value || typeof value !== 'object') {
				continue
			}

			if(!relInfo.isReferencee) {
				if(Array.isArray(value)) {
					throw new Error(
						'Expecting a single item for inverse-relations'
					)
				}

				const deps = buildItemRelationGraph([value], relInfo.table, build)
				node.dependencies[relInfo.name] = deps[0]
				normalised.push(...deps)
				continue
			}

			const items = buildItemRelationGraph(
				Array.isArray(value) ? value : [value],
				relInfo.table,
				build,
				{ [relInfo.reciprocalName]: node }
			)
			normalised.push(...items)

			// @ts-expect-error
			delete item[key]
		}
	}

	return normalised
}

function getEntityCtx<T>(
	table: _PgResource,
	inflection: GraphileBuild.Build['inflection'],
): PGEntityCtx<T> {
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
		return {
			columns: u.attributes.map(a => (
				inflection.attribute({ codec, attributeName: a }) as keyof T
			))
		}
	})
	for(const attributeName in codec.attributes) {
		const propname = inflection
			.attribute({ codec: table.codec, attributeName })
		propToColumnMap[propname] = attributeName
		if(primaryKey.attributes.includes(attributeName)) {
			primaryKeyNames.push(propname)
		}
	}

	return {
		tableName: fqTableName,
		idProperties: primaryKeyNames as Array<keyof T>,
		uniques: otherUniqueNames,
		propertyColumnMap: propToColumnMap as Record<keyof T, string>,
	}
}