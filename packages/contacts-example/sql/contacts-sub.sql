-- Create RLS policies for subscriptions table
DROP POLICY IF EXISTS app_user_subscriptions ON postg_realtime.subscriptions;
CREATE POLICY app_user_subscriptions ON postg_realtime.subscriptions
FOR ALL TO "app_user"
-- allow selecting all subs, as they're not really selected
USING (TRUE)
WITH CHECK (
	additional_data->'inputCondition'->>'orgId' = current_setting('app.org_id')
);