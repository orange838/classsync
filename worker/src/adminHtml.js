export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClassSync 控制台</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--card2:#1f232c;--line:#2b303b;--txt:#e6e9ef;--dim:#8b93a3;--acc:#4f8cff;--ok:#33c27f;--warn:#e8a33d;--err:#e2564d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px 80px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:18px;margin:0;font-weight:650;letter-spacing:.3px}
h1 span{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px rgba(51,194,127,.15)}
.dot.off{background:#5a6272}
.muted{color:var(--dim);font-size:12.5px}
.big{font-size:26px;font-weight:600;letter-spacing:.5px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}
button{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 13px;font-size:13px;cursor:pointer;font-family:inherit}
button:hover{border-color:#3d4552;background:#232833}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.primary:hover{background:#3f7bef}
button.danger{color:var(--err)}
button:disabled{opacity:.45;cursor:not-allowed}
input,textarea,select{background:#12151b;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:9px 11px;font:inherit;width:100%}
textarea{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5;resize:vertical;min-height:320px}
label{display:block;font-size:12.5px;color:var(--dim);margin:10px 0 5px}
.pill{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:20px;background:#232833;color:var(--dim);border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:rgba(51,194,127,.35)}
.pill.warn{color:var(--warn);border-color:rgba(232,163,61,.35)}
.pill.err{color:var(--err);border-color:rgba(226,86,77,.35)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
.mask.show{display:flex}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;width:100%;max-width:820px;max-height:90vh;overflow:auto}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#262c37;border:1px solid var(--line);padding:10px 18px;border-radius:10px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
.code{font:600 22px ui-monospace,Consolas,monospace;letter-spacing:3px;color:var(--acc)}
hr{border:0;border-top:1px solid var(--line);margin:14px 0}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Class<span>Sync</span> 控制台</h1>
  <div id="hdr-actions"></div>
</header>

<div id="login" class="card" style="max-width:420px;margin:60px auto;display:none">
  <div style="font-weight:600;margin-bottom:4px">输入管理密钥</div>
  <div class="muted">密钥在 Cloudflare Worker 的 ADMIN_KEY 变量里</div>
  <label>密钥</label>
  <input id="keyInput" type="password" placeholder="粘贴 ADMIN_KEY" />
  <div style="margin-top:14px"><button class="primary" id="loginBtn" style="width:100%">进入</button></div>
</div>

<div id="main" style="display:none">
  <div id="devices" class="grid"></div>
  <div class="card">
    <div class="row">
      <div><b>配对</b> <span class="muted">生成一次性配对码，在插件里填</span></div>
      <button id="pairBtn">生成配对码</button>
    </div>
    <div id="pairOut" class="muted" style="margin-top:10px"></div>
  </div>
  <div class="card">
    <div class="row">
      <div><b>设置</b></div>
    </div>
    <label>轮询间隔（秒）—— 设备多久来拉一次</label>
    <div style="display:flex;gap:10px;align-items:center">
      <input id="pollInput" style="max-width:160px" />
      <button id="savePoll">保存</button>
      <span class="muted">建议 60–300；越小越实时，越费请求</span>
    </div>
  </div>
  <div class="card">
    <div class="row"><b>最近指令</b><button id="refreshBtn">刷新</button></div>
    <div id="cmdList" style="margin-top:8px"></div>
  </div>
</div>
</div>

<div class="mask" id="mask">
  <div class="modal">
    <div class="row">
      <div><b id="modalTitle">课表</b> <span class="muted" id="modalSub"></span></div>
      <button id="modalClose">关闭</button>
    </div>
    <hr>
    <div class="muted" style="margin-bottom:8px">CW2 课表 JSON：包含 meta / subjects / days / overrides。改完先存草稿，确认无误再点发布。</div>
    <textarea id="schedText" spellcheck="false"></textarea>
    <div class="row" style="margin-top:12px">
      <div style="display:flex;gap:8px">
        <button id="btnFormat">格式化校验</button>
        <button id="btnSaveDraft">保存草稿</button>
        <button class="primary" id="btnPublish">发布到设备</button>
      </div>
      <span class="muted" id="draftInfo"></span>
    </div>
  </div>
</div>

<div class="mask" id="cmdMask">
  <div class="modal" style="max-width:460px">
    <div class="row"><b>下发指令</b><button id="cmdClose">关闭</button></div>
    <hr>
    <label>指令类型</label>
    <select id="cmdType">
      <option value="sync_now">立即同步</option>
      <option value="upload_schedule">上传本机课表到后台</option>
      <option value="switch_portable">切换便携模式</option>
      <option value="restart_app">重启 Class Widgets</option>
    </select>
    <div class="muted" style="margin-top:10px" id="cmdHint"></div>
    <div style="margin-top:16px"><button class="primary" id="cmdSend" style="width:100%">发送</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var state = null;
var currentDevice = null;
var ticker = null;

function el(id){ return document.getElementById(id); }
function toast(msg){
  var t = el('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 2200);
}
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'content-type':'application/json'}, opts.headers || {});
  opts.credentials = 'same-origin';
  return fetch(path, opts).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  });
}
function relTime(iso){
  if(!iso) return '—';
  var d = (Date.now() - Date.parse(iso)) / 1000;
  if(d < 0) return '刚刚';
  if(d < 60) return Math.floor(d) + ' 秒前';
  if(d < 3600) return Math.floor(d/60) + ' 分钟前';
  if(d < 86400) return Math.floor(d/3600) + ' 小时前';
  return Math.floor(d/86400) + ' 天前';
}
function statusText(s){
  if(s === 'class') return '上课中';
  if(s === 'break') return '课间';
  if(s === 'activity') return '活动';
  if(s === 'preparation') return '预备';
  if(s === 'free') return '空闲';
  return s || '未知';
}
function fmtCountdown(iso){
  if(!iso) return '—';
  var ms = Date.parse(iso) - Date.now();
  if(ms <= 0) return '已结束';
  var s = Math.floor(ms/1000);
  var m = Math.floor(s/60);
  var ss = s % 60;
  if(m >= 60) return Math.floor(m/60) + ' 小时 ' + (m%60) + ' 分';
  return m + ':' + String(ss).padStart(2,'0');
}

