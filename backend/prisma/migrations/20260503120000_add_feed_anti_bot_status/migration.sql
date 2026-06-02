-- Feed 反爬状态检测：标记后端抓取时是否命中验证码、人机验证、访问受限等反爬页面
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "anti_bot_status" VARCHAR(32) NOT NULL DEFAULT 'normal';
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "anti_bot_detected_at" TIMESTAMP(6);
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "anti_bot_message" TEXT;

CREATE INDEX IF NOT EXISTS "idx_feeds_anti_bot_status" ON "feeds"("anti_bot_status");
