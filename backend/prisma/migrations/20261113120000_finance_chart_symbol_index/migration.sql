-- 加速按 chart_symbol 查找产品（meostock 资讯时间线）
CREATE INDEX IF NOT EXISTS "idx_finance_instruments_chart_symbol"
  ON "finance_instruments" ("chart_symbol");
