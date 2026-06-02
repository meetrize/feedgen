-- Keep legacy user_plans in sync with membership_plan_configs because
-- users.current_plan_id still references user_plans and the database feed-limit
-- trigger reads user_plans/can_create_feed during INSERT on feeds.
INSERT INTO "user_plans" (
  "id",
  "name",
  "description",
  "max_feeds",
  "duration_days",
  "updated_at"
)
SELECT
  "id",
  "name",
  "description",
  "max_feeds",
  NULLIF("history_days", 0),
  CURRENT_TIMESTAMP
FROM "membership_plan_configs"
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "max_feeds" = EXCLUDED."max_feeds",
  "duration_days" = EXCLUDED."duration_days",
  "updated_at" = CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION public.can_create_feed(user_id_param integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    max_feeds_var INTEGER;
    current_feed_count_var INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = user_id_param) THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(mpc.max_feeds, up.max_feeds, 0)
      INTO max_feeds_var
      FROM users u
      LEFT JOIN membership_plan_configs mpc ON mpc.id = u.current_plan_id
      LEFT JOIN user_plans up ON up.id = u.current_plan_id
     WHERE u.id = user_id_param;

    SELECT COUNT(*) INTO current_feed_count_var
      FROM feeds
     WHERE user_id = user_id_param
       AND is_active = TRUE;

    IF max_feeds_var = 0 THEN
        RETURN TRUE;
    END IF;

    RETURN current_feed_count_var < max_feeds_var;
END;
$function$;
