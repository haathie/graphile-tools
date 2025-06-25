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
CREATE POLICY app_user_subscriptions ON postgraphile_meta.subscriptions
FOR ALL TO "app_user"
USING (TRUE)
WITH CHECK (TRUE);