GRANT USAGE, CREATE ON SCHEMA postgraphile_meta TO "app_user";

GRANT
	SELECT,
	INSERT(
		topic,
		type,
		additional_data,
		conditions_sql,
		conditions_params,
		is_temporary
	),
	DELETE
ON postgraphile_meta.subscriptions TO "app_user";
-- Create RLS policies for subscriptions table
DROP POLICY IF EXISTS app_user_subscriptions ON postgraphile_meta.subscriptions;
CREATE POLICY app_user_subscriptions ON postgraphile_meta.subscriptions
FOR ALL TO "app_user"
-- allow selecting all subs, as they're not really selected
USING (TRUE)
WITH CHECK (
	additional_data->'inputCondition'->>'teamId' = current_setting('app.org_id')
);