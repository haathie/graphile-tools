DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA IF NOT EXISTS app;
-- CREATE ROLE IF "app_user" WITH NOLOGIN;
GRANT USAGE ON SCHEMA app TO "app_user";

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

-- Create the Contact table
CREATE TABLE app.contacts (
	id VARCHAR(24) PRIMARY KEY DEFAULT app.create_object_id('cnt'),
	org_id VARCHAR(64) NOT NULL DEFAULT current_setting('app.org_id'),
	type app.contact_type NOT NULL,
	name VARCHAR(255),
	platform_names VARCHAR(255)[] DEFAULT '{}',
	created_at TIMESTAMPTZ DEFAULT NOW(),
	created_by VARCHAR(64) DEFAULT current_setting('app.user_id'),
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
DECLARE
	new_assigned_by VARCHAR;
BEGIN
	new_assigned_by := COALESCE(
		current_setting('app.user_id', true), 'system'
	);
	-- On INSERT: if assignee is being set, set assignment metadata
	IF TG_OP = 'INSERT' AND NEW.assignee IS NOT NULL THEN
		NEW.assigned_at := clock_timestamp();
		NEW.assigned_by := new_assigned_by;
		NEW.first_assigned_at := clock_timestamp();
	-- On UPDATE: if assignee is being changed
	ELSIF TG_OP = 'UPDATE' AND NEW.assignee IS NOT NULL AND NEW.assignee <> OLD.assignee THEN
		NEW.assigned_at := clock_timestamp();
		NEW.assigned_by := new_assigned_by;
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
	INSERT(type, name, platform_names, phone_number, email, assignee),
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

-- CREATE TABLE app.tags (
-- 	id VARCHAR(24) PRIMARY KEY DEFAULT app.create_object_id('tag'),
-- 	org_id VARCHAR(64) NOT NULL,
-- 	name VARCHAR(64) NOT NULL,
-- 	created_at TIMESTAMPTZ DEFAULT NOW(),
-- 	created_by VARCHAR(64) NOT NULL
-- );

-- CREATE TABLE app.contact_tags (
-- 	contact_id VARCHAR(24) NOT NULL
-- 		REFERENCES app.contacts(id) ON DELETE CASCADE,
-- 	tag_id VARCHAR(24) NOT NULL
-- 		REFERENCES app.tags(id) ON DELETE CASCADE,
-- 	created_at TIMESTAMPTZ DEFAULT NOW(),
-- 	created_by VARCHAR(64) NOT NULL,
-- 	PRIMARY KEY (contact_id, tag_id)
-- );