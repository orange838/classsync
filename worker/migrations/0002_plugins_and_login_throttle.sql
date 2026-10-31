-- 0002: 插件清单上报 + 登录限流

-- 设备上报的已装插件清单（JSON 数组，只读信息）
ALTER TABLE devices ADD COLUMN plugins_json TEXT;

-- 登录失败限流（按 IP）
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  first_at      TEXT NOT NULL,
  locked_until  TEXT
);
