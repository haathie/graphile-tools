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

CREATE TYPE postgraphile_meta.change_info AS (
	lsn pg_lsn,
	op varchar(16), -- 'insert', 'update', 'delete'
	op_table varchar(64), -- table name
	op_schema varchar(64), -- schema name
	op_topic varchar(255),
	row_before jsonb, -- the old state of the row (only for updates)
	row_data jsonb, -- the current state of the row
		-- (after for inserts, updates & before for deletes)
	diff jsonb -- the difference between row_after & row_before. For updates only
);

-- Unique ID of the device that's connected to the database.
-- Could be hostname, or just the pid
CREATE OR REPLACE FUNCTION postgraphile_meta.get_session_device_id()
RETURNS VARCHAR AS $$
	SELECT current_setting('app.device_id');
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION postgraphile_meta.get_tmp_queue_name(
	device_id VARCHAR DEFAULT postgraphile_meta.get_session_device_id()
) RETURNS VARCHAR AS $$
	SELECT 'postg_tmp_sub_' || device_id
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER;

CREATE TABLE IF NOT EXISTS postgraphile_meta.active_queues(
	name VARCHAR(64) PRIMARY KEY,
	last_activity_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS postgraphile_meta.subscriptions (
	-- unique identifier for the subscription
	id VARCHAR(48) PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	pgmb_queue_name VARCHAR(64) NOT NULL DEFAULT
		postgraphile_meta.get_tmp_queue_name()
		REFERENCES pgmb.queues(name) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_subscriptions_topic
	ON postgraphile_meta.subscriptions USING hash (topic);
CREATE INDEX IF NOT EXISTS idx_subscriptions_queue_name
	ON postgraphile_meta.subscriptions USING hash (pgmb_queue_name);

ALTER TABLE postgraphile_meta.subscriptions ENABLE ROW LEVEL SECURITY;

-- Create fn & trigger to populate the queue name to the permanent queue
-- if the subscription is not temporary and the queue name is not set
CREATE OR REPLACE FUNCTION postgraphile_meta.populate_queue_name()
RETURNS TRIGGER AS $$
BEGIN
	-- If the queue name is not set, then set it to the permanent queue
	IF NOT NEW.is_temporary AND NEW.pgmb_queue_name IS NULL THEN 
		NEW.pgmb_queue_name := 'postg_permanent_subs';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql PARALLEL SAFE SECURITY DEFINER;

CREATE TRIGGER trg_populate_queue_name
BEFORE INSERT ON postgraphile_meta.subscriptions
FOR EACH ROW
EXECUTE FUNCTION postgraphile_meta.populate_queue_name();

-- Function to check if a subscription should receive a change
CREATE OR REPLACE FUNCTION postgraphile_meta.should_subscription_recv_change(
	sub postgraphile_meta.subscriptions,
	cs postgraphile_meta.change_info
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

CREATE OR REPLACE FUNCTION postgraphile_meta.get_changes(
	slot_name name,
	upto_nchanges int,
	table_names text[]
) RETURNS SETOF postgraphile_meta.change_info AS $$
	SELECT
		(
			cs.lsn,
			data->>'action',
			data->>'table',
			data->>'schema',
			-- topic is a combination of table, schema and action
			postgraphile_meta.create_topic(
				data->>'schema',
				data->>'table',
				data->>'action'
			),
			-- before
			CASE
				WHEN data->>'action' = 'U' THEN before.item
			END,
			-- data
			CASE
				WHEN data->>'action' IN ('I', 'U')
					THEN after.item
				WHEN data->>'action' = 'D'
					THEN before.item
				ELSE NULL
			END,
			-- diff
			CASE
				WHEN data->>'action' = 'U'
					THEN postgraphile_meta.jsonb_diff(after.item, before.item)
			END
		)
	FROM (
		SELECT lsn, data::jsonb as data
		FROM pg_catalog.pg_logical_slot_peek_changes(
			slot_name, null, upto_nchanges,
			'add-tables', array_to_string(table_names, ','),
			'format-version', '2',
			'include-types', 'false',
			'actions', 'insert,update,delete',
			'include-transaction', 'false'
		)
	) AS cs
	CROSS JOIN LATERAL (
		SELECT jsonb_object_agg(elem->>'name', elem->'value')
		FROM jsonb_array_elements(data->'columns') as elem
	) as after(item)
	CROSS JOIN LATERAL (
		SELECT jsonb_object_agg(elem->>'name', elem->'value')
		FROM jsonb_array_elements(data->'identity') as elem
	) as before(item);
$$ LANGUAGE sql VOLATILE;

-- Function to send changes to match & send changes to relevant subscriptions
CREATE OR REPLACE FUNCTION postgraphile_meta.send_changes_to_subscriptions(
	slot_name name,
	upto_nchanges int,
	table_names text[],
	-- we need a batch size to avoid creating arrays that are too large
	-- which would then cause this function to fail
	batch_size int DEFAULT 250
) RETURNS VOID AS $$
BEGIN
	PERFORM (
		WITH changes AS (
			SELECT
				s.pgmb_queue_name as queue_name,
				s.id as id,
				to_jsonb(cs) AS cs_json,
				ROW_NUMBER() OVER () as rn
			FROM postgraphile_meta.get_changes(
				slot_name, upto_nchanges, table_names
			) AS cs
			INNER JOIN postgraphile_meta.subscriptions s ON
				s.topic = cs.op_topic
				AND (
					s.conditions_sql IS NULL
					OR postgraphile_meta.should_subscription_recv_change(s, cs)
				)
				AND (
					s.diff_only_fields IS NULL
					OR (
						cs.diff IS NOT NULL
						-- if diff_only_fields is not null, then we check if the diff
						-- has at least one of the fields in the diff_only_fields array
						AND cs.diff ?| s.diff_only_fields
					)
				)
		),
		grouped_changes AS (
			SELECT
				queue_name,
				(
					convert_to((jsonb_agg(cs_json ORDER BY rn))::varchar, 'utf-8'),
					jsonb_build_object('subscriptionId', id),
					NULL
				)::pgmb.enqueue_msg as record
			FROM changes
			GROUP BY queue_name, id, CEIL(rn / batch_size)::int
		)
		SELECT COUNT(*)
		FROM grouped_changes
		CROSS JOIN pgmb.send(queue_name, ARRAY[record])
		WHERE queue_name IS NOT NULL
	);
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_all_stale_devices_and_subs()
RETURNS RECORD AS $$
DECLARE
	que_del_count INT;
BEGIN
	PERFORM (
		WITH deleted_queues AS (
			DELETE FROM postgraphile_meta.active_queues
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
	WHERE pgmb_queue_name = postgraphile_meta.get_tmp_queue_name(device_id)
		AND is_temporary = TRUE;
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.mark_device_queue_active(
	device_id VARCHAR(64)
)
RETURNS VOID AS $$
BEGIN
	INSERT INTO postgraphile_meta.active_queues(name, last_activity_at)
	VALUES (postgraphile_meta.get_tmp_queue_name(device_id), NOW())
	ON CONFLICT (name) DO UPDATE
	SET last_activity_at = NOW();
END
$$ LANGUAGE plpgsql PARALLEL SAFE;