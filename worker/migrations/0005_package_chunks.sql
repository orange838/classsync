-- 0005: 插件包体从 packages.content 单列搬到分块表
--
-- 原因：D1 单行 / 单语句有大小上限，几百 KB 以上就 SQLITE_TOOBIG，
-- 而真实插件包动辄几 MB。拆成多行存，整体能力只受数据库总量限制（免费 5 GB）。
--
-- 顺带把 packages.content 里的老数据搬过去，搬完置空，之后不再使用该列。

CREATE TABLE IF NOT EXISTS package_chunks (
  package_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  data       TEXT NOT NULL,          -- base64 分片
  PRIMARY KEY (package_id, seq)
);

INSERT OR IGNORE INTO package_chunks(package_id, seq, data)
SELECT id, 0, content FROM packages WHERE content IS NOT NULL AND LENGTH(content) > 0;

UPDATE packages SET content = NULL WHERE content IS NOT NULL;
