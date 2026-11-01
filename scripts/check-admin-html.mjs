// 校验 worker/src/adminHtml.js 里内联 <script> 的真实语法。
//
// 为什么需要单独校验：ADMIN_HTML 是模板字符串，源码里写的转义在求值时会再解析一层。
// 直接对源文件跑 node --check 看不出问题，必须对「求值后的字符串」做检查。
// 曾经因为 \\n 被模板字符串吃掉一层，变成单引号字符串里的真实换行，
// 导致整页脚本 SyntaxError、页面只剩标题。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ADMIN_HTML } from '../worker/src/adminHtml.js';

const match = ADMIN_HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error('✗ 没在 ADMIN_HTML 里找到 <script> 块');
  process.exit(1);
}

const script = match[1];

// 写成临时文件再交给 node --check，这样报错能带到具体行
const tmp = path.join(os.tmpdir(), `classsync-admin-${process.pid}.js`);
fs.writeFileSync(tmp, script, 'utf8');
const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });

if (result.status !== 0) {
  console.error('✗ 后台内联脚本存在语法错误（源文件里的转义在模板字符串求值时会再解析一层）：');
  const output = (result.stderr || '').split('\n').filter((line) => !line.includes('at '));
  console.error(output.slice(0, 8).join('\n'));
  fs.unlinkSync(tmp);
  process.exit(1);
}

fs.unlinkSync(tmp);

console.log(`✓ 后台内联脚本语法正常（${script.split('\n').length} 行）`);
