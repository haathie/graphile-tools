DROP MATERIALIZED VIEW IF EXISTS app.contacts_search CASCADE;

CREATE MATERIALIZED VIEW app.contacts_search AS (
	SELECT
		c.id,
		ARRAY_PREPEND(c.name, c.platform_names) AS names,
		c.org_id,
		c.created_at,
		COALESCE(
			JSON_OBJECT_AGG(
				ct.tag_id::text,
				JSON_BUILD_OBJECT('created_at', ct.created_at)
			) FILTER (WHERE ct.tag_id IS NOT NULL),
			'{}'::json
    ) AS tags
	FROM app.contacts c
	LEFT JOIN app.contact_tags ct ON c.id = ct.contact_id
	GROUP BY c.id
);

-- search index for contacts_search
CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE INDEX IF NOT EXISTS
	contacts_search_idx ON app.contacts_search
	USING bm25(id, org_id, names, created_at, tags)
	WITH (
		key_field='id',
		text_fields='{
			"org_id": {
				"fast":true,
				"tokenizer": {"type": "keyword"},
				"record": "basic"
			},
			"names": {
				"fast":true,
				"tokenizer": {"type": "whitespace"},
				"record": "basic"
			}
		}',
		json_fields='{
			"tags": {
				"fast":true,
				"tokenizer": {"type": "keyword"},
				"record": "basic"
			}
		}',
		datetime_fields='{
			"created_at": {}
		}'
	);

-- Create a view for the contacts search (as we can limit access there)

CREATE VIEW app.contacts_search_view AS
	SELECT * FROM app.contacts_search
	WHERE org_id @@@ paradedb.term('org_id', current_setting('app.org_id'))
;

comment on view app.contacts_search_view is $$
@unique id
$$;

comment on COLUMN app.contacts_search_view.id is $$
@behaviour filterType:eq filterType:range filterType:eqIn filterMethod:paradedb
$$;

GRANT SELECT ON app.contacts_search_view TO "app_user";