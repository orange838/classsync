// 插件包体的分块存储
//
// D1 单行、单语句都有大小上限，几 MB 的插件包一次写进去会 SQLITE_TOOBIG。
// 所以按固定大小切成多行，写多行、读多行拼回来。
// 好处：不引入任何新服务（R2 要绑支付方式），只用现有的 D1 免费额度。

// 每片 base64 约 256 KB。实测 900 KB 的 SQL 就会 SQLITE_TOOBIG，
// 256 KB 离上限很远，既能保证写入稳定，也不会让分片数膨胀太多。
const CHUNK_B64 = 256 * 1024;

// 包体只在 D1 里待到设备取走为止，最长给 2 小时。
// 两台设备、轮询 30 秒，正常 1 分钟内就会被取走；
// 留下来的是没人要的包（比如手滑上传），过期自己清掉，不白占免费存储。
export const PACKAGE_TTL_MS = 2 * 60 * 60 * 1000;

// 免费 D1 每行都算一次写入，别把包存太大。20 MB 已经远超实际插件体积。
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

function bytesToB64(bytes) {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 写入包体分片。调用方负责先插 packages 表的元数据。
 * @returns {Promise<{chunks:number}>}
 */
export async function putPackageContent(env, packageId, bytes) {
  const b64 = bytesToB64(bytes);
  const stmts = [];
  let seq = 0;
  for (let i = 0; i < b64.length; i += CHUNK_B64) {
    stmts.push(
      env.DB.prepare('INSERT INTO package_chunks(package_id, seq, data) VALUES(?, ?, ?)').bind(
        packageId,
        seq,
        b64.slice(i, i + CHUNK_B64)
      )
    );
    seq += 1;
  }
  if (!stmts.length) stmts.push(
    env.DB.prepare('INSERT INTO package_chunks(package_id, seq, data) VALUES(?, 0, ?)').bind(packageId, '')
  );

  // 分批提交，避免一次 batch 过大
  const BATCH = 8;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return { chunks: seq };
}

/** 读回包体。分片表没有记录时回退到老的 packages.content，兼容迁移前的数据 */
export async function getPackageContent(env, packageId) {
  const { results } = await env.DB.prepare(
    'SELECT data FROM package_chunks WHERE package_id = ? ORDER BY seq'
  )
    .bind(packageId)
    .all();

  if (results && results.length) {
    const b64 = results.map((r) => r.data || '').join('');
    return b64ToBytes(b64);
  }

  const legacy = await env.DB.prepare('SELECT content FROM packages WHERE id = ?')
    .bind(packageId)
    .first();
  if (legacy?.content) return b64ToBytes(legacy.content);
  return null;
}

export async function dropPackageContent(env, packageId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM package_chunks WHERE package_id = ?').bind(packageId),
    env.DB.prepare('UPDATE packages SET content = NULL WHERE id = ?').bind(packageId),
  ]);
}

/** 后台列表用：哪些包还没有包体，UI 上要把「发送」灰掉 */
export async function listPackageBodies(env) {
  const { results } = await env.DB.prepare(
    'SELECT package_id, COUNT(*) AS n FROM package_chunks GROUP BY package_id'
  ).all();
  return new Set((results || []).filter((r) => r.n > 0).map((r) => r.package_id));
}

/** 清掉超时没被取走的包体（硬件调用方：后台 state 接口，节流到 10 分钟一次） */
export async function sweepStalePackageBodies(env, now = Date.now()) {
  const cut = new Date(now - PACKAGE_TTL_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM packages p
     JOIN (SELECT package_id, COUNT(*) AS n FROM package_chunks GROUP BY package_id) c
       ON c.package_id = p.id
     WHERE p.created_at < ?`
  )
    .bind(cut)
    .all();
  const ids = (results || []).map((r) => r.id);
  for (const id of ids) {
    await dropPackageContent(env, id);
  }
  return ids.length;
}
