import fs from 'node:fs';

const B = 'https://classsync.cslblog.dpdns.org';
const KEY = fs.readFileSync('.admin_key.tmp', 'utf8').trim();
const dev = JSON.parse(fs.readFileSync('.dev.tmp', 'utf8'));

const r1 = await fetch(B + '/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: KEY }),
});
const CK = String((r1.headers.getSetCookie() || [''])[0]).split(';')[0];

const H = { 'Content-Type': 'application/json', Cookie: CK };
const DH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dev.device_token };

let r = await fetch(B + '/api/device/sync', {
  method: 'POST',
  headers: DH,
  body: JSON.stringify({
    runtime: { status: 'class', title: '数学', period_end: new Date(Date.now() + 600000).toISOString() },
    env: { app_version: '2.0.0', plugin_version: '0.1.0', data_mode: 'portable', data_dir: 'D:/cw2/data' },
    schedule_rev: 0,
  }),
});
console.log('sync1', r.status, JSON.stringify(await r.json()).slice(0, 300));

r = await fetch(B + '/api/admin/state', { headers: { Cookie: CK } });
const st = await r.json();
console.log('state.devices', JSON.stringify(st.devices));

const payload = {
  meta: { id: 'sync', version: 1, maxWeekCycle: 2, startDate: '2026-09-01' },
  subjects: [{ id: 's1', name: '数学' }],
  days: [],
  overrides: [],
};
r = await fetch(B + '/api/admin/draft/' + dev.device_id, {
  method: 'POST', headers: H, body: JSON.stringify({ payload }),
});
console.log('draft', r.status, JSON.stringify(await r.json()));

r = await fetch(B + '/api/admin/publish/' + dev.device_id, { method: 'POST', headers: { Cookie: CK } });
console.log('publish', r.status, JSON.stringify(await r.json()));

r = await fetch(B + '/api/device/sync', {
  method: 'POST', headers: DH,
  body: JSON.stringify({ runtime: { status: 'break', title: '课间' }, env: {}, schedule_rev: 0 }),
});
const s2 = await r.json();
console.log('sync2 rev=', s2.schedule && s2.schedule.revision, 'poll=', s2.poll_interval, 'cmds=', JSON.stringify(s2.commands));

r = await fetch(B + '/api/device/sync', {
  method: 'POST', headers: DH,
  body: JSON.stringify({ runtime: { status: 'break' }, env: {}, schedule_rev: 1 }),
});
const s3 = await r.json();
console.log('sync3 (already at rev1) schedule=', s3.schedule);

r = await fetch(B + '/api/admin/command', {
  method: 'POST', headers: H,
  body: JSON.stringify({ device_id: dev.device_id, type: 'upload_schedule', payload: {} }),
});
const cmd = await r.json();
console.log('cmd', r.status, JSON.stringify(cmd));

r = await fetch(B + '/api/device/sync', {
  method: 'POST', headers: DH,
  body: JSON.stringify({ runtime: {}, env: {}, schedule_rev: 1 }),
});
const s4 = await r.json();
console.log('sync4 cmds=', JSON.stringify(s4.commands));

r = await fetch(B + '/api/device/unpair', { method: 'POST', headers: DH, body: '{}' });
console.log('unpair', r.status, JSON.stringify(await r.json()));
