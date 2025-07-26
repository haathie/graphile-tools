DROP SCHEMA IF EXISTS postgraphile_meta CASCADE; -- TODO: remove this in production
CREATE SCHEMA IF NOT EXISTS "postgraphile_meta";

-- Check "pgmb" schema exists, otherwise raise exception
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmb') THEN
		RAISE EXCEPTION 'pgmb extension is not installed. Please install it first.';
	END IF;
END
$$;

-- Create the queue for permanent subscriptions
SELECT pgmb.assert_queue(
	'postg_permanent_subs',
	default_headers := '{"contentType":"application/json"}'::jsonb,
	queue_type := 'logged'::pgmb.queue_type
);

-- Unique ID of the device that's connected to the database.
-- Could be hostname, or just the pid
CREATE OR REPLACE FUNCTION postgraphile_meta.get_session_device_id()
RETURNS VARCHAR AS $$
	SELECT current_setting('app.device_id');
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER;

-- Function to get the topic from a wal2json single change JSON
CREATE OR REPLACE FUNCTION postgraphile_meta.create_topic(
	schema_name varchar(64),
	table_name varchar(64),
	kind varchar(16)
) RETURNS varchar(255) AS $$
BEGIN
	RETURN schema_name || '.' || table_name || '.' || kind;
