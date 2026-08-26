-- AI 价格雷达初始 schema

-- 价格历史：每 (date, provider, model) 一行，复合主键天然实现同一天同模型去重，同时是 upsert 的冲突目标
CREATE TABLE IF NOT EXISTS price_history (
  date            TEXT    NOT NULL,   -- 'YYYY-MM-DD'（UTC）
  provider        TEXT    NOT NULL,   -- anthropic|openai|gemini|deepseek|kimi|qwen|glm
  model           TEXT    NOT NULL,   -- 归一化模型名，如 'claude-sonnet-5'
  currency        TEXT    NOT NULL,   -- 源币种 'USD'|'CNY'
  input_usd       REAL,               -- 每 1M tokens
  output_usd      REAL,
  input_cny       REAL,
  output_cny      REAL,
  cache_hit_usd   REAL,               -- 缓存命中输入价（若有）
  cache_hit_cny   REAL,
  cache_write_usd REAL,               -- 缓存写入价（若有）
  cache_write_cny REAL,
  context_window  INTEGER,            -- tokens，可空
  notes           TEXT,               -- JSON：阶梯价/分区/峰值档/单位等元信息
  updated_at      TEXT    NOT NULL,   -- ISO8601 精确抓取时间
  PRIMARY KEY (date, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_price_model_date ON price_history(provider, model, date);
CREATE INDEX IF NOT EXISTS idx_price_date ON price_history(date);

-- 抓取日志：每次运行每个 provider 一行
CREATE TABLE IF NOT EXISTS fetch_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at      TEXT NOT NULL,          -- 同一次运行内各 provider 相同，便于按 provider 取最新
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL,          -- 'ok' | 'partial' | 'error'
  ok_count    INTEGER NOT NULL DEFAULT 0,
  err_count   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,                   -- 最后异常信息（截断）
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fetchlog_provider_run ON fetch_log(provider, run_at);
