-- Align public_feeds anti-bot fields with feeds table
ALTER TABLE "public_feeds" ADD COLUMN IF NOT EXISTS "anti_bot_detected_at" TIMESTAMP(6);
ALTER TABLE "public_feeds" ADD COLUMN IF NOT EXISTS "anti_bot_message" TEXT;
