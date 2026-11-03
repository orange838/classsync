// 设备端接口：pair / sync / unpair

import { randomId, randomCode, sha256, nowIso, json, fail, ok } from './util.js';
import { getDeviceByToken, updateDeviceRuntime, latestSchedule, getSetting } from './db.js';
import { getPackageContent, dropPackageContent } from './packages.js';

async function requireDevice(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { error: fail('缺少设备令牌', 401) };
  const device = await getDeviceByToken(env, await sha256(token));
  if (!device) return { error: fail('设备令牌无效', 401) };
  return { device };
}

/** GET /api/device/package/:id —— 只下发后台暂存过的包，需要设备令牌 */
export async function downloadPackage(request, env, packageId) {
  const auth = await requireDevice(request, env);
  if (auth.error) return auth.error;
  if (!packageId) return fail('缺少包 id');

  const row = await env.DB.prepare('SELECT filename, sha256 FROM packages WHERE id = ?')
    .bind(packageId)
    .first();
  if (!row) return fail('包不存在或已被删除', 404);

  let bytes;
  try {
    bytes = await getPackageContent(env, packageId);
  } catch {
    return fail('包内容已损坏', 500);
  }
  if (!bytes) return fail('包内容已损坏，或已被清理：重新在后台点一次', 410);

  // 包只暂存到设备取走为止。取完立刻删包体，元数据（名字/版本/sha256）留着，
  // 后台才能继续判断「已装未装」，也不不会白占免费存储。
  // 万一设备重试下载，会收到 410，后台重推一次即可。
  try {
    await dropPackageContent(env, packageId);
  } catch {
    // 清理失败不影响本次下发
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="${String(row.filename || 'package.cwplugin').replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'x-package-sha256': row.sha256,
      'cache-control': 'no-store',
    },
  });
}

/** POST /api/device/pair */
export async function pairDevice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }

  const code = String(body.pairing_code || '').trim().toUpperCase();
  const name = String(body.device_name || '').trim();
  if (!code) return fail('配对码不能为空');
  if (!name) return fail('设备名称不能为空');

  const codeHash = await sha256(code);
  const row = await env.DB.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?')
    .bind(codeHash)
    .first();

  if (!row) return fail('配对码不存在', 400);
  if (row.used_at) return fail('配对码已被使用', 409);
  if (Date.parse(row.expires_at) <= Date.now()) return fail('配对码已过期', 410);

  // 上限默认 3 台；老库里若还留着 max_devices=2，也按 3 兜底，避免改了默认值不生效
  const rawLimit = Number(await getSetting(env, 'max_devices', '3'));
  const maxDevices = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(3, rawLimit) : 3;
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').all();
  const count = results?.[0]?.n ?? 0;
  if (count >= maxDevices) return fail(`最多只能绑定 ${maxDevices} 台设备`, 409);

  const token = `cst_${randomId('')}`;
  const deviceId = `dev_${randomId('').slice(0, 12)}`;
  const now = nowIso();
  const tokenHash = await sha256(token);

  await env.DB.prepare(
    `INSERT INTO devices(id, name, token_hash, created_at, last_seen)
     VALUES(?, ?, ?, ?, ?)`
  )
    .bind(deviceId, name, tokenHash, now, now)
    .run();

  await env.DB.prepare('UPDATE pairing_codes SET used_at = ?, used_by = ? WHERE code_hash = ?')
    .bind(now, deviceId, codeHash)
    .run();

  const pollInterval = Number(await getSetting(env, 'poll_interval', '30'));

  return ok({
    device_id: deviceId,
    device_token: token,
    device_name: name,
    poll_interval: pollInterval,
  });
}