function boot(){
  api('/api/admin/state').then(function(j){
    state = j;
    el('login').style.display = 'none';
    el('main').style.display = 'block';
    el('hdr-actions').innerHTML = '<button id="logoutBtn">退出</button>';
    el('logoutBtn').onclick = function(){
      api('/api/admin/logout', {method:'POST'}).then(function(){ location.reload(); });
    };
    render();
  }).catch(function(){
    el('login').style.display = 'block';
    el('main').style.display = 'none';
    el('hdr-actions').innerHTML = '';
  });
}

function render(){
  if(!state) return;
  var box = el('devices');
  if(!state.devices.length){
    box.innerHTML = '<div class="card" style="grid-column:1/-1">' +
      '<b>还没有绑定设备</b>' +
      '<div class="muted" style="margin-top:6px">点下面的「生成配对码」，然后在 Class Widgets 的插件设置里填服务器地址和配对码。</div>' +
      '</div>';
  } else {
    box.innerHTML = '';
    state.devices.forEach(function(d){ box.appendChild(deviceCard(d)); });
  }
  el('pollInput').value = state.settings.poll_interval || '120';

  var cmds = state.commands || [];
  if(!cmds.length){
    el('cmdList').innerHTML = '<div class="muted">暂无</div>';
  } else {
    var h = '<table><tr><th>类型</th><th>设备</th><th>状态</th><th>时间</th></tr>';
    cmds.forEach(function(c){
      var dev = (state.devices.find(function(x){ return x.id === c.device_id; }) || {}).name || c.device_id;
      h += '<tr><td class="mono">' + c.type + '</td><td>' + dev + '</td><td>' + c.status +
           '</td><td class="muted">' + relTime(c.created_at) + '</td></tr>';
    });
    el('cmdList').innerHTML = h + '</table>';
  }

  if(ticker) clearInterval(ticker);
  ticker = setInterval(updateCountdowns, 1000);
  updateCountdowns();
}

