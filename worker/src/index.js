import { pairDevice, syncDevice, unpairDevice } from './device.js';
import {
  requireAdmin, login, logout, state, saveDraft, getDraft, publish,
  makePairingCode, pushCommand, updateSettings, deleteDevice,
} from './admin.js';
import { fail } from './util.js';
import { ADMIN_HTML } from './adminHtml.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        },
      });
    }

    try {
      // ---- 设备端 ----
      if (path === '/api/device/pair' && method === 'POST') return cors(await pairDevice(request, env));
      if (path === '/api/device/sync' && method === 'POST') return cors(await syncDevice(request, env));
      if (path === '/api/device/unpair' && method === 'POST') return cors(await unpairDevice(request, env));

      // ---- 后台 ----
      if (path === '/' || path === '/admin') {
        return new Response(ADMIN_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (path === '/api/admin/login' && method === 'POST') return await login(request, env);
      if (path === '/api/admin/logout' && method === 'POST') return await logout();

      if (path.startsWith('/api/admin/')) {
        if (!(await requireAdmin(request, env))) return fail('未登录', 401);
        if (path === '/api/admin/state' && method === 'GET') return await state(env);
        if (path === '/api/admin/pairing' && method === 'POST') return await makePairingCode(request, env);
        if (path === '/api/admin/command' && method === 'POST') return await pushCommand(request, env);
        if (path === '/api/admin/settings' && method === 'POST') return await updateSettings(request, env);

        const draftMatch = path.match(/^\/api\/admin\/draft\/([^/]+)$/);
        if (draftMatch) {
          if (method === 'GET') return await getDraft(env, draftMatch[1]);
          if (method === 'POST') return await saveDraft(request, env, draftMatch[1]);
        }
        const pubMatch = path.match(/^\/api\/admin\/publish\/([^/]+)$/);
        if (pubMatch && method === 'POST') return await publish(request, env, pubMatch[1]);

        const devMatch = path.match(/^\/api\/admin\/device\/([^/]+)$/);
        if (devMatch && method === 'DELETE') return await deleteDevice(env, devMatch[1]);
      }

      return fail('接口不存在', 404);
    } catch (err) {
      return fail(`服务端错误: ${err?.message || err}`, 500);
    }
  },
};

function cors(res) {
  res.headers.set('access-control-allow-origin', '*');
  return res;
}
