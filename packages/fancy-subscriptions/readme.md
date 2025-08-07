# Postgraphile Fancy Subscriptions

Plugin to enable streaming subscriptions for any table. This plugin creates a trigger to capture changes for any table, using no other dependencies, and subscribe to those changes using GraphQL subscriptions.
The plugin is quite performant and can handle large datasets efficiently. It doesn't rely on logical replication as large txs can significantly slow down the replication stream.

Note: this will modify your database by adding a `fancy_subscriptions` schema, all tables/fns related to the plugin are stored there.

## Usage

Install the plugin:
```bash
npm i @haathie/postgraphile-fancy-subscriptions
```

In your Graphile config, add the plugin & its config:
``` js
import { FancySubscriptionsPlugin } from '@haathie/postgraphile-fancy-subscriptions'

export const config = {
	...otherOpts,
	plugins: [
		...otherPlugins,
		FancySubscriptionsPlugin
	],
	subscriptions: {
		// a unique identifier for the device (machine) that's persistent across restarts
		// Eg. on an EC2 instance ID, a k8s FQDN, etc.
		deviceId: 'my-device-id',
		// optionally change, how often to poll for new events
		pollIntervalMs: 500,
		// how many events to read at once from the events table. You 
		// can increase this to improve throughput, at the cost of more
		// resource usage
		readChunkSize: 1000,
	}
}
```

Tables can be made "subscribable" by adding the behaviour to it:
``` sql
comment on table app.contacts is $$
@behaviour +subscribable
$$;
```

This will add subscriptions for create (insert), update, and delete events on the table. By default, all conditions for the table's connection query will be applicable to the subscription.

``` gql
subscription UpdatedContacts {
  contactsUpdated(
		# conditions available in your connection query will be available here
    condition: {
      orgId: "default-org-id"
    }
  ) {
		# a unique identifier for the subscription event
    eventId
    items {
			# the key contains primary columns of the table,
			# if the NodeID plugin is enabled, this will be the NodeID
      key {
        rowId
      }
			# which columns were changed
      patch {
        rowId
        messagesSent
        platformNames
        name
        phoneNumber
      }
    }
  }
}
```

### Adding Security to Subscriptions

Subscriptions can be secured using an RLS policy. In the example above, we want to ensure that the subscription only returns contacts for a specific organization. We can do this by adding an RLS policy to the `contacts` table:

``` sql
CREATE POLICY app_user_subscriptions ON postgraphile_meta.subscriptions
FOR ALL TO "app_user"
USING (
	-- subscriptions aren't really selected by the role that's creating them,
	-- so this rule is just an added security measure
	additional_data->'inputCondition'->>'orgId'
		= current_setting('app.org_id')
)
WITH CHECK (
	-- the additional_data column stores arbitrary data for the subscription
	-- "inputCondition" is a JSONB object that contains the condition object
	-- that was passed to the subscription

	-- this ensures that a subscription can only be created for the current organization.
	additional_data->'inputCondition'->>'orgId'
		= current_setting('app.org_id')
);
```

Note: the plugin will automatically give the `app_user` role access to create subscriptions, so you don't need to add a separate grant for that.

## Caveats

1. To remove the subscribable behaviour from a table, you must:
	- remove the behaviour from the table
	- run the following SQL to remove the trigger and function:
	``` sql
	SELECT fancy_subscriptions.remove_subscribable('app.contacts');
	```
2. Each "device" or worker that reads events maintains a cursor of the latest event its read from the `events` table. To avoid missing events from ongoing transactions that get committed after the cursor is set, the plugin only reads events that are older than the start of the oldest transaction modifying the `events` table.
A consquence of this is that if a transaction is long-running, the device will not read any new events until the transaction is committed. This can lead to delays in processing events.

## Internal Workings

### Subscriptions

Whenever a "subscriber" wants to subscribe, a row is created in the `subscriptions` table. The subscriber specifies a "topic" -- which is essentially the name of the table and which events it wants to receive (insert, update, delete). It can also specify an arbitrary SQL query that'll be used to filter the events for that subscription, along with "fields" whose changes it wants to receive.

Subscriptions are also attached to a "device", a uniquely identifiable machine that's responsible for fanning out events to the subscriptions. A subscription can be temporary (like a WebSocket connection or SSE) or permanent (like a webhook subscription). Temporary subscriptions are automatically removed if the device is not active for a certain period of time, or when the device starts/stops -- using `remove_temp_subscriptions`. This ensures that stale subscriptions are cleaned up automatically.

### Events

When a change occurs in a subscribable table, a trigger captures the change and inserts the changed rows into the `events` table. This row contains the event type (insert, update, delete), the table name, and the changed data.

The events table is an append-only table (no vaccuuming load), that's partitioned using the `id` column into hourly partitions (ID is a chronological column). Old partitions are automatically dropped after 2 hours, and partitions are created for 12 hours in advance. This is managed by the `maintain_events_table` function, which is run periodically by the plugin.

Note: if the plugin isn't running -- then the `maintain_events_table` function will not be run, and the events table's partitions will not be maintained. This can lead to transactions failing as no new partitions are created. To avoid this, ensure that the plugin is running, or run the `maintain_events_table` in `pg_cron`.

### Fanning Out Events

To put it all together, "events" are sent to relevant subscriptions by
"devices" that periodically read from this table and send changes to clients using the `get_events_for_subscriptions`. This function is the core of the plugin. A high level overview of how it works:
1. The device finds all events whose ID is greater than the latest event ID it has processed from the `active_devices` table, and less than the start of the oldest transaction modifying the `events` table. This ensures that it doesn't miss any events that were committed after it set its cursor. These events are transferred to a temporary table -- `tmp_events`.
2. It then finds all subscriptions that are active for the device, groups by their SQL condition
3. For each subscription SQL condition, it'll execute the condition against the `tmp_events` table to filter the events that match the condition. This is highly efficient as we only execute the condition once per SQL condition -- so even if there are hundreds of thousands of subscriptions, the condition is only executed once per unique condition. Eg. of this grouping is:
	Let's say we've 4 subscriptions with the following conditions:
	```
	1 - "e.row_data->>'orgId' = s.conditions_params[1]", ["org1"]
	2 - "e.row_data->>'orgId' = s.conditions_params[1]", ["org2"]
	3 - "e.row_data->>'id' = s.conditions_params[1]", ["id1"]
	4 - "e.row_data->>'id' = s.conditions_params[1]", ["id2"]
	```
	(just for clarity, `e` is the event, `s` is the subscription)
	In the case above, these 4 subscriptions will be grouped into 2 unique conditions, i.e. `"e.row_data->>'orgId' = s.conditions_params[1]"` and `"e.row_data->>'id' = s.conditions_params[1]"`. Both of these conditions are then evaluated against the `tmp_events` table in parallel.

	This approach is quite similar to Hasura's streaming subscription model, which you can read more about [here](https://github.com/hasura/graphql-engine/blob/master/architecture/streaming-subscriptions.md?ref=highscalability.com).
4. Finally, the filtered events, with their relevant subscription IDs, are sent to the device. The device is expected to then process these events and forward them to relevant clients.

"devices" also mark themselves as "active" by updating their last ping time in the `active_devices` table periodically using the `mark_device_active` fn.