function deviceCard(d){
  var card = document.createElement('div');
  card.className = 'card';

  var onlinePill = d.online
    ? '<span class="pill ok">在线</span>'
    : '<span class="pill">离线</span>';
  var revPill = (d.latest_revision > (d.schedule_rev||0))
    ? '<span class="pill warn">待应用 v' + d.latest_revision + '</span>'
    : '<span class="pill ok">课表已最新</span>';
  var modePill = d.data_mode === 'portable'
    ? '<span class="pill">便携版</span>'
    : '<span class="pill">用户目录</span>';

  card.innerHTML =
    '<div class="row">' +
      '<div style="font-weight:600;font-size:15px">' + escapeHtml(d.name) + '</div>' +
      onlinePill +
    '</div>' +
    '<div class="muted" style="margin-top:4px">' +
      '<span class="dot ' + (d.online?'on':'off') + '"></span>' +
      '最后心跳 ' + relTime(d.last_seen) +
    '</div>' +
    '<hr>' +
    '<div class="row">' +
      '<div><div class="muted">当前</div><div style="font-size:15px">' +
        escapeHtml(d.current_title || statusText(d.status)) + '</div></div>' +
      '<div style="text-align:right"><div class="muted">剩余</div>' +
        '<div class="big" data-end="' + (d.period_end||'') + '">' + fmtCountdown(d.period_end) + '</div></div>' +
    '</div>' +
    '<div class="muted" style="margin-top:6px">' +
      statusText(d.status) + (d.next_title ? ' · 下节 ' + escapeHtml(d.next_title) : '') +
    '</div>' +
    '<hr>' +
    '<div class="muted" style="line-height:1.9">' +
      '课表版本 v' + (d.schedule_rev||0) + ' ' + revPill + ' ' + modePill + '<br>' +
      '数据目录 <span class="mono">' + escapeHtml(d.data_dir || '—') + '</span>' +
      (d.last_error ? '<br><span style="color:var(--err)">' + escapeHtml(d.last_error) + '</span>' : '') +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button data-act="edit">编辑课表</button>' +
      '<button data-act="upload">拉取本机课表</button>' +
      '<button data-act="cmd">下发指令</button>' +
      '<button class="danger" data-act="del">解绑</button>' +
    '</div>';

  card.querySelector('[data-act="edit"]').onclick = function(){ openSchedule(d); };
  card.querySelector('[data-act="upload"]').onclick = function(){
    sendCommand(d.id, 'upload_schedule').then(function(){
      toast('已请求，等设备下次同步就会上传');
    }).catch(function(e){ toast(e.message); });
  };
  card.querySelector('[data-act="cmd"]').onclick = function(){ openCmd(d); };
  card.querySelector('[data-act="del"]').onclick = function(){
    if(!confirm('解绑「' + d.name + '」？该设备的课表记录也会删除。')) return;
    api('/api/admin/device/' + d.id, {method:'DELETE'}).then(refresh).catch(function(e){ toast(e.message); });
  };
  return card;
}

function updateCountdowns(){
  document.querySelectorAll('[data-end]').forEach(function(node){
    var v = node.getAttribute('data-end');
    if(v) node.textContent = fmtCountdown(v);
  });
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}

function refresh(){
  return api('/api/admin/state').then(function(j){ state = j; render(); });
}

function openSchedule(d){
  currentDevice = d;
  el('modalTitle').textContent = d.name + ' 的课表';
  el('modalSub').textContent = '当前已应用 v' + (d.schedule_rev||0);
  el('schedText').value = '加载中...';
  el('mask').classList.add('show');
  api('/api/admin/draft/' + d.id).then(function(j){
    if(j.payload){
      el('schedText').value = JSON.stringify(j.payload, null, 2);
      el('draftInfo').textContent = '草稿更新于 ' + relTime(j.updated_at);
    } else {
      el('schedText').value = '';
      el('draftInfo').textContent = '还没有草稿。点「拉取本机课表」可把设备当前的课表取上来。';
    }
  }).catch(function(e){ el('schedText').value = ''; toast(e.message); });
}

