# Postgraphile Targeted Conditions

Opt-in & configurable conditions plugin for Postgraphile. This plugin is designed to allow you to quickly enable conditions on fields for your Postgraphile queries without having to write custom SQL or GraphQL plans. It also supports adding conditions on fields in related tables.

Please read through [the Caveats section](#caveats) before using this plugin.

## Setup

Install:
``` bash
npm i @haathie/postgraphile-targeted-conditions
```

Add the plugin to your Postgraphile configuration:
``` ts
import { TargetedConditionsPlugin } from '@haathie/postgraphile-targeted-conditions'

export const config: GraphileBuild.Preset = {
	...otherOptions,
	plugins: [
		...otherPlugins,
		TargetedConditionsPlugin,
	],
}
```

## Usage

By default, the plugin will not add any conditions to any connection queries. You can enable conditions for a specific field by adding a "filterType" behaviour to the field in your schema.

``` sql
-- will add a case-insensitive "icontains" filter, and an "eq" filter 
-- to the "name" column of the "contacts" table
comment on column app.contacts.name is $$
@behaviour filterType:icontains filterType:eq
$$;
```

This will allow you to filter the "contacts" table by the "name" column using the following GraphQL query:

``` graphql
query GetContacts {
	allContacts(condition: { name: { icontains: "john" } }) {
		nodes {
			id
			name
		}
	}
}
```

The plugin will always create a `oneOf` Input Object type for the filter type of each field. Eg.
``` graphql
input ContactNameCondition @oneOf {
	icontains: String
	eq: String
}
```

This allows for adding/removing filter types without breaking existing queries. For example, if you add a new filter type for "equals in" to the "name" column, and the above query will still work without any changes.

## Relational Conditions

Let's say we have a `contacts` table and a `tags` table, with each contact having multiple tags. We can add a filter to the `contacts` table to filter by tags. We'll create a ref and add `filterable` behaviour to it.
This will give the contacts relation the ability to filter by all filterable fields in the `tags` table.

``` sql
-- will add a "tags" filter to the "contacts" table
-- for more info on refs, see: https://postgraphile.org/postgraphile/5/refs/#ref-and-refvia
comment on table "conditions_test"."authors" is $$
@ref tags via:(id)->tags(contact_id) behavior:filterable
$$;

-- we'll also add an "eq" filter to the "name" column of the "tags" table
comment on column app.tags.name is $$
@behaviour filterType:eq
$$;
```

This now enables us to query `contacts` by `tags` in the following way:
``` graphql
query GetContacts {
	allContacts(condition: { tags: { name: { eq: "important" } } }) {
		nodes {
			id
			name
			# also return the tags for each contact
			# (not related to the conditions plugin, but useful)
			tags {
				nodes {
					id
					name
				}
			}
		}
	}
}
```

## Available Filter Types

- `eq`: Exact match, with null handling
- `eqIn`: Check if the value is in a list of values, with null handling
- `icontains`: Case-insensitive contains
- `range`: Check if a value is within an inclusive range

## Filter Methods

Postgres has a bunch of popular extensions that implement a different syntax for filtering -- eg. GIN indices, ZomboDB, ParadeDB, etc. This plugin is extensible to support these extensions.

Presently, the plugin supports the following filter methods:
- [paradedb](https://github.com/paradedb/paradedb): ParadeDB is a PostgreSQL extension that allows you to have ES-level query capabilities in your Postgres database. This plugin supports using ParadeDB's query syntax to filter your queries.

## Adding a Custom Filter Type

Let's implement a `startsWith` filter type that allows filtering strings that start with a given value.

``` ts
import { registerFilterImplementations } from '@haathie/postgraphile-targeted-conditions'

// extend the "FilterTypeMap" interface to add the new filter type
declare global {
  namespace GraphileBuild {
    interface FilterTypeMap {
      startsWith: true
    }
  }
}

// write the filter implementation
registerFilterImplementations({
  'startsWith': {
    // the getType method is used to get the GraphQL type for the filter
    // in this case, it'll just be the same type as the field being filtered.
    // Also since startsWith only makes sense for string fields -- we can throw
    // an error if the field is not a string.
    getType(codec, getGraphQlType, { graphql: { GraphQLNonNull, GraphQLString } }) {
      const type = getGraphQlType()
      if(type !== GraphQLString) {
        throw new Error(`The "startsWith" filter type can only be used on string fields, but the field "${codec.name}" is of type "${type.name}".`)
      }

      return new GraphQLNonNull(type)
    },
    // in the applys method, we define how the filter gets converted to SQL
    // using a specified method. By default, "plainSql" is used, but you can
    // implement other methods like "paradedb" or "zombodb" to use their
    // query syntax.
    applys: {
      plainSql: (cond, input, { scope: { attrName, attr } }) => {
        const id = sql`${cond.alias}.${sql.identifier(attrName)}`
        // handle postgres array types
        if(attr.codec.arrayOfCodec) {
          return cond.where(
            sql`EXISTS (
              SELECT 1 FROM unnest(${id}) AS elem 
              WHERE elem LIKE ${sql.value(`${input}%`)}
            )`
          )
        }

        return cond.where(sql`${id} LIKE ${sql.value(`${input}%`)}`)
      },
    }
  },
})
```

See how other filter types are implemented [here](src/filter-implementations/declaration.ts#L51).

## Adding a Custom Filter Method

To add a custom filter method, you can use the `registerFilterMethod` function. This allows you to define how the filter type should be applied in SQL.

``` ts
import { registerFilterMethod } from '@haathie/postgraphile-targeted-conditions'

// extend the "FilterMethodMap" interface to add the new filter method
declare global {
  namespace GraphileBuild {
    interface FilterMethodMap {
      zombodb: true
    }
  }
}

registerFilterMethod(
  'zombodb',
  // can this be used in subscriptions? This flag is present as some filter
  // methods may not be well suited or even supported in realtime scenarios.
  { supportedOnSubscription: false },
  {
    eq: (cond, input, { scope: { attrName, attr } }) => {
      // implement
    },
    eqIn: (cond, input, { scope: { attrName, attr } }) => {
      // implement
    },
    // ... other filter types
  }
)
```

See how [paradedb method](src/filter-implementations/paradedb.ts) is implemented for a more detailed example.

## Caveats

- Adding relational conditions can lead to performance issues, especially if the related table has a large number of rows. Use with caution and please ensure you have the necessary indices in place.
- Apart from relations, adding arbitrary conditions on fields for vibes only is not a good idea. It can cause unexpected performance issues, and it is recommended to only add conditions that are necessary for your application. The plugin is meant for you to quickly add targeted conditions to your queries, and only the ones you want -- so we spend more time writing mission-critical code rather than boilerplate SQL or GraphQL plans.
- This plugin does not work with Postgres compound types at the moment. Only the `eq` and `eqIn` filter types are supported for compound types.