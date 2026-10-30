import fs from 'node:fs';

const B = 'https://classsync.cslblog.dpdns.org';
const KEY = fs.readFileSync('.admin_key.tmp', 'utf8').trim();

const r1 = await fetch(B + '/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: KEY }),
});
const CK = String((r1.headers.getSetCookie() || [''])[0]).split(';')[0];
const H = { 'Content-Type': 'application/json', Cookie: CK };

// 新建一套干净设备
const pr = await (await fetch(B + '/api/admin/pairing', {
  method: 'POST', headers: H, body: JSON.stringify({ minutes: 30, device_name: '复测机' }),
})).json();
const dev = await (await fetch(B + '/api/device/pair', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pairing_code: pr.code, device_name: '复测机' }),
})).json();
console.log('paired', dev.ok, dev.device_id);

const DH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dev.device_token };
const sync = async (body) => (await fetch(B + '/api/device/sync', { method: 'POST', headers: DH, body: JSON.stringify(body) })).json();

const payload = {
  meta: { id: '_sync', version: 1, maxWeekCycle: 2, startDate: '2026-09-01' },
  subjects: [{ id: 's1', name: '数学' }], days: [], overrides: [],
};
await fetch(B + '/api/admin/draft/' + dev.device_id, {
  method: 'POST', headers: H, body: JSON.stringify({ payload }),
});
await fetch(B + '/api/admin/publish/' + dev.device_id, { method: 'POST', headers: { Cookie: CK } });

console.log('第一次申领 rev0 ->', (await sync({ schedule_rev: 0 })).schedule?.revision ?? null);
console.log('已应用 rev1 后再申领 ->', (await sync({ schedule_rev: 1 })).schedule ?? null);
console.log('新发布 rev2 后申领 ->', await (async () => {
  await fetch(B + '/api/admin/draft/' + dev.device_id, {
    method: 'POST', headers: H, body: JSON.stringify({ payload: { ...payload, meta: { ...payload.meta, version: 2 } } }),
  });
  await fetch(B + '/api/admin/publish/' + dev.device_id, { method: 'POST', headers: { Cookie: CK } });
  return (await sync({ schedule_rev: 1 })).schedule?.revision ?? null;
})());

await fetch(B + '/api/device/unpair', { method: 'POST', headers: DH, body: '{}' });
console.log('已清理测试设备');
