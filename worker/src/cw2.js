// CW2 更新源（假 releases.json）
//
// Class Widgets 2 的更新检查逻辑（src/core/automations/update_check.py + workers.py）：
//   1. GET 配置项 network.releases_url（默认 https://classwidgets.rinlit.cn/2/releases.json）
//   2. 取 data[channel]，channel 对 dev 版是 'alpha'，正式版是 'release'
//   3. 比较 info.version 与当前版本：不相等 → 有更新；相等 → 已是最新
//   4. 有更新才用 info.url 里的地址去下载 zip
//
// 所以只要这里回显「和当前版本一模一样」的版本号，并且 url 留空，
// 检查结果永远是 UpToDate，也不存在可下载的地址 —— 更新被彻底拦住。
//
// 版本号通过 ?v= 传入（配置文件里写死当前版本，将来换版本只改配置，不用改代码）；
// 不传则用下面的默认值。

export const CW2_DEFAULT_VERSION = '2.0.0.dev20261014';

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._\-+]{0,39}$/;

export function releases(request) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get('v') || '').trim();
  const version = VERSION_RE.test(raw) ? raw : CW2_DEFAULT_VERSION;

  // release / alpha 两个通道都给同一份，省得以后切通道再改
  const info = { version, url: {} };
  const body = { release: { ...info }, alpha: { ...info } };

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
