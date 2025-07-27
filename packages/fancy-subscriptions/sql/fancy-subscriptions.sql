DROP SCHEMA IF EXISTS postgraphile_meta CASCADE; -- TODO: remove this in production
CREATE SCHEMA IF NOT EXISTS "postgraphile_meta";

-- Unique ID of the device that's connected to the database.
-- Could be hostname, or just the pid
CREATE OR REPLACE FUNCTION postgraphile_meta.get_session_device_id()
RETURNS VARCHAR AS $$
	SELECT current_setting('app.device_id');
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER;

-- fn to create a random bigint. Used for message IDs
-- copied from pgmb
CREATE OR REPLACE FUNCTION postgraphile_meta.create_random_bigint()
RETURNS BIGINT AS $$
BEGIN
	-- the message ID allows for 7 hex-bytes of randomness,
	-- i.e. 28 bits of randomness. Thus, the max we allow is 2^28/2
	-- i.e. 0xffffff8, which allows for batch inserts to increment the
	-- randomness for up to another 2^28/2 messages (more than enough)
	RETURN (random() * 0xffffff8)::BIGINT;
END
$$ LANGUAGE plpgsql VOLATILE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION postgraphile_meta.create_event_id(
	ts timestamptz DEFAULT clock_timestamp(),
	rand bigint DEFAULT postgraphile_meta.create_random_bigint()
)
RETURNS VARCHAR(24) AS $$
BEGIN
	RETURN substr(
		'ps'
		|| to_hex((extract(epoch from ts) * 1000000)::bigint)
		|| to_hex(rand),
		1,
		24
	);
END
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER;

-- we'll find the latest committed event ID that can be picked up safely
-- in order to avoid missing events
CREATE OR REPLACE FUNCTION postgraphile_meta.get_max_pickable_event_id()
RETURNS VARCHAR(24) AS $$
BEGIN
	RETURN postgraphile_meta.create_event_id(
		COALESCE(
			(
				SELECT MIN(xact_start)
				FROM pg_stat_activity ps
				WHERE ps.state
					IN ('active', 'idle in transaction', 'idle in transaction (aborted)')
			),
			clock_timestamp()
		)
	);
END
$$ LANGUAGE plpgsql VOLATILE STRICT PARALLEL SAFE SECURITY DEFINER;

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
	latest_cursor VARCHAR(24) NOT NULL,
	last_activity_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS postgraphile_meta.subscriptions (
	-- unique identifier for the subscription
	id VARCHAR(48) PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	worker_device_id VARCHAR(64) NOT NULL DEFAULT postgraphile_meta.get_session_device_id(),
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

-- -- Create fn & trigger to populate the queue name to the permanent queue
-- -- if the subscription is not temporary and the queue name is not set
-- CREATE OR REPLACE FUNCTION postgraphile_meta.populate_queue_name()
-- RETURNS TRIGGER AS $$
-- BEGIN
-- 	RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql PARALLEL SAFE SECURITY DEFINER;

-- CREATE TRIGGER trg_populate_queue_name
-- BEFORE INSERT ON postgraphile_meta.subscriptions
-- FOR EACH ROW
-- EXECUTE FUNCTION postgraphile_meta.populate_queue_name();

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
			postgraphile_meta.create_event_id(),
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
			postgraphile_meta.create_event_id(),
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
			postgraphile_meta.create_event_id(),
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
	device_id VARCHAR(64)
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
		INNER JOIN tmp_events e ON (
			s.conditions_sql = $1 AND s.topic = e.topic
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
		ORDER BY e.id ASC'
		USING filter_txt, device_id;
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
	CREATE TEMP TABLE IF NOT EXISTS tmp_events
		(LIKE postgraphile_meta.events INCLUDING DEFAULTS);

	INSERT INTO tmp_events
		SELECT e.*
		FROM postgraphile_meta.events e
		INNER JOIN postgraphile_meta.active_devices d ON d.name = device_name
		WHERE e.id > d.latest_cursor
			AND e.id < postgraphile_meta.get_max_pickable_event_id()
		ORDER BY e.id ASC
		LIMIT batch_size;

	RAISE NOTICE 'Processing events %', postgraphile_meta.get_max_pickable_event_id();

	RETURN QUERY (
		WITH relevant_sqls AS (
			SELECT conditions_sql
			FROM postgraphile_meta.subscriptions s
			WHERE s.worker_device_id = device_name
			GROUP BY conditions_sql
		),
		result AS (
			SELECT e.* FROM relevant_sqls s
			CROSS JOIN postgraphile_meta.get_events_for_subscriptions_by_filter(
				s.conditions_sql, device_name
			) e
		),
		updated_active_devices AS (
			UPDATE postgraphile_meta.active_devices d
			SET latest_cursor = (SELECT MAX(e.id) FROM tmp_events e)
			WHERE d.name = device_name
				-- only update if we actually inserted some events
				AND EXISTS (SELECT 1 FROM tmp_events LIMIT 1)
		),
		del_tmp_events AS (DELETE FROM tmp_events)
		SELECT * FROM result
	);
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_all_stale_devices_and_subs()
RETURNS VOID AS $$
BEGIN
	DELETE FROM postgraphile_meta.active_devices
	WHERE last_activity_at < NOW() - INTERVAL '15 minutes'
		OR last_activity_at IS NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION postgraphile_meta.remove_stale_subscriptions(
	device_id VARCHAR
) RETURNS VOID AS $$
BEGIN
	DELETE FROM postgraphile_meta.subscriptions
	WHERE worker_device_id = device_id AND is_temporary;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION postgraphile_meta.mark_device_queue_active(
	device_id VARCHAR(64)
)
RETURNS VOID AS $$
BEGIN
	INSERT INTO postgraphile_meta.active_devices
		(name, latest_cursor, last_activity_at)
	VALUES (
		device_id,
		postgraphile_meta.get_max_pickable_event_id(),
		NOW()
	)
	ON CONFLICT (name) DO UPDATE SET last_activity_at = NOW();
END
$$ LANGUAGE plpgsql;