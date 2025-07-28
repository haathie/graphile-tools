# Postgraphile Fancy Subscriptions

Plugin to enable streaming subscriptions for any table. This plugin creates a trigger to capture changes for any table, using no other dependencies, and subscribe to those changes using GraphQL subscriptions.
The plugin is quite performant and can handle large datasets efficiently. It doesn't rely on logical replication as large txs can significantly slow down the replication stream.

TODO: attach benchmarks