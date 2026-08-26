-- 抓取告警状态：记录每家厂商上次抓取状态，用于「状态变化」检测
-- 只在 正常->失败/疑似改版 的瞬间告警，避免每天重复提醒；恢复后再失败会再次提醒
CREATE TABLE IF NOT EXISTS alert_state (
  provider     TEXT PRIMARY KEY,
  last_status  TEXT NOT NULL,      -- ok | error | partial
  model_count  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);
