-- Public feed sharing: public_feeds, user_feed_subscriptions, share requests, article dual ownership

CREATE TABLE "public_feeds" (
  "id" SERIAL NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "url" VARCHAR(500) NOT NULL,
  "url_normalized" VARCHAR(500) NOT NULL,
  "source_type" VARCHAR(20) NOT NULL DEFAULT 'native',
  "selector_rules" JSONB,
  "selector_fingerprint" VARCHAR(64),
  "source_fingerprint" VARCHAR(64) NOT NULL,
  "feed_type" VARCHAR(50) DEFAULT 'rss',
  "favicon_url" VARCHAR(2000),
  "update_interval" INTEGER DEFAULT 1800,
  "use_proxy" BOOLEAN NOT NULL DEFAULT false,
  "anti_bot_status" VARCHAR(32) NOT NULL DEFAULT 'normal',
  "requires_auth" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(20) NOT NULL DEFAULT 'approved',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "tags" JSONB,
  "contributor_user_id" INTEGER,
  "subscriber_count" INTEGER NOT NULL DEFAULT 0,
  "last_fetched_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_feeds_source_fingerprint_key" ON "public_feeds"("source_fingerprint");
CREATE INDEX "idx_public_feeds_status_subscribers" ON "public_feeds"("status", "subscriber_count" DESC);
CREATE INDEX "idx_public_feeds_url_normalized" ON "public_feeds"("url_normalized");

ALTER TABLE "public_feeds"
  ADD CONSTRAINT "public_feeds_contributor_user_id_fkey"
  FOREIGN KEY ("contributor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "user_feed_subscriptions" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "public_feed_id" INTEGER NOT NULL,
  "group_id" INTEGER,
  "custom_title" VARCHAR(255),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "needs_translation" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_feed_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_user_feed_subscriptions_user_public_feed"
  ON "user_feed_subscriptions"("user_id", "public_feed_id");
CREATE INDEX "idx_user_feed_subscriptions_user_sort" ON "user_feed_subscriptions"("user_id", "sort_order");
CREATE INDEX "idx_user_feed_subscriptions_public_feed" ON "user_feed_subscriptions"("public_feed_id");

ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_public_feed_id_fkey"
  FOREIGN KEY ("public_feed_id") REFERENCES "public_feeds"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_feed_groups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "public_feed_share_requests" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "private_feed_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "reviewed_by" INTEGER,
  "reject_reason" TEXT,
  "submitted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMP(6),
  CONSTRAINT "public_feed_share_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_public_feed_share_requests_status"
  ON "public_feed_share_requests"("status", "submitted_at" DESC);
CREATE INDEX "idx_public_feed_share_requests_feed" ON "public_feed_share_requests"("private_feed_id");
CREATE UNIQUE INDEX "ux_public_feed_share_requests_pending_feed"
  ON "public_feed_share_requests"("private_feed_id")
  WHERE "status" = 'pending';

ALTER TABLE "public_feed_share_requests"
  ADD CONSTRAINT "public_feed_share_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "public_feed_share_requests"
  ADD CONSTRAINT "public_feed_share_requests_private_feed_id_fkey"
  FOREIGN KEY ("private_feed_id") REFERENCES "feeds"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "public_feed_share_requests"
  ADD CONSTRAINT "public_feed_share_requests_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "feeds" ADD COLUMN "public_feed_id" INTEGER;
CREATE INDEX "idx_feeds_public_feed_id" ON "feeds"("public_feed_id");
ALTER TABLE "feeds"
  ADD CONSTRAINT "feeds_public_feed_id_fkey"
  FOREIGN KEY ("public_feed_id") REFERENCES "public_feeds"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "articles" ADD COLUMN "public_feed_id" INTEGER;
ALTER TABLE "articles" ALTER COLUMN "feed_id" DROP NOT NULL;
CREATE INDEX "idx_articles_public_feed_id" ON "articles"("public_feed_id");
ALTER TABLE "articles"
  ADD CONSTRAINT "articles_public_feed_id_fkey"
  FOREIGN KEY ("public_feed_id") REFERENCES "public_feeds"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "articles"
  ADD CONSTRAINT "articles_feed_or_public_check"
  CHECK (("feed_id" IS NOT NULL) OR ("public_feed_id" IS NOT NULL));

ALTER TABLE "membership_plan_configs"
  ADD COLUMN "max_private_feeds" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "max_public_subscriptions" INTEGER NOT NULL DEFAULT 30;

UPDATE "membership_plan_configs" SET
  "max_private_feeds" = 3,
  "max_public_subscriptions" = 30
WHERE "id" = 1;

UPDATE "membership_plan_configs" SET
  "max_private_feeds" = 20,
  "max_public_subscriptions" = 200
WHERE "id" = 2;

UPDATE "membership_plan_configs" SET
  "max_private_feeds" = 100,
  "max_public_subscriptions" = 1000
WHERE "id" = 3;

CREATE OR REPLACE FUNCTION public.can_create_feed(user_id_param integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    max_private_var INTEGER;
    current_private_count INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = user_id_param) THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(mpc.max_private_feeds, mpc.max_feeds, up.max_feeds, 0)
      INTO max_private_var
      FROM users u
      LEFT JOIN membership_plan_configs mpc ON mpc.id = u.current_plan_id
      LEFT JOIN user_plans up ON up.id = u.current_plan_id
     WHERE u.id = user_id_param;

    SELECT COUNT(*) INTO current_private_count
      FROM feeds
     WHERE user_id = user_id_param
       AND is_active = TRUE
       AND public_feed_id IS NULL;

    IF max_private_var = 0 THEN
        RETURN TRUE;
    END IF;

    RETURN current_private_count < max_private_var;
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_create_public_subscription(user_id_param integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    max_public_var INTEGER;
    current_public_count INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = user_id_param) THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(mpc.max_public_subscriptions, mpc.max_feeds, 0)
      INTO max_public_var
      FROM users u
      LEFT JOIN membership_plan_configs mpc ON mpc.id = u.current_plan_id
     WHERE u.id = user_id_param;

    SELECT COUNT(*) INTO current_public_count
      FROM user_feed_subscriptions
     WHERE user_id = user_id_param
       AND is_active = TRUE;

    IF max_public_var = 0 THEN
        RETURN TRUE;
    END IF;

    RETURN current_public_count < max_public_var;
END;
$function$;
