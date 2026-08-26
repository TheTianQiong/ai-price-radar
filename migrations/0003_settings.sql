-- 运行时可配置设置（通知等），管理后台可读写；env 变量作为部署默认值
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);
