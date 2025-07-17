# Postgraphile Fancy Mutations Plugin

This plugin adds support for more complex, but performant, mutations in PostGraphile, namely:
- Bulk + relational insert mutations, with ignore duplicates support
- Bulk + relational upsert mutations
- Bulk update mutations, using the same conditions available in your `connection` queries.
- Bulk delete mutations, using the same conditions available in your `connection` queries.

## Install

1. Install the plugin:
```sh
npm i @haathie/postgraphile-fancy-mutations
```
2. Add the plugin to your PostGraphile setup:

```ts
import { FancyMutationsPlugin } from '@haathie/postgraphile-fancy-mutations

const preset: GraphileConfig.Preset = {
	...otherOpts,
	plugins: [
		...otherPlugins,
		FancyMutationsPlugin,
	],
}
```

## Bulk Upsert/Insert Mutations

The plugin automatically creates a bulk `create` mutation for each table that is capable of being inserted into, and has the `bulkCreate` behaviour enabled.

It also scans for any relations it has, and adds inputs to the mutation for those relations, so you can upsert related records in a single transaction.

### Example

This is based on the `contacts` example schema, found in the [packages/contacts-example](../contacts-example/) directory. We have a `Contact` table, which has a many-to-many relation with a `Tag` table, joined by a `ContactTag` table.

A nested upsert mutation for a `Contact` with its corresponding `contactTags` relation, and further the `tag` relation would look like this:

```graphql
mutation UpsertContacts {
  createContacts(input: {
    onConflict: Replace,
    items: [
      {
        name: "John Doe",
        contactTags: [
          {
            tag: {
              name: "VIP"
            }
          }
        ]
      },
      {
        name: "Jane Doe",
        contactTags: [
          {
            tag: {
              name: "V-VIP"
            }
          }
        ]
      }
    ]
  }) {
    affected
    items {
			createdAt
      updatedAt
      type
      orgId
      contactTags {
        nodes {
          tag {
            rowId
            name
            createdBy
            createdAt
          }
          createdAt
          createdBy
        }
      }
      rowId
      name
    }
  }
}
```

This mutation will plan to upsert two `Contact` records, once that is done, it'll upsert the `Tag` records. Finally, it will create the `ContactTag` records that link the `Contact` and `Tag` records together.

### On Conflict Handling

We've 3 options for handling conflicts when inserting/upserting records:
- `Replace`: Classic upsert. This will insert a new record if it doesn't exist, update the existing record with fields specified in the mutation. This means that if the record has a `name`, `phoneNumber`, `img` field and your upsert mutation only specifies the `name` field, the `phoneNumber` and `img` fields will remain unchanged.
- `DoNothing`: This will insert a new record if it doesn't exist, but if it does exist, it will not update the existing record. This is useful when you want to ensure that no changes are made to existing records.
- `Error`: Plain insert (default). This will throw an error if the record already exists. This is useful when you want to ensure that no existing records are modified, and you want to be notified of any conflicts.

## Bulk Update Mutations

The bulk update mutation allows you to update records matched by an arbitrary filter specified by the resource's `connection` `condition` argument. This means you can update multiple records in a single mutation, without having to specify each record individually.

The plugin automatically creates a bulk `update` mutation for each table that is capable of being updated, and has the `bulkUpdate` behaviour enabled (on by default).

For example, to update all contacts with a name containing "Jane" and set their phone number to "123456753".

```graphql
mutation UpdateContacts {
  updateContacts(
    condition: {search: {icontains: "Jane"}}
    patch: {phoneNumber: "1234567531"}
  ) {
    items {
      name
      rowId
      orgId
      createdBy
      createdAt
    }
    affected
  }
}
```

This `condition` was present in the `getContacts` connection query & was simply reused here. This will support any SQL where clause in the filter (joins are not supported yet).

## Bulk Delete Mutations

Similar to the bulk update mutation, the bulk delete mutation allows you to delete records matched by an arbitrary filter specified by the resource's `connection` `condition` argument. This means you can delete multiple records in a single mutation, without having to specify each record individually.

This mutation is automatically created for each table that has the `bulkDelete` behaviour enabled, and the introspection role has access to delete records from that table.

For example, to delete all contacts with a name containing "John":

```graphql
mutation DeleteContacts {
  deleteContacts(condition: {search: {icontains: "John"}}) {
    affected
    items {
      name
      orgId
      rowId
    }
  }
}
```