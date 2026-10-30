-- ClassSync D1 schema v1
-- 设备表：最多 2 行
CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_seen      TEXT,
  status         TEXT,
  current_title  TEXT,
  period_end     TEXT,
  next_title     TEXT,
  app_version    TEXT,
  plugin_version TEXT,
  data_mode      TEXT,
  data_dir       TEXT,
  schedule_rev   INTEGER NOT NULL DEFAULT 0,
  schedule_hash  TEXT,
  last_error     TEXT
);

-- 已发布课表版本：每台设备独立
CREATE TABLE IF NOT EXISTS schedules (
  device_id  TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, revision)
);

-- 草稿：每台设备一行
CREATE TABLE IF NOT EXISTS drafts (
  device_id  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 一次性配对码
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  device_name TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT
);

-- 指令队列
CREATE TABLE IF NOT EXISTS commands (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_commands_device  ON commands(device_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_seen     ON devices(last_seen);

-- 全局设置（轮询间隔等）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('poll_interval', '120');
INSERT OR IGNORE INTO settings(key, value) VALUES ('max_devices', '2');
