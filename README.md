# Postgraphile Tooling

Postgraphile & Postgres Tooling Speed Up Going to Production. The repository contains the following packages:

- [Fancy Mutations](/packages/fancy-mutations/): Postgraphile plugin for bulk upserts with nested relations, bulk updates, and deletes. Example:
	```graphql
	mutation UpsertContacts {
		createContacts(input: {
			# onConflict: Replace => replaces conflicting rows. Other options include:
			# "DoNothing" => ignores conflicting rows
			# "Error" => throws an error on conflict
			onConflict: Replace,
			items: [
				{
					name: "John Doe",
					# contactTags => specify inserting into the 'contact_tags' table
					# (nested relation)
					contactTags: [
						{
							# tag => specify inserting into the 'tags' table
							# (nested relation)
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
			# returns the number of affected rows
			affected
			# the created/updated nodes
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

- [Fancy Conditions](/packages/fancy-conditions/): Postgraphile plugin for advanced filtering, including relational conditions, ParadeDB support, and more. Example:
	``` graphql
	query GetContacts {
		allContacts(condition: {
			# filter contacts whose name contains "john" (case-insensitive)
			name: { icontains: "john" }
			# search the "contactTags" relation for tags with the id "abcd"
			contactTags: { id: { eq: "abcd" } }
		}) {
			nodes {
				id
				name
			}
		}
	}
	```

- [Realtime](/packages/realtime/): Postgraphile plugin for performant subscriptions, allowing real-time updates from your Postgres database. Example:
	``` graphql
	subscription UpdatedContacts {
		contactsUpdated(
			# conditions available in the connection query (i.e. "allContacts" in this case)
			# will be available here
			condition: {
				orgId: "default-org-id"
			}
		) {
			# a unique identifier for the subscription event
			eventId
			# events are automatically batched and sent in a single message
			items {
				# the key contains primary columns of the table,
				# if the NodeID plugin is enabled, this will be the NodeID
				key {
					rowId
				}
				# changed columns. When using the "update" subscription,
				# this will only contain messages that had the subscribed columns changed.
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
- [Rate Limits](/packages/rate-limits/): Postgraphile plugin for rate limiting queries and mutations. Easily add rate limits using smart tags and get reasonably friendly error messages:
	``` sql
	COMMENT ON TABLE app.contacts is $$
	@rateLimits connection:authenticated:10/60s connection:unauthenticated:2/60s
	$$;
	```
	``` json
	{
		"data": {
			"contacts": null
		},
		"errors": [
			{
				"message": "You (default-org-id) have exceeded the \"authenticated\" rate limit for \"Query.contacts\". 5/5 points consumed over 60s",
				"locations": [
					{
						"line": 2,
						"column": 3
					}
				],
				"path": [
					"contacts"
				],
				"extensions": {}
			}
		]
	}
	```
- [Reasonable Limits](/packages/reasonable-limits/): Postgraphile plugin to enforce reasonable limits on queries, preventing excessive data retrieval.

## Running the Example

The repository comes with a fully fledged example demonstrating the use of these plugins, located in the [contacts-example](/packages/contacts-example) directory. This is an example of a contacts management system, showcasing how to use the plugins in a real-world scenario.

1. Install deps: `npm i`
2. Bootstrap the dev environment:
	```sh
	sh scripts/bootstrap-dev.sh
	```
	Ensure you have `Docker`, `psql` installed. This will start a Postgres container, tools for managing subscriptions, and the example `contacts` database.
3. Start the contacts example server:
	```sh
	npm run start:contacts-example
	```