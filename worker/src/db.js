// D1 访问封装

export async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(key, String(value))
    .run();
}

export async function getDeviceByToken(env, tokenHash) {
  return env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(tokenHash).first();
}

export async function getDevice(env, id) {
  return env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
}

export async function listDevices(env) {
  const { results } = await env.DB.prepare('SELECT * FROM devices ORDER BY created_at').all();
  return results || [];
}

/** 只在状态真的变化时更新，省行写入次数 */
export async function updateDeviceRuntime(env, device, patch) {
  const changed =
    device.status !== patch.status ||
    device.current_title !== patch.current_title ||
    device.period_end !== patch.period_end ||
    device.next_title !== patch.next_title ||
    device.schedule_rev !== patch.schedule_rev ||
    device.schedule_hash !== patch.schedule_hash ||
    device.app_version !== patch.app_version ||
    device.plugin_version !== patch.plugin_version ||
    device.data_mode !== patch.data_mode ||
    device.data_dir !== patch.data_dir ||
    (device.last_error || '') !== (patch.last_error || '');

  if (!changed) {
    // 只刷新心跳，用于在线判断；上行只在 last_seen 每 5 分钟才写一次
    const lastMs = device.last_seen ? Date.parse(device.last_seen) : 0;
    if (Date.now() - lastMs < 5 * 60 * 1000) return false;
    await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?')
      .bind(new Date().toISOString(), device.id)
      .run();
    return true;
  }

  await env.DB.prepare(
    `UPDATE devices SET last_seen=?, status=?, current_title=?, period_end=?, next_title=?,
     app_version=?, plugin_version=?, data_mode=?, data_dir=?, schedule_rev=?, schedule_hash=?, last_error=?
     WHERE id=?`
  )
    .bind(
      new Date().toISOString(),
      patch.status ?? null,
      patch.current_title ?? null,
      patch.period_end ?? null,
      patch.next_title ?? null,
      patch.app_version ?? null,
      patch.plugin_version ?? null,
      patch.data_mode ?? null,
      patch.data_dir ?? null,
      patch.schedule_rev ?? 0,
      patch.schedule_hash ?? null,
      patch.last_error ?? null,
      device.id
    )
    .run();
  return true;
}

export async function latestSchedule(env, deviceId) {
  return env.DB.prepare(
    'SELECT revision, payload, created_at FROM schedules WHERE device_id = ? ORDER BY revision DESC LIMIT 1'
  )
    .bind(deviceId)
    .first();
}
