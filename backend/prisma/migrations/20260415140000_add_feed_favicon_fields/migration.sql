-- Feed 站点图标：外链 URL 或文字+背景色自制图标
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "favicon_url" VARCHAR(2000);
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "favicon_custom_text" VARCHAR(12);
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "favicon_custom_bg" VARCHAR(16);
