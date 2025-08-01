DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA IF NOT EXISTS app;

-- search index for contacts_search
CREATE EXTENSION IF NOT EXISTS pg_search;

DO $$
BEGIN
	-- create app_user role if it doesn't exist
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
		CREATE ROLE "app_user" LOGIN PASSWORD 'app_user';
		-- Ensure app_user cannot run long running queries
		ALTER ROLE "app_user" SET statement_timeout = '30s';
	END IF;
END
$$;

DO $$
BEGIN
	EXECUTE format(
		'GRANT CONNECT, TEMPORARY ON DATABASE %I TO "app_user";',
		current_database()
	);
END
$$;

GRANT USAGE, CREATE ON SCHEMA app TO "app_user";

-- Create custom types first
CREATE TYPE app.contact_type AS ENUM ('individual', 'group', 'channel', 'post');

CREATE TYPE app.contact_img_info AS (
	url VARCHAR(255),
	fetched_at TIMESTAMPTZ
);

-- Create a sequential ID
-- Eg. cnt_12910232939291212345
CREATE OR REPLACE FUNCTION app.create_object_id(
	prefix VARCHAR(3),
	dt TIMESTAMPTZ DEFAULT clock_timestamp(),
	suffix INTEGER DEFAULT (random() * 16777215)::INTEGER
) RETURNS VARCHAR(24) AS $$
BEGIN
	RETURN substr(
		prefix
			|| '_'
			|| lpad(to_hex((extract(epoch from dt) * 1000000)::bigint), 15, '0')
			|| lpad(to_hex(suffix::INTEGER), 5, '0'),
		1,
		24
	);
END
$$ LANGUAGE plpgsql VOLATILE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app.current_actor_id()
RETURNS VARCHAR(64) AS $$
BEGIN
	RETURN COALESCE(current_setting('app.user_id', true), 'system');
END
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

-- Create the Contact table
CREATE TABLE app.contacts (
	id VARCHAR(24) PRIMARY KEY DEFAULT app.create_object_id('cnt'),
	org_id VARCHAR(64) NOT NULL DEFAULT current_setting('app.org_id'),
	type app.contact_type NOT NULL DEFAULT 'individual',
	name VARCHAR(255),
	platform_names VARCHAR(255)[] DEFAULT '{}',
	created_at TIMESTAMPTZ DEFAULT NOW(),
	created_by VARCHAR(64) DEFAULT app.current_actor_id(),
	updated_at TIMESTAMPTZ DEFAULT NOW(),
	phone_number BIGINT,
	email VARCHAR(128),
	full_img app.contact_img_info,
	assignee VARCHAR(64),
	assigned_by VARCHAR(64),
	assigned_at TIMESTAMPTZ,
	first_assigned_at TIMESTAMPTZ,
	messages_sent INTEGER NOT NULL DEFAULT 0,
	messages_received INTEGER NOT NULL DEFAULT 0,
	-- denormalized fields
	-- these fields are used for search and should be updated via triggers
	-- or be generated fields
	search TEXT[] GENERATED ALWAYS AS (
		array_cat(
			ARRAY[
				COALESCE(name, ''),
				COALESCE(phone_number::TEXT, ''),
				COALESCE(email, '')
			],
			platform_names
		)
	) STORED,
	tags JSONB DEFAULT '{}',
	UNIQUE (org_id, phone_number),
	UNIQUE (org_id, email)
);

comment on table app.contacts is $$
@behaviour +subscribable
@rateLimits connection:unauthenticated:5/60s connection:authenticated:100/60s
$$;

comment on column app.contacts.created_at is $$
@behaviour filterType:range filterMethod:paradedb
@rateLimits field:authenticated:100/60s
$$;

comment on column app.contacts.id is $$
@behaviour filterType:range filterType:eq filterType:eqIn
$$;

comment on column app.contacts.search is $$
@behaviour -select filterType:icontains filterMethod:paradedb
$$;

comment on column app.contacts.tags is $$
@behaviour -select
$$;

-- Trigger to set updated_at
CREATE FUNCTION app.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$ language 'plpgsql';
CREATE TRIGGER set_updated_at_trigger
	BEFORE UPDATE ON app.contacts
	FOR EACH ROW
	EXECUTE FUNCTION app.set_updated_at();

-- Trigger function to handle assignment tracking
CREATE OR REPLACE FUNCTION app.handle_contact_assignment()
RETURNS TRIGGER AS $$
BEGIN
	-- On INSERT: if assignee is being set, set assignment metadata
	IF TG_OP = 'INSERT' AND NEW.assignee IS NOT NULL THEN
		NEW.assigned_at := clock_timestamp();
		NEW.assigned_by := app.current_actor_id();
		NEW.first_assigned_at := clock_timestamp();
	-- On UPDATE: if assignee is being changed
	ELSIF TG_OP = 'UPDATE'
		AND NEW.assignee IS NOT NULL
		AND NEW.assignee IS DISTINCT FROM OLD.assignee
	THEN
		NEW.assigned_at := clock_timestamp();
		NEW.assigned_by := app.current_actor_id();
		-- Set first_assigned_at only if it's currently NULL
		IF OLD.first_assigned_at IS NULL THEN
			NEW.first_assigned_at := clock_timestamp();
		END IF;
	END IF;
	
	RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER handle_contact_assignment_trigger
	BEFORE INSERT OR UPDATE ON app.contacts
	FOR EACH ROW
	EXECUTE FUNCTION app.handle_contact_assignment();

-- Permissions --------------

