DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA IF NOT EXISTS app;
-- CREATE ROLE IF "app_user" WITH NOLOGIN;
GRANT USAGE, CREATE ON SCHEMA app TO "app_user";
GRANT CONNECT, TEMPORARY ON DATABASE "im-contacts" TO "app_user";

-- Create custom types first
CREATE TYPE app.contact_type AS ENUM ('individual', 'group', 'channel', 'post');

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
	img JSONB,
	assignee VARCHAR(64),
	assigned_by VARCHAR(64),
	assigned_at TIMESTAMPTZ,
	first_assigned_at TIMESTAMPTZ,
	messages_sent INTEGER NOT NULL DEFAULT 0,
	messages_received INTEGER NOT NULL DEFAULT 0,
	UNIQUE (org_id, phone_number),
	UNIQUE (org_id, email)
);
ALTER TABLE app.contacts REPLICA IDENTITY FULL;

comment on table app.contacts is $$
@foreignKey (id) references app.contacts_search (id)
@ref search via:(id)->app.contacts_search(id) singular behavior:searchable
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
	org_id = current_setting('app.org_id')
)
WITH CHECK (
	org_id = current_setting('app.org_id')
);

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
@foreignConnectionFieldName tags
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
USING (
	contact_id IN (
		SELECT id FROM app.contacts
		WHERE org_id = current_setting('app.org_id')
	)
)
WITH CHECK (
	contact_id IN (
		SELECT id FROM app.contacts
		WHERE org_id = current_setting('app.org_id')
	)
);

-- add MV for search -----------

CREATE MATERIALIZED VIEW app.contacts_search AS (
	SELECT
		c.id,
		ARRAY_PREPEND(c.name, c.platform_names) AS names,
		c.org_id,
		c.created_at,
		ARRAY_AGG(
			jsonb_object(
				ARRAY['id', 'name', 'added_at']::varchar[],
				ARRAY[ct.tag_id, t.name, ct.created_at]::varchar[]
			)
		) AS tags
	FROM app.contacts c
	LEFT JOIN app.contact_tags ct ON c.id = ct.contact_id
	LEFT JOIN app.tags t ON t.id = ct.tag_id
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
				"tokenizer": {"type": "default"},
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