/** POST /api/device/sync —— 一次往返：上状态 + 下课表/指令 */
export async function syncDevice(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.error) return auth.error;
  const device = auth.device;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('请求体不是合法 JSON');
  }

  const runtime = body.runtime || {};
  const cert = body.env || {};
  // 设备本次上报的「已应用」课表版本，用它判断是否还需要下发
  const appliedRev = Number(body.schedule_rev ?? 0) || 0;

  // 已装插件清单（只读信息）：限制条数与字段长度，不信任设备输入
  let pluginsJson = null;
  if (Array.isArray(body.plugins)) {
    pluginsJson = JSON.stringify(
      body.plugins.slice(0, 60).map((p) => ({
        id: String(p?.id || '').slice(0, 120),
        name: String(p?.name || '').slice(0, 80),
        version: String(p?.version || '').slice(0, 40),
        enabled: Boolean(p?.enabled),
        bundled: Boolean(p?.bundled),
        has_ui: Boolean(p?.has_ui),
      })).filter((p) => p.id)
    );
  }

  await updateDeviceRuntime(env, device, {
    status: runtime.status ?? null,
    current_title: runtime.title ?? null,
    period_end: runtime.period_end ?? null,
    next_title: runtime.next_title ?? null,
    schedule_rev: Number(body.schedule_rev ?? 0),
    schedule_hash: body.schedule_hash ?? null,
    app_version: cert.app_version ?? null,
    plugin_version: cert.plugin_version ?? null,
    data_mode: cert.data_mode ?? null,
    data_dir: cert.data_dir ?? null,
    plugins_json: pluginsJson,
    pending_install: typeof body.pending_install === 'string' ? body.pending_install.slice(0, 120) : null,
    last_error: body.last_error ?? null,
  });

  // 处理指令回执
  if (Array.isArray(body.acks) && body.acks.length) {
    for (const ack of body.acks.slice(0, 20)) {
      if (!ack?.id) continue;
      await env.DB.prepare(
        `UPDATE commands SET status = ?, finished_at = ?, result = ?
         WHERE id = ? AND device_id = ? AND status IN ('sent','pending')`
      )
        .bind(ack.ok ? 'done' : 'failed', nowIso(), String(ack.result || '').slice(0, 500), ack.id, device.id)
        .run();
    }
  }

  // 处理课表上传（后台请求快照时）
  if (body.schedule_upload && body.schedule_upload.request_id) {
    const cmd = await env.DB.prepare(
      `SELECT * FROM commands WHERE id = ? AND device_id = ? AND type = 'upload_schedule'`
    )
      .bind(body.schedule_upload.request_id, device.id)
      .first();
    if (cmd) {
      const payload = JSON.stringify(body.schedule_upload.payload || {});
      if (payload.length < 2_000_000) {
        await env.DB.prepare(
          `INSERT INTO drafts(device_id, payload, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
        )
          .bind(device.id, payload, nowIso())
          .run();
      }
    }
  }

  const latest = await latestSchedule(env, device.id);
  const schedule =
    latest && latest.revision > appliedRev
      ? { revision: latest.revision, payload: JSON.parse(latest.payload) }
      : null;

  const { results: pending } = await env.DB.prepare(
    `SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at LIMIT 10`
  )
    .bind(device.id)
    .all();

  const commands = [];
  for (const cmd of pending || []) {
    commands.push({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload ? JSON.parse(cmd.payload) : null,
    });
    await env.DB.prepare('UPDATE commands SET status = ? WHERE id = ?').bind('sent', cmd.id).run();
  }

  const pollInterval = Number(await getSetting(env, 'poll_interval', '30'));

  return ok({
    server_time: nowIso(),
    poll_interval: pollInterval,
    schedule,
    commands,
  });
}

/** POST /api/device/unpair */
export async function unpairDevice(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.error) return auth.error;
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(auth.device.id).run();
  await env.DB.prepare('DELETE FROM schedules WHERE device_id = ?').bind(auth.device.id).run();
  await env.DB.prepare('DELETE FROM drafts WHERE device_id = ?').bind(auth.device.id).run();
  await env.DB.prepare('DELETE FROM commands WHERE device_id = ?').bind(auth.device.id).run();
  return ok();
}
