-- 0004: 插件包来源与版本元数据
-- 后台要知道这一包是哪个插件、什么版本，才能在设备已装该插件时提示「升级」

ALTER TABLE packages ADD COLUMN plugin_id TEXT;
ALTER TABLE packages ADD COLUMN plugin_version TEXT;
ALTER TABLE packages ADD COLUMN source TEXT;        -- upload | plaza

CREATE INDEX IF NOT EXISTS idx_packages_plugin ON packages(plugin_id);
