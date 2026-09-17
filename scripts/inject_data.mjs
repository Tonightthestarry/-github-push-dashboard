#!/usr/bin/env node
/* =====================================================================
 * 数据注入脚本：把 data.json 写进 index.html 的注入标记之间
 * 用法：node scripts/inject_data.mjs [--data data.json] [--html index.html] [--check]
 *   --check  只校验是否已同步，不写文件（CI 里可用作门禁）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const DATA_PATH = path.resolve(ROOT, arg('data', 'data.json'));
const HTML_PATH = path.resolve(ROOT, arg('html', 'index.html'));
const CHECK_ONLY = process.argv.includes('--check');

const START = '/* @dashboard-data:start */';
const END = '/* @dashboard-data:end */';

const raw = fs.readFileSync(DATA_PATH, 'utf8');
let data;
try { data = JSON.parse(raw); }
catch (e) { console.error(`[inject] data.json 不是合法 JSON：${e.message}`); process.exit(1); }

/* 防止 JSON 里出现 </script> 提前闭合脚本块 */
const json = JSON.stringify(data, null, 2).replace(/<\/(script)/gi, '<\\/$1');
const block = `${START}\nconst DASHBOARD_DATA = ${json};\n${END}`;

const html = fs.readFileSync(HTML_PATH, 'utf8');
const s = html.indexOf(START);
const e = html.indexOf(END);
if (s < 0 || e < 0 || e < s) {
  console.error('[inject] index.html 缺少注入标记 @dashboard-data:start / :end');
  process.exit(1);
}
const current = html.slice(s, e + END.length);
const next = html.slice(0, s) + block + html.slice(e + END.length);

if (CHECK_ONLY) {
  const same = current === block;
  console.log(same ? '[inject] ✅ index.html 与 data.json 已同步' : '[inject] ❌ index.html 与 data.json 不一致，需重新注入');
  process.exit(same ? 0 : 1);
}

if (current === block) {
  console.log('[inject] 内容一致，无需写入');
} else {
  fs.writeFileSync(HTML_PATH, next, 'utf8');
  const total = Array.isArray(data.sections) ? data.sections.reduce((n, x) => n + ((x.items || []).length), 0) : 0;
  console.log(`[inject] ✅ 已注入 ${total} 条 / ${(data.sections || []).length} 个版块 → ${path.basename(HTML_PATH)}`);
}
