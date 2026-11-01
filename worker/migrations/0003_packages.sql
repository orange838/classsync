-- 0003: 半自动插件安装（后台只负责把包搬到位，生效必须本机确认）

CREATE TABLE IF NOT EXISTS packages (
  id          TEXT PRIMARY KEY,
  filename    TEXT,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content     TEXT NOT NULL,      -- base64，仅存放你手动上传的包
  created_at  TEXT NOT NULL
);

-- 设备已暂存、等待本机确认的包（展示用短文本）
ALTER TABLE devices ADD COLUMN pending_install TEXT;
