// 后台页面 DOM 冒烟测试。
//
// 解决的问题：adminHtml.js 里的内联脚本语法正确，不代表点得动。
// 曾经因为 deviceCard() 里少写一个 '+'，card.innerHTML 被截断，
// 后续 querySelector('[data-act="edit"]') 返回 null，
// null.onclick 抛 TypeError，被 boot() 的 catch 静默吞掉，
// 表现就是「输入密钥点进入，完全没反应」。
//
// 这个测试用 jsdom 真正跑一遍：未登录 -> 输入密钥 -> 点进入 -> 断言主界面出现。

import { createRequire } from 'node:module';
import { ADMIN_HTML } from '../worker/src/adminHtml.js';

// jsdom 装在 worker/node_modules 里，避免仓库根再装一份
const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

const sampleState = {
  devices: [
    {
      id: 'dev-1',
      name: '家里电脑',
      online: true,
      last_seen: new Date().toISOString(),
      data_mode: 'portable',
      data_dir: 'D:/Program Files (x86)/Class Widgets 2/data',
      status: 'break',
      current_title: '课间',
      next_title: '数学',
      period_end: new Date(Date.now() + 300000).toISOString(),
      schedule_rev: 3,
      latest_revision: 3,
      last_error: null,
      pending_install: '',
      plugins: [
        { id: 'org.cslblog.classsync', name: '课表同步', version: '0.1.0', enabled: true, bundled: false, has_ui: true },
        { id: 'com.rinlit.countdowndays', name: '倒计时日', version: '1.1.0', enabled: true, bundled: false, has_ui: true },
        { id: 'builtin.demo', name: '示例', version: '1.0.0', enabled: false, bundled: true, has_ui: false }
      ]
    }
  ],
  commands: [
    { type: 'sync_now', device_id: 'dev-1', status: 'done', created_at: new Date().toISOString(), result: 'ok' }
  ],
  packages: [
    {
      id: 'pkg-1', filename: '倒计时日-1.2.0.cwplugin', size: 20480, sha256: 'a'.repeat(64),
      created_at: new Date().toISOString(),
      plugin_id: 'com.rinlit.countdowndays', plugin_version: '1.2.0', source: 'plaza'
    }
  ],
  settings: { poll_interval: '30' },
  online_grace_seconds: 120
};

const calls = [];
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const dom = new JSDOM(ADMIN_HTML, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = async (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      calls.push(method + ' ' + url);
      if (url === '/api/admin/login') return response(200, { ok: true });
      if (url.indexOf('/api/admin/plaza/import') === 0) {
        return response(200, {
          package: { id: 'pkg-2', filename: '倒计时日-1.3.0.cwplugin', plugin_version: '1.3.0', plugin_id: 'com.rinlit.countdowndays' },
          reused: false
        });
      }
      if (url.indexOf('/api/admin/plaza') === 0) {
        return response(200, {
          items: [
            { id: 'com.rinlit.countdowndays', name: '倒计时日', version: '1.3.0', author: 'rinlit' },
            { id: 'org.cslblog.classsync', name: '课表同步', version: '0.1.0', author: 'orange838' }
          ],
          total: 2
        });
      }
      if (url === '/api/admin/command') return response(200, { ok: true });
      if (url === '/api/admin/state') {
        // 第一次取 state 之前没登录，返回 401
        const loggedIn = calls.includes('POST /api/admin/login');
        return loggedIn ? response(200, sampleState) : response(401, { error: '未登录' });
      }
      return response(200, {});
    };
  }
});

const { window } = dom;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

await wait(50);

const doc = window.document;
const login = doc.getElementById('login');
const main = doc.getElementById('main');

console.log('登录按钮点击流程：');
check('初始显示登录框', login.style.display === 'block', '实际 ' + JSON.stringify(login.style.display));
check('初始隐藏主界面', main.style.display === 'none', '实际 ' + JSON.stringify(main.style.display));
check('未登录不弹错误提示', !doc.getElementById('toast').classList.contains('show'),
  '提示内容：' + doc.getElementById('toast').textContent);