-- Enable Row Level Security on all tables
ALTER TABLE app.contacts ENABLE ROW LEVEL SECURITY;
GRANT
  SELECT,
	INSERT(name, platform_names, phone_number, email, assignee),
	UPDATE(name, platform_names, phone_number, email, assignee),
	DELETE
ON app.contacts TO "app_user";
-- Create RLS policies for contacts table
CREATE POLICY contacts_team_isolation ON app.contacts
FOR ALL TO "app_user"
USING (
	contacts.org_id = current_setting('app.org_id')
	-- contacts.org_id @@@ paradedb.boolean(
	-- 	must := ARRAY[paradedb.term('org_id', current_setting('app.org_id'))] || (
	-- 		CASE WHEN current_setting('app.has_full_contacts_access') = 'true'
	-- 		THEN ARRAY[]::paradedb.searchqueryinput[]
	-- 		ELSE ARRAY[paradedb.term('assignee', app.current_actor_id())]
	-- 		END
	-- 	)
	-- )
)
WITH CHECK (
	org_id = current_setting('app.org_id')
	AND (
		current_setting('app.has_full_contacts_access') = 'true'
		OR assignee = app.current_actor_id()
	)
);

-- Create a search index on the contacts table

CREATE INDEX IF NOT EXISTS
	contacts_search_idx ON app.contacts
	USING bm25(id, org_id, search, created_at, assignee, tags)
	WITH (
		key_field='id',
		text_fields='{
			"org_id": {
				"fast":true,
				"tokenizer": {"type": "keyword"},
				"record": "basic"
			},
			"assignee": {
				"fast":true,
				"tokenizer": {"type": "keyword"},
				"record": "basic"
			},
			"search": {
				"fast":true,
				"tokenizer": {
					"type": "ngram",
					"min_gram": 2,
					"max_gram": 3,
					"prefix_only": false
				},
				"record": "position"
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

-- Create the Tags table

CREATE TABLE app.tags (
	id VARCHAR(24) PRIMARY KEY DEFAULT app.create_object_id('tag'),
	org_id VARCHAR(64) DEFAULT current_setting('app.org_id'),
	name VARCHAR(64) NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	created_by VARCHAR(64) DEFAULT app.current_actor_id(),
	UNIQUE (org_id, name)
);

-- Enable Row Level Security on all tables
ALTER TABLE app.tags ENABLE ROW LEVEL SECURITY;
GRANT
  SELECT,
	INSERT(name),
	UPDATE(name),
	DELETE
ON app.tags TO "app_user";
-- Create RLS policies for contacts table
CREATE POLICY tags_team_isolation ON app.tags
FOR ALL TO "app_user"
USING (
	org_id = current_setting('app.org_id')
)
WITH CHECK (
	org_id = current_setting('app.org_id')
);

CREATE TABLE app.contact_tags (
	contact_id VARCHAR(24) NOT NULL
		REFERENCES app.contacts(id) ON DELETE CASCADE,
	tag_id VARCHAR(24) NOT NULL
		REFERENCES app.tags(id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	created_by VARCHAR(64) NOT NULL DEFAULT app.current_actor_id(),
	PRIMARY KEY (contact_id, tag_id)
);

comment on constraint contact_tags_contact_id_fkey on app.contact_tags is $$
@behaviour +single
$$;
comment on constraint contact_tags_tag_id_fkey on app.contact_tags is $$
@behaviour +single
$$;

ALTER TABLE app.contact_tags ENABLE ROW LEVEL SECURITY;
GRANT
	SELECT,
	INSERT(contact_id, tag_id),
	DELETE
ON app.contact_tags TO "app_user";
-- Create RLS policies for contact_tags table
CREATE POLICY contact_tags_team_isolation ON app.contact_tags
FOR ALL TO "app_user"
USING (TRUE)
WITH CHECK (TRUE);
-- USING (
-- 	contact_id IN (
-- 		SELECT id FROM app.contacts
-- 		WHERE org_id = current_setting('app.org_id')
-- 	)
-- )
-- WITH CHECK (
-- 	contact_id IN (
-- 		SELECT id FROM app.contacts
-- 		WHERE org_id = current_setting('app.org_id')
-- 	)
-- );

-- add triggers for updating denormalized fields & create search index

CREATE OR REPLACE FUNCTION app.update_contact_tags()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		WITH updated_contacts AS (
			SELECT
				contact_id,
				jsonb_object_agg(
					tag_id,
					jsonb_build_object('created_at', created_at, 'created_by', created_by)
				) as new_tags
			FROM new_table
			GROUP BY contact_id
		)
		UPDATE app.contacts c
		SET tags = tags || new_tags
		FROM updated_contacts ut
		WHERE c.id = ut.contact_id;
	ELSIF TG_OP = 'DELETE' THEN
		WITH updated_contacts AS (
			SELECT
				contact_id,
				ARRAY_AGG(tag_id) AS tags_to_remove
			FROM old_table
			GROUP BY contact_id
		)
		UPDATE app.contacts c
		SET tags = tags - tags_to_remove
		FROM updated_contacts ut
		WHERE c.id = ut.contact_id;
	END IF;

	RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER new_contact_tags_trigger
	AFTER INSERT ON app.contact_tags
	REFERENCING NEW TABLE AS new_table
	FOR EACH STATEMENT
	EXECUTE FUNCTION app.update_contact_tags();

CREATE TRIGGER del_contact_tags_trigger
	AFTER DELETE ON app.contact_tags
	REFERENCING OLD TABLE AS old_table
	FOR EACH STATEMENT
	EXECUTE FUNCTION app.update_contact_tags();