END
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE TABLE IF NOT EXISTS postgraphile_meta.active_devices(
	name VARCHAR(64) PRIMARY KEY,
	last_activity_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS postgraphile_meta.subscriptions (
	-- unique identifier for the subscription
	id VARCHAR(48) PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	worker_device_id VARCHAR(64) NOT NULL DEFAULT postgraphile_meta.get_session_device_id(), 
	cursor VARCHAR(64),
	topic VARCHAR(255) NOT NULL,
	-- if conditions_sql is NULL, then the subscription will receive
	-- all changes for the topic. Otherwise, it will receive only changes
	-- where the change document matches the conditions_sql. The
	-- first parameter of the conditions_sql will be the change document
	-- as a JSONB object.
	-- Eg. conditions_sql = 'SELECT 1 WHERE $1->>''user_id'' = $2',
	-- conditions_params = ARRAY['123']
	conditions_sql TEXT,
	conditions_params TEXT[],
	-- if set, then this subscription will only receive changes
	-- where the diff between the row_after and row_before
	-- has at least one of the fields in the diff_only_fields array
	diff_only_fields TEXT[],
	-- if temporary, then the subscription will be removed
	-- when the connection closes
	is_temporary BOOLEAN NOT NULL DEFAULT TRUE,
	type VARCHAR(32) NOT NULL DEFAULT 'websocket',
	additional_data JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_subs_device_conds_topic
	ON postgraphile_meta.subscriptions(worker_device_id, conditions_sql, topic);

ALTER TABLE postgraphile_meta.subscriptions ENABLE ROW LEVEL SECURITY;

-- Create fn & trigger to populate the queue name to the permanent queue
-- if the subscription is not temporary and the queue name is not set
CREATE OR REPLACE FUNCTION postgraphile_meta.populate_queue_name()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.cursor IS NULL THEN
		-- If the cursor is not set, then set it to the current time
		NEW.cursor := COALESCE(
			(SELECT MAX(id) FROM postgraphile_meta.events LIMIT 1),
			pgmb.create_message_id()
		);
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql PARALLEL SAFE SECURITY DEFINER;

CREATE TRIGGER trg_populate_queue_name
BEFORE INSERT ON postgraphile_meta.subscriptions
FOR EACH ROW
EXECUTE FUNCTION postgraphile_meta.populate_queue_name();

CREATE TABLE IF NOT EXISTS postgraphile_meta.events(
	id varchar(24) PRIMARY KEY,
	table_name varchar(64) NOT NULL,
	schema_name varchar(64) NOT NULL,
	op varchar(16) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
	topic varchar(255) NOT NULL GENERATED ALWAYS AS (
		-- topic is a combination of table, schema and action
		postgraphile_meta.create_topic(schema_name, table_name, op)
	) STORED,
	row_before jsonb, -- the old state of the row (only for updates)
	row_data jsonb, -- the current state of the row
		-- (after for inserts, updates & before for deletes)
	diff jsonb -- the difference between row_after & row_before. For updates only
);

CREATE INDEX IF NOT EXISTS idx_events_topic_id
	ON postgraphile_meta.events (topic, id);

CREATE OR REPLACE FUNCTION postgraphile_meta.push_for_subscriptions()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO postgraphile_meta.events(
			id,
			table_name,
			schema_name,
			op,
			row_data
		)
		SELECT
			pgmb.create_message_id(),
			TG_TABLE_NAME,
			TG_TABLE_SCHEMA,
			TG_OP,
			to_jsonb(n)
		FROM NEW n;
	ELSIF TG_OP = 'DELETE' THEN
		INSERT INTO postgraphile_meta.events(
			id,
			table_name,
			schema_name,
			op,
			row_data
		)
		SELECT
			pgmb.create_message_id(),
			TG_TABLE_NAME,
			TG_TABLE_SCHEMA,
			TG_OP,
			to_jsonb(o)
		FROM OLD o;
	ELSIF TG_OP = 'UPDATE' THEN
		-- For updates, we can send both old and new data
		INSERT INTO postgraphile_meta.events(
			id,
			table_name,
			schema_name,
			op,
			row_data,
			row_before,
			diff
		)
		SELECT
			pgmb.create_message_id(),
			TG_TABLE_NAME,
			TG_TABLE_SCHEMA,
			TG_OP,
			n.data,
			o.data,
			postgraphile_meta.jsonb_diff(n.data, o.data)
		FROM (
			SELECT to_jsonb(n) as data, row_number() OVER () AS rn FROM NEW n
		) AS n
		INNER JOIN (
			SELECT to_jsonb(o) as data, row_number() OVER () AS rn FROM OLD o
		) AS o ON n.rn = o.rn;
	END IF;

	RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION postgraphile_meta.make_subscribable(
	tbl regclass
)
RETURNS VOID AS $$
BEGIN
	-- Create a trigger to push changes to the subscriptions queue
	BEGIN
		EXECUTE 'CREATE TRIGGER
			postg_on_insert
			AFTER INSERT ON ' || tbl::varchar || '
			REFERENCING NEW TABLE AS NEW
			FOR EACH STATEMENT
			EXECUTE FUNCTION postgraphile_meta.push_for_subscriptions();';
	EXCEPTION
		WHEN duplicate_object THEN
			NULL;
  END;
	BEGIN
		EXECUTE 'CREATE TRIGGER
			postg_on_delete
			AFTER DELETE ON ' || tbl::varchar || '
			REFERENCING OLD TABLE AS OLD
			FOR EACH STATEMENT
			EXECUTE FUNCTION postgraphile_meta.push_for_subscriptions();';
	EXCEPTION
		WHEN duplicate_object THEN
			NULL;
  END;
	BEGIN
		EXECUTE 'CREATE TRIGGER
			postg_on_update
			AFTER UPDATE ON ' || tbl::varchar || '
			REFERENCING OLD TABLE AS OLD
			NEW TABLE AS NEW
			FOR EACH STATEMENT
			EXECUTE FUNCTION postgraphile_meta.push_for_subscriptions();';
	EXCEPTION
		WHEN duplicate_object THEN
			NULL;
  END;
END
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_subscribable(
	tbl regclass
) RETURNS VOID AS $$
BEGIN
	-- Remove the triggers for the table
	EXECUTE 'DROP TRIGGER IF EXISTS postg_on_insert ON ' || tbl::varchar || ';';
	EXECUTE 'DROP TRIGGER IF EXISTS postg_on_delete ON ' || tbl::varchar || ';';
	EXECUTE 'DROP TRIGGER IF EXISTS postg_on_update ON ' || tbl::varchar || ';';
END
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if a subscription should receive a change
CREATE OR REPLACE FUNCTION postgraphile_meta.should_subscription_recv_change(
	sub postgraphile_meta.subscriptions,
	cs postgraphile_meta.events
)
RETURNS BOOLEAN AS $$
DECLARE
	final_query TEXT := sub.conditions_sql;
	-- We'll use before row data if available, as the person may receive the change
	-- before the row is updated in the database.
	row_data jsonb := COALESCE(cs.row_before, cs.row_data);
	params TEXT[] := array_prepend(row_data::varchar, sub.conditions_params);
	rslt BOOLEAN := false;
BEGIN
	-- loop through params and replace each occurrence of $1, $2, etc.
	-- with $1[i] where i is the index of the parameter
	FOR i IN 1 .. array_length(params, 1) LOOP
		final_query := replace(final_query, '$' || i, '$1[' || i || ']');
	END LOOP;

	EXECUTE final_query INTO rslt USING params;
	RETURN rslt;
END
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

-- Creates a function to compute the difference between two JSONB objects
-- Treats 'null' values, and non-existent keys as equal
CREATE OR REPLACE FUNCTION postgraphile_meta.jsonb_diff(a jsonb, b jsonb)
RETURNS jsonb AS $$
SELECT jsonb_object_agg(key, value) FROM (
	SELECT key, value FROM jsonb_each(a) WHERE value != 'null'::jsonb
  EXCEPT
  SELECT key, value FROM jsonb_each(b) WHERE value != 'null'::jsonb
)
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.get_events_for_subscriptions_by_filter(
	filter_txt TEXT,
	device_id VARCHAR(64),
	batch_size INT DEFAULT 250
)
RETURNS TABLE(
	id varchar(24),
	topic varchar(128),
	row_data jsonb,
	row_before jsonb,
	diff jsonb,
	subscription_ids varchar(64)[]
) AS $$
BEGIN
	RETURN QUERY EXECUTE '
		SELECT
			e.id, e.topic, e.row_data, e.row_before, e.diff, ARRAY_AGG(s.id)
		FROM postgraphile_meta.subscriptions s
		INNER JOIN postgraphile_meta.events e ON (
			s.conditions_sql = $1 AND s.topic = e.topic AND e.id > s.cursor
			AND ' || filter_txt || '
			AND (
				s.diff_only_fields IS NULL
				OR (
					e.diff IS NOT NULL
					AND e.diff ?| s.diff_only_fields
				)
			)
		)
		WHERE s.worker_device_id = $2
		GROUP BY e.id, e.topic, e.row_data, e.row_before, e.diff
		ORDER BY e.id ASC
		LIMIT $3'
		USING filter_txt, device_id, batch_size;
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

-- Function to send changes to match & send changes to relevant subscriptions
CREATE OR REPLACE FUNCTION postgraphile_meta.get_events_for_subscriptions(
	device_name VARCHAR(64),
	-- we need a batch size to avoid creating arrays that are too large
	-- which would then cause this function to fail
	batch_size int DEFAULT 250
) RETURNS TABLE(
	id varchar(24),
	topic varchar(128),
	row_data jsonb,
	row_before jsonb,
	diff jsonb,
	subscription_ids varchar(64)[]
) AS $$
BEGIN
	RETURN QUERY (
		WITH relevant_sqls AS (
			SELECT conditions_sql
			FROM postgraphile_meta.subscriptions s
			WHERE s.worker_device_id = device_name
			GROUP BY conditions_sql
		),
		result AS (
			SELECT e.*
			FROM relevant_sqls s
			CROSS JOIN postgraphile_meta.get_events_for_subscriptions_by_filter(
				s.conditions_sql, device_name, batch_size
			) e
		),
		updated_subs AS (
			UPDATE postgraphile_meta.subscriptions s
			SET cursor = (SELECT MAX(r.id) FROM result r)
			WHERE s.id IN (SELECT DISTINCT unnest(r.subscription_ids) FROM result r)
		)
		SELECT * FROM result
	);
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_all_stale_devices_and_subs()
RETURNS RECORD AS $$
DECLARE
	que_del_count INT;
BEGIN
	PERFORM (
		WITH deleted_queues AS (
			DELETE FROM postgraphile_meta.active_devices
			WHERE
				last_activity_at < NOW() - INTERVAL '15 minutes'
				OR last_activity_at IS NULL
			RETURNING name
		)
		SELECT pgmb.delete_queue(name) FROM deleted_queues
	);

	RETURN que_del_count;
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_stale_subscriptions(
	device_id VARCHAR
) RETURNS VOID AS $$
BEGIN
	DELETE FROM postgraphile_meta.subscriptions
	WHERE worker_device_id = device_id AND is_temporary = TRUE;
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.mark_device_queue_active(
	device_id VARCHAR(64)
)
RETURNS VOID AS $$
BEGIN
	INSERT INTO postgraphile_meta.active_devices(name, last_activity_at)
	VALUES (device_id, NOW())
	ON CONFLICT (name) DO UPDATE
	SET last_activity_at = NOW();
END
$$ LANGUAGE plpgsql PARALLEL SAFE;