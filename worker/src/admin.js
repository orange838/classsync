// 后台接口：登录、设备列表、草稿、发布、配对码、指令

import { randomId, randomCode, sha256, nowIso, ok, fail, readCookie, setCookie, clearCookie } from './util.js';
import { getSetting, setSetting } from './db.js';

const COOKIE = 'cs_admin';

// 登录限流：同一 IP 连续失败 5 次，锁 15 分钟
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

/** 服务端允许下发的指令类型。未知类型一律拒绝，避免脏数据入库 */
export const ALLOWED_COMMANDS = new Set([
  'sync_now',
  'upload_schedule',
  'switch_portable',
  'restart_app',
  'plugin_set_enabled',
  'plugin_uninstall',
]);

/** 常量时间字符串比较，避免按字节提前返回泄露信息 */
function timingSafeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 会话纪元：换密钥或点“全部下线”时自增，旧 Cookie 立即失效 */
async function sessionEpoch(env) {
  return String((await getSetting(env, 'session_epoch', '1')) || '1');
}

async function sessionToken(env) {
  return sha256(`classsync:${env.ADMIN_KEY || ''}:${await sessionEpoch(env)}`);
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function recordFail(env, ip, row, now) {
  try {
    const fresh = !row || now - Date.parse(row.first_at || 0) > FAIL_WINDOW_MS;
    const fails = fresh ? 1 : Number(row.fails || 0) + 1;
    const lockedUntil = fails >= MAX_FAILS ? new Date(now + LOCK_MS).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts(ip, fails, first_at, locked_until) VALUES(?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails,
         first_at = excluded.first_at, locked_until = excluded.locked_until`
    )
      .bind(ip, fails, fresh ? new Date(now).toISOString() : row.first_at, lockedUntil || row?.locked_until || null)
      .run();
  } catch {
    // 限流表不可用时不影响主流程
  }
}

export async function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  return timingSafeEqual(token, await sessionToken(env));
}

export async function login(request, env) {
  const expected = env.ADMIN_KEY;
  if (!expected) return fail('服务端未配置 ADMIN_KEY', 500);

  const ip = clientIp(request);
  const now = Date.now();
  let row = null;
  try {
    row = await env.DB.prepare(
      'SELECT fails, first_at, locked_until FROM login_attempts WHERE ip = ?'
    )
      .bind(ip)
      .first();
  } catch {
    // 限流表不存在时降级为不限流
  }
  if (row?.locked_until && Date.parse(row.locked_until) > now) {
    const mins = Math.max(1, Math.ceil((Date.parse(row.locked_until) - now) / 60000));
    return fail(`尝试次数过多，请 ${mins} 分钟后再试`, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }

  if (!timingSafeEqual(String(body.key || ''), expected)) {
    await recordFail(env, ip, row, now);
    return fail('密钥不正确', 401);
  }

  try {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  } catch {
    // 忽略
  }

  const token = await sessionToken(env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': setCookie(COOKIE, token),
    },
  });
}

export async function logout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': clearCookie(COOKIE) },
  });
}

/** 让所有已登录的浏览器会话立即失效（会话纪元 +1） */
export async function logoutAll(env) {
  const next = String(Number(await sessionEpoch(env) || 1) + 1);
  await setSetting(env, 'session_epoch', next);
  return new Response(JSON.stringify({ ok: true, epoch: next }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': clearCookie(COOKIE) },
  });
}

export async function state(env) {
  const { results: devices } = await env.DB.prepare('SELECT * FROM devices ORDER BY created_at').all();
  const { results: drafts } = await env.DB.prepare('SELECT device_id, updated_at FROM drafts').all();
  const { results: schedules } = await env.DB.prepare(
    'SELECT device_id, revision, created_at FROM schedules ORDER BY device_id, revision DESC'
  ).all();
  const { results: commands } = await env.DB.prepare(
    `SELECT id, device_id, type, status, created_at, finished_at, result FROM commands
     ORDER BY created_at DESC LIMIT 30`
  ).all();
  const { results: settings } = await env.DB.prepare('SELECT key, value FROM settings').all();

  const draftMap = Object.fromEntries((drafts || []).map((d) => [d.device_id, d.updated_at]));
  const latestMap = {};
  for (const s of schedules || []) {
    if (!latestMap[s.device_id]) latestMap[s.device_id] = { revision: s.revision, created_at: s.created_at };
  }

  const settingMap = Object.fromEntries((settings || []).map((s) => [s.key, s.value]));
  const pollInterval = Math.min(Math.max(Number(settingMap.poll_interval || 30) || 30, 15), 86400);
  // 在线判定给 2 个轮询间隔的宽限，且不低于 90 秒；
  // 否则轮询间隔调大后设备会被误判成离线
  const graceSeconds = Math.max(90, pollInterval * 2);
  const graceMs = graceSeconds * 1000;

  return ok({
    devices: (devices || []).map((d) => {
      let plugins = [];
      try {
        const parsed = d.plugins_json ? JSON.parse(d.plugins_json) : [];
        plugins = Array.isArray(parsed) ? parsed : [];
      } catch {
        plugins = [];
      }
      return {
      ...d,
      plugins_json: undefined,
      plugins,
      token_hash: undefined,
      draft_updated_at: draftMap[d.id] || null,
      latest_revision: latestMap[d.id]?.revision || 0,
      latest_published_at: latestMap[d.id]?.created_at || null,
      online: d.last_seen ? Date.now() - Date.parse(d.last_seen) < graceMs : false,
      };
    }),
    commands: commands || [],
    settings: settingMap,
    online_grace_seconds: graceSeconds,
  });
}

export async function saveDraft(request, env, deviceId) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.payload !== 'object') return fail('payload 必须是对象');
  const text = JSON.stringify(body.payload);
  if (text.length > 2_000_000) return fail('课表太大');
  await env.DB.prepare(
    `INSERT INTO drafts(device_id, payload, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  )
    .bind(deviceId, text, nowIso())
    .run();
  return ok();
}

export async function getDraft(env, deviceId) {
  const row = await env.DB.prepare('SELECT payload, updated_at FROM drafts WHERE device_id = ?')
    .bind(deviceId)
    .first();
  return ok({ payload: row ? JSON.parse(row.payload) : null, updated_at: row?.updated_at || null });
}

export async function publish(request, env, deviceId) {
  const draft = await env.DB.prepare('SELECT payload FROM drafts WHERE device_id = ?').bind(deviceId).first();
  if (!draft) return fail('没有可发布的草稿', 404);

  const latest = await env.DB.prepare(
    'SELECT MAX(revision) AS rev FROM schedules WHERE device_id = ?'
  )
    .bind(deviceId)
    .first();
  const nextRev = (latest?.rev || 0) + 1;

  await env.DB.prepare(
    'INSERT INTO schedules(device_id, revision, payload, created_at) VALUES(?, ?, ?, ?)'
  )
    .bind(deviceId, nextRev, draft.payload, nowIso())
    .run();

  return ok({ revision: nextRev });
}

export async function makePairingCode(request, env) {
  const body = await request.json().catch(() => ({}));
  const minutes = Math.min(Math.max(Number(body.minutes || 30), 1), 24 * 60);
  const code = randomCode(8);
  const now = nowIso();
  const expires = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO pairing_codes(code_hash, device_name, created_at, expires_at) VALUES(?, ?, ?, ?)'
  )
    .bind(await sha256(code), String(body.device_name || ''), now, expires)
    .run();
  return ok({ code, expires_at: expires });
}

export async function pushCommand(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.device_id || !body?.type) return fail('缺少 device_id 或 type');
  const type = String(body.type);
  if (!ALLOWED_COMMANDS.has(type)) return fail(`不支持的指令类型：${type}`);

  // 插件相关指令的参数校验
  if (type === 'plugin_set_enabled' || type === 'plugin_uninstall') {
    const pluginId = String(body.payload?.id || '').trim();
    if (!pluginId) return fail('缺少插件 id');
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(pluginId)) return fail('插件 id 格式非法');
    if (pluginId.startsWith('builtin.')) return fail('内置插件不允许操作');
    body.payload = { ...(body.payload || {}), id: pluginId };
    if (type === 'plugin_set_enabled') body.payload.enabled = Boolean(body.payload.enabled);
  }

  const id = `cmd_${randomId('').slice(0, 12)}`;
  await env.DB.prepare(
    'INSERT INTO commands(id, device_id, type, payload, status, created_at) VALUES(?, ?, ?, ?, ?, ?)'
  )
    .bind(id, body.device_id, body.type, JSON.stringify(body.payload || {}), 'pending', nowIso())
    .run();
  return ok({ id });
}

export async function updateSettings(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return fail('请求体无效');
  if (body.poll_interval != null) {
    // 下限 15 秒：两台设备 24 小时全开约 11,520 请求/天，占免费额度 11.5%
    // Worker 免费额度是账号级共享的，再快会挤占其他项目
    const v = Math.min(Math.max(Number(body.poll_interval), 15), 86400);
    await env.DB.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
      .bind('poll_interval', String(v))
      .run();
  }
  return ok();
}

export async function deleteDevice(env, deviceId) {
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId).run();
  await env.DB.prepare('DELETE FROM schedules WHERE device_id = ?').bind(deviceId).run();
  await env.DB.prepare('DELETE FROM drafts WHERE device_id = ?').bind(deviceId).run();
  await env.DB.prepare('DELETE FROM commands WHERE device_id = ?').bind(deviceId).run();
  return ok();
}
