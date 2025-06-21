GRANT USAGE, CREATE ON SCHEMA postgraphile_meta TO "app_user";

GRANT USAGE ON SEQUENCE postgraphile_meta.subscriptions_id_seq TO "app_user";

GRANT
	SELECT,
	INSERT(topic, conditions_input, type, additional_data),
	DELETE
ON postgraphile_meta.subscriptions TO "app_user";
