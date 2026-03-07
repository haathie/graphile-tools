# Replace Types

This plugin allows you to replace fields in the GraphQL schema with custom types.
This is useful for cases where you want to change the behavior of a field without changing the underlying database schema.

## Usage

To use this plugin, you need to install it and then add it to your PostGraphile configuration.

```
npm i @haathie/postgraphile-replace-types
```

Add to your preset's plugins:
```ts
import { ReplaceTypesPlugin } from '@haathie/postgraphile-replace-types';
const preset = {
	...otherStuff,
	plugins: [
		...otherPlugins,
		extendSchema(() => {
			return {
				typeDefs: `
					enum NewTypeName {
						VALUE1
					}
				`,
				enums: {
					NewTypeName: {
						values: {
							VALUE1: 'VALUE1',
						}
					},
				}
			}
		})
		ReplaceTypesPlugin,
	],
}
```

## Replacing a Field

Add a smart comment tag to the column in the database:
```sql
COMMENT ON COLUMN table_name.field_name IS '@replaceType NewTypeName';
```

For input types, it will first try `NewTypeNameInput`, then fall back to `NewTypeName`.
