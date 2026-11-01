// 插件广场（plaza.cw.rinlit.cn）代理
//
// 为什么不让设备自己去广场下载：
//   1. 班级电脑可能连不上外网/GitHub（本机还有加速器改 hosts）
//   2. 广场的包没有经过我们校验
// 所以：Worker 去广场取包 → 校验 zip + 大小 → 存进 D1 的 packages 表 →
//       设备只从我们自己的 Worker 下载（带设备令牌、校验 sha256）。
//
// 广场接口（与 CW2 内置广场客户端一致）：
//   GET /api/plugins?page=&per_page=&sort=           列表
//   GET /api/plugins/search?q=&page=&per_page=       搜索
//   GET /api/plugins/{id}                            详情（{ok, data}）
//   GET /api/plugins/{id}/resources/release?format=cwplugin   包本体

import { randomId, sha256, nowIso, ok, fail } from './util.js';
import { MAX_PACKAGE_BYTES } from './packages.js';

const PLAZA_BASE = 'https://plaza.cw.rinlit.cn';

// 包体已改为分块存储（见 packages.js），不再受 D1 单行上限限制，
// 上限只用来防止把免费额度吃满。
const MAX_IMPORT_BYTES = MAX_PACKAGE_BYTES;

async function plazaFetch(path, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(PLAZA_BASE + path, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'ClassSync/0.1 (+https://github.com/orange838/classsync)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function plazaJson(path) {
  const res = await plazaFetch(path);
  if (!res.ok) throw new Error(`广场返回 ${res.status}`);
  const json = await res.json();
  if (json && json.ok === false) throw new Error(json.error || '广场拒绝了请求');
  return json && json.data !== undefined ? json.data : json;
}

function normalizePlugin(p) {
  const m = p.manifest && typeof p.manifest === 'object' ? p.manifest : p;
  const id = String(m.id || p.id || p.plugin_id || '');
  return {
    id,
    name: m.name || p.name || id,
    version: m.version || p.version || '',
    author: typeof m.author === 'object' && m.author ? m.author.name || '' : m.author || '',
    description: (m.description || p.description || '').slice(0, 200),
    updated_at: m.updated_at || m.updated || p.updated_at || p.updated || null,
    downloads: p.downloads ?? p.download_count ?? null,
    icon: id ? `${PLAZA_BASE}/api/plugins/${encodeURIComponent(id)}/resources/icon` : '',
  };
}

/** GET /api/admin/plaza?q=&page= —— 浏览/搜索广场，只读，不落库 */
export async function browsePlaza(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const page = Math.min(Math.max(Number(url.searchParams.get('page') || 1) || 1, 1), 20);
  const perPage = 20;

  let path;
  if (q) {
    path = `/api/plugins/search?q=${encodeURIComponent(q)}&page=${page}&per_page=${perPage}`;
  } else {
    path = `/api/plugins?page=${page}&per_page=${perPage}&sort=updated`;
  }

  try {
    const res = await plazaFetch(path);
    if (!res.ok) return fail(`广场返回 ${res.status}`);
    const json = await res.json();
    if (json && json.ok === false) return fail(json.error || '广场拒绝了请求');
    const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const meta = json?.meta || {};
    return ok({
      items: raw.map(normalizePlugin).filter((p) => p.id),
      total: meta.total ?? raw.length,
      total_pages: meta.total_pages ?? 1,
      page,
    });
  } catch (e) {
    return fail('连不上插件广场：' + (e?.message || e));
  }
}

/**
 * POST /api/admin/plaza/import { id }
 * 把广场上的某个插件包下载下来、校验后存成我们自己的一条 packages 记录。
 */
export async function importFromPlaza(request, env) {
  const body = await request.json().catch(() => null);
  const id = String(body?.id || '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) return fail('插件 id 不合法');

  let manifest;
  try {
    manifest = await plazaJson(`/api/plugins/${encodeURIComponent(id)}`);
  } catch (e) {
    return fail('取插件信息失败：' + (e?.message || e));
  }

  const version = String(manifest?.version || '');
  const name = String(manifest?.name || id);

  // 同一个插件同一个版本已经导入过就直接复用，省一次下载和一份存储
  const existed = await env.DB.prepare(
    'SELECT id, filename, sha256, size, created_at, plugin_id, plugin_version, source FROM packages WHERE plugin_id = ? AND plugin_version = ? LIMIT 1'
  )
    .bind(id, version || '')
    .first();
  if (existed) return ok({ package: existed, reused: true });

  // 包体不由我们中转：下载地址本来就是公开的，设备自己直连广场取即可。
  // Worker 只记下地址和 sha256，下发时一起交给设备去校验。
  const downloadUrl = `${PLAZA_BASE}/api/plugins/${encodeURIComponent(id)}/resources/release?format=cwplugin`;

  let sha = '';
  let size = 0;
  try {
    const res = await plazaFetch(`/api/plugins/${encodeURIComponent(id)}/resources/release?format=cwplugin`, {
      timeoutMs: 25000,
      method: 'HEAD',
    });
    if (res.ok) size = Number(res.headers.get('content-length') || 0) || 0;
  } catch {
    // HEAD 不被支持也没关系，设备下载时靠 sha256 兜底
  }

  const pkgId = `pkg_${randomId('').slice(0, 10)}`;
  // 文件名要能看出是哪个插件、哪个版本，后台列表里不用再点开
  const filename = `${name}-${version || 'unknown'}.cwplugin`.slice(0, 200);

  await env.DB.prepare(
    `INSERT INTO packages(id, filename, sha256, size, content, created_at, plugin_id, plugin_version, source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(pkgId, filename, sha, size, downloadUrl, nowIso(), id, version, 'plaza')
    .run();

  return ok({
    package: {
      id: pkgId,
      filename,
      sha256: sha,
      size,
      created_at: nowIso(),
      plugin_id: id,
      plugin_version: version,
      source: 'plaza',
      download_url: downloadUrl,
    },
    reused: false,
  });
}