doc.getElementById('keyInput').value = 'test-key';
doc.getElementById('loginBtn').click();
await wait(200);

check('登录后主界面可见', main.style.display === 'block', '实际 ' + JSON.stringify(main.style.display));
check('登录后登录框隐藏', login.style.display === 'none', '实际 ' + JSON.stringify(login.style.display));

const devices = doc.getElementById('devices');
console.log('设备卡片渲染：');
check('渲染出设备卡片', devices.querySelectorAll('.card').length === 1,
  '实际 ' + devices.querySelectorAll('.card').length + ' 张');
check('卡片含操作按钮', !!devices.querySelector('[data-act="edit"]'));
check('卡片含插件列表', /课表同步/.test(devices.textContent));
check('卡片含便携版标识', /便携版/.test(devices.textContent));
check('卡片含待安装提示位', !/待本机确认安装/.test(devices.textContent), '不该出现空提示');
check('有更新版本时出现升级按钮', !!devices.querySelector('[data-plugin-upgrade]'));

console.log('心跳实时刷新：');
check('心跳带具体秒数', /最后心跳 \d+ 秒前/.test(devices.textContent),
  '实际：' + devices.textContent.replace(/\s+/g, ' ').slice(0, 80));

// 把心跳时间改成 200 秒前，等 ticker 跑一拍，应该自己变成离线
const card = devices.querySelector('.card');
card.setAttribute('data-seen', new Date(Date.now() - 200000).toISOString());
await wait(1200);
check('超过宽限期自动转离线', /离线 · 最后心跳/.test(card.textContent),
  '实际：' + card.textContent.replace(/\s+/g, ' ').slice(0, 80));
const pill = card.querySelector('[data-online-pill]');
check('顶部药丸同步变离线', pill && pill.textContent === '离线',
  '实际：' + (pill && pill.textContent));
const dot = card.querySelector('.dot');
check('状态点同步变灰', dot && dot.className === 'dot off', '实际：' + (dot && dot.className));

const pkgList = doc.getElementById('pkgList');
console.log('插件包列表：');
check('渲染出插件包行', /countdowndays/.test(pkgList.textContent) || /倒计时日/.test(pkgList.textContent));
check('显示包内版本号', /v1\.2\.0/.test(pkgList.textContent), '实际：' + pkgList.textContent.replace(/\s+/g, ' '));
check('显示广场来源', /广场/.test(pkgList.textContent));
check('发送按钮变成升级', /升级到 v1\.2\.0/.test(pkgList.textContent),
  '实际：' + pkgList.textContent.replace(/\s+/g, ' '));

console.log('插件广场：');
doc.getElementById('plazaSearch').click();
await wait(200);
const plazaList = doc.getElementById('plazaList');
check('拉到广场列表', /倒计时日/.test(plazaList.textContent),
  '实际：' + plazaList.textContent.replace(/\s+/g, ' ').slice(0, 100));
check('已装 1.1.0 且广场 1.3.0 时提示升级', /1\.1\.0 → 1\.3\.0/.test(plazaList.textContent),
  '实际：' + plazaList.textContent.replace(/\s+/g, ' ').slice(0, 120));
const sendBtn = plazaList.querySelector('[data-plaza-send]');
check('广场行有推送按钮', !!sendBtn);
sendBtn.click();
await wait(250);
check('推送走了导入接口', calls.some(function(c){ return c.indexOf('POST /api/admin/plaza/import') === 0; }),
  '实际调用：' + calls.join(' , '));
check('推送走了下发指令', calls.some(function(c){ return c.indexOf('POST /api/admin/command') === 0; }),
  '实际调用：' + calls.join(' , '));

const cmdList = doc.getElementById('cmdList');
check('渲染出指令记录', /sync_now/.test(cmdList.textContent));

console.log('运行期错误：');
check('无脚本运行时错误', errors.length === 0, errors.join(' | '));

dom.window.close();

if (failed) {
  console.error('\n✗ 后台页面冒烟测试失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('\n✓ 后台页面可正常登录并渲染');
