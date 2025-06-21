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
	row_before jsonb, -- the old state of the row (only for inserts & updates)
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
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

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
	conditions_input JSONB,
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

-- Create fn & trigger to populate the queue name
CREATE OR REPLACE FUNCTION postgraphile_meta.populate_queue_name()
RETURNS TRIGGER AS $$
BEGIN
	-- If the queue name is not set, then set it to the permanent queue
	IF NEW.is_temporary THEN
		PERFORM pgmb.assert_queue(
			NEW.pgmb_queue_name,
			default_headers := '{"contentType":"application/json"}'::jsonb,
			queue_type := 'unlogged'::pgmb.queue_type
		);

		INSERT INTO postgraphile_meta.active_queues(name)
		VALUES (NEW.pgmb_queue_name)
		ON CONFLICT DO NOTHING;
	ELSIF NEW.pgmb_queue_name IS NULL THEN 
		NEW.pgmb_queue_name := 'postg_permanent_subs';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql PARALLEL SAFE;
CREATE TRIGGER trg_populate_queue_name
BEFORE INSERT ON postgraphile_meta.subscriptions
FOR EACH ROW
EXECUTE FUNCTION postgraphile_meta.populate_queue_name();

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

CREATE OR REPLACE FUNCTION postgraphile_meta.get_topic_from_change_json(
	change_json jsonb
) RETURNS varchar(255) AS $$
BEGIN
	RETURN (change_json->>'schema')
		|| '.' || (change_json->>'table')
		|| '.' || (change_json->>'kind');
END
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.get_changes(
	slot_name name,
	upto_lsn pg_lsn DEFAULT NULL,
	upto_nchanges int DEFAULT 10,
	VARIADIC options text[] DEFAULT '{}'::text[]
) RETURNS SETOF postgraphile_meta.change_info AS $$
SELECT
	(
		cs.lsn,
		change->>'kind',
		change->>'table',
		change->>'schema',
		-- topic is a combination of table, schema and kind
		postgraphile_meta.get_topic_from_change_json(change),
		-- before
		CASE
			WHEN change->>'kind' IN ('insert', 'update') THEN before
		END,
		-- data
		CASE
			WHEN change->>'kind' IN ('insert', 'update')
				THEN after
			WHEN change->>'kind' = 'delete'
				THEN before
			ELSE NULL
		END,
		-- diff
		CASE
			WHEN change->>'kind' = 'update'
				THEN postgraphile_meta.jsonb_diff(before, after)
		END
	) FROM (
		SELECT *, jsonb_array_elements(data::jsonb->'change') AS change
		FROM pg_catalog.pg_logical_slot_peek_changes(
			slot_name, upto_lsn, upto_nchanges, VARIADIC options
		)
) AS cs
CROSS JOIN LATERAL jsonb_object(
	ARRAY(SELECT jsonb_array_elements_text(cs.change->'columnnames')),
	ARRAY(SELECT jsonb_array_elements_text(cs.change->'columnvalues'))
) as after
CROSS JOIN LATERAL jsonb_object(
	ARRAY(SELECT jsonb_array_elements_text(cs.change->'oldkeys'->'keynames')),
	ARRAY(SELECT jsonb_array_elements_text(cs.change->'oldkeys'->'keyvalues'))
) as before
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION postgraphile_meta.send_changes_to_subscriptions(
	slot_name name,
	upto_lsn pg_lsn DEFAULT NULL,
	upto_nchanges int DEFAULT 10,
	VARIADIC options text[] DEFAULT '{}'::text[]
) RETURNS VOID AS $$
BEGIN
	PERFORM (
		WITH changes AS (
			SELECT
				s.id,
				s.pgmb_queue_name as queue_name,
				convert_to(to_jsonb(ARRAY_AGG(cs))::varchar, 'utf-8') AS data
			FROM postgraphile_meta.get_changes(
				slot_name, upto_lsn, upto_nchanges, VARIADIC options
			) AS cs
			INNER JOIN postgraphile_meta.subscriptions s ON
				s.topic = cs.op_topic
			GROUP BY s.id
		),
		grouped_changes AS (
			SELECT
				queue_name,
				ARRAY_AGG(
					(
						data,
						jsonb_object(ARRAY['subscriptionId'], ARRAY[id]),
						NULL
					)::pgmb.enqueue_msg
				) AS records
			FROM changes
			GROUP BY queue_name
		)
		SELECT pgmb.send(queue_name, records) FROM grouped_changes
	);
END
$$ LANGUAGE plpgsql PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_stale_devices_and_subs()
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

CREATE OR REPLACE FUNCTION postgraphile_meta.mark_current_device_queue_active()
RETURNS VOID AS $$
BEGIN
	INSERT INTO postgraphile_meta.active_queues(name, last_activity_at)
	VALUES (postgraphile_meta.get_tmp_queue_name(), NOW())
	ON CONFLICT (name) DO UPDATE
	SET last_activity_at = NOW();
END
$$ LANGUAGE plpgsql PARALLEL SAFE;