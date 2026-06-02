-- 会员等级配置表：保存各套餐展示与额度配置
CREATE TABLE IF NOT EXISTS "membership_plan_configs" (
  "id" INTEGER NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "price_label" VARCHAR(50),
  "price_suffix" VARCHAR(20),
  "max_feeds" INTEGER NOT NULL DEFAULT 0,
  "min_fetch_interval" INTEGER NOT NULL DEFAULT 1800,
  "history_days" INTEGER NOT NULL DEFAULT 30,
  "storage_mb" INTEGER NOT NULL DEFAULT 500,
  "highlight" BOOLEAN NOT NULL DEFAULT FALSE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_plan_configs_pkey" PRIMARY KEY ("id")
);

INSERT INTO "membership_plan_configs" (
  "id", "name", "description", "price_label", "price_suffix",
  "max_feeds", "min_fetch_interval", "history_days", "storage_mb", "highlight", "sort_order"
) VALUES
  (1, '免费版', '适合轻度使用，个人日常阅读。', '免费', '/年', 30, 1800, 30, 500, FALSE, 1),
  (2, '普通会员', '适合深度用户，提升信息覆盖范围。', '¥98', '/年', 200, 600, 180, 5120, TRUE, 2),
  (3, '超级会员', '适合团队/重度监控，高频抓取与长期沉淀。', '¥580', '/年', 1000, 60, 1095, 51200, FALSE, 3)
ON CONFLICT (id) DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "price_label" = EXCLUDED."price_label",
  "price_suffix" = EXCLUDED."price_suffix",
  "max_feeds" = EXCLUDED."max_feeds",
  "min_fetch_interval" = EXCLUDED."min_fetch_interval",
  "history_days" = EXCLUDED."history_days",
  "storage_mb" = EXCLUDED."storage_mb",
  "highlight" = EXCLUDED."highlight",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = CURRENT_TIMESTAMP;
