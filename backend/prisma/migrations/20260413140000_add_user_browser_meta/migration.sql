-- 记录客户端浏览器特征（JSON），用于资料更新时写入
ALTER TABLE "users" ADD COLUMN "browser_meta" JSONB NULL;
