# Reasonable Limits Plugin for PostGraphile

This plugin automatically applies reasonable, configurable limits to the number of records that can be requested in a single query. It is designed to prevent excessive data retrieval that could lead to performance issues.

## Installation

```sh
npm i @haathie/postgraphile-reasonable-limits
```

## Usage

Just add the plugin to your PostGraphile setup:

```js
import { ReasonableLimitsPlugin } from '@haathie/postgraphile-reasonable-limits';

export const preset = {
	plugins: [
		ReasonableLimitsPlugin
	]
}
```

By default, all connections will have a limit of `100` records per query. By default only `10` records will be returned.

To customize the limits, you can add smart tags to the table/function.

```sql
COMMENT ON TABLE your_schema.your_table IS $$
@maxRecordsPerPage 200
@defaultRecordsPerPage 50
$$;
```

## Debugging

To debug whether the limit is correctly applied to a "connection" of yours, you can use the `DEBUG` env var:
```
DEBUG=@haathie/postgraphile-reasonable-limits:log
```