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
    // 每次同步都刷新心跳。以前为省写入做了 5 分钟节流，结果“最后心跳”最多
    // 滱后 5 分钟，而在线判定也是 5 分钟，设备明明在干活却显示离线。
    // 代价：2 台设备 30 秒间隔约 5,760 行写/天，占 D1 免费额度 5.8%。
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