function parseSchedule(){
  var txt = el('schedText').value.trim();
  if(!txt) throw new Error('课表内容为空');
  var obj = JSON.parse(txt);
  if(!obj.meta || !Array.isArray(obj.subjects) || !Array.isArray(obj.days)){
    throw new Error('缺少 meta / subjects / days 字段');
  }
  return obj;
}

el('modalClose').onclick = function(){ el('mask').classList.remove('show'); };
el('btnFormat').onclick = function(){
  try {
    var obj = parseSchedule();
    el('schedText').value = JSON.stringify(obj, null, 2);
    var entries = obj.days.reduce(function(a, d){ return a + (d.entries||[]).length; }, 0);
    toast('格式正确：' + obj.subjects.length + ' 科目，' + obj.days.length + ' 天，' + entries + ' 条');
  } catch(e){ toast('格式错误：' + e.message); }
};
el('btnSaveDraft').onclick = function(){
  try {
    var obj = parseSchedule();
    api('/api/admin/draft/' + currentDevice.id, {method:'POST', body: JSON.stringify({payload: obj})})
      .then(function(){ toast('草稿已保存'); el('draftInfo').textContent = '草稿更新于 刚刚'; })
      .catch(function(e){ toast(e.message); });
  } catch(e){ toast('格式错误：' + e.message); }
};
el('btnPublish').onclick = function(){
  try {
    var obj = parseSchedule();
    if(!confirm('发布后，' + currentDevice.name + ' 下次同步就会收到新版本。继续？')) return;
    api('/api/admin/draft/' + currentDevice.id, {method:'POST', body: JSON.stringify({payload: obj})})
      .then(function(){ return api('/api/admin/publish/' + currentDevice.id, {method:'POST'}); })
      .then(function(j){ toast('已发布 v' + j.revision); el('mask').classList.remove('show'); refresh(); })
      .catch(function(e){ toast(e.message); });
  } catch(e){ toast('格式错误：' + e.message); }
};

function openCmd(d){
  currentDevice = d;
  el('cmdMask').classList.add('show');
  updateHint();
}
el('cmdClose').onclick = function(){ el('cmdMask').classList.remove('show'); };
el('cmdType').onchange = updateHint;
function updateHint(){
  var t = el('cmdType').value;
  var hints = {
    sync_now: '让设备立刻发一次同步请求。',
    upload_schedule: '让设备把当前课表传到后台草稿区，之后可以在这里改。',
    switch_portable: '在便携版和用户目录之间切换数据位置，然后重启程序。',
    restart_app: '直接重启 Class Widgets 2。'
  };
  el('cmdHint').textContent = hints[t] || '';
}
function sendCommand(deviceId, type, payload){
  return api('/api/admin/command', {
    method: 'POST',
    body: JSON.stringify({device_id: deviceId, type: type, payload: payload || {}})
  });
}
el('cmdSend').onclick = function(){
  sendCommand(currentDevice.id, el('cmdType').value)
    .then(function(){ toast('指令已排队，等设备下次同步'); el('cmdMask').classList.remove('show'); refresh(); })
    .catch(function(e){ toast(e.message); });
};

el('pairBtn').onclick = function(){
  api('/api/admin/pairing', {method:'POST', body: JSON.stringify({minutes:30})}).then(function(j){
    el('pairOut').innerHTML = '配对码：<span class="code">' + j.code + '</span>' +
      '<div style="margin-top:6px">30 分钟内有效，只能用一次。</div>';
  }).catch(function(e){ toast(e.message); });
};
el('savePoll').onclick = function(){
  api('/api/admin/settings', {method:'POST', body: JSON.stringify({poll_interval: el('pollInput').value})})
    .then(function(){ toast('已保存'); refresh(); })
    .catch(function(e){ toast(e.message); });
};
el('refreshBtn').onclick = function(){ refresh().then(function(){ toast('已刷新'); }); };
el('loginBtn').onclick = function(){
  api('/api/admin/login', {method:'POST', body: JSON.stringify({key: el('keyInput').value})})
    .then(function(){ boot(); })
    .catch(function(e){ toast(e.message); });
};
el('keyInput').addEventListener('keydown', function(e){ if(e.key === 'Enter') el('loginBtn').click(); });

boot();
</script>
</body>
</html>`;
