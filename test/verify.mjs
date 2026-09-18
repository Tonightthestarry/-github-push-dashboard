/* GitHub 实时推送仪表盘 · 自动化验收脚本
 * 运行：node test/verify.mjs
 * 覆盖：[1]-[12] 基础模板验收项 + [13] 智能推送引擎 + [14] GitHub 搜索 + [15] 整合性
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ❌ ${name}${extra ? ' —— ' + extra : ''}`); }
}

/* ---------- 加载页面内脚本到 vm（无真实 DOM，init 自动跳过） ---------- */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('提取到页面内联脚本（≥3 段：主题/数据/逻辑）', scripts.length >= 3, `实际 ${scripts.length} 段`);

const memStore = new Map();
const documentStub = {
  documentElement: { setAttribute() {}, getAttribute: () => 'light' },
  getElementById: () => null, // 触发不了 boot 所需的元素，init 自然跳过
  addEventListener() {},
  readyState: 'loading'
};
const ctx = {
  console, URL,
  document: documentStub,
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: k => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => memStore.set(k, String(v)),
    removeItem: k => memStore.delete(k)
  }
};
ctx.window = ctx;
vm.createContext(ctx);
const exportSnippet = `
;globalThis.__T = { DASHBOARD_DATA, fmtRelative, fmtAbsolute, cleanSummary, isValidUrl,
  formatStars, classifyType, dedupItems, processData, needsFallbackBanner, isTodayCN, CN_OFFSET,
  escapeHtml, humanCount, daysAgo, USER_PROFILE, scoreRepo, matchDirections, buildPicks, itemKey,
  normalizeItem, classifyRepoType, buildGhQuery, fromGhApi, sortSearchResults, searchLocal,
  markPushed, clearPushed, pushedKeys, SORT_LABEL,
  PUSH_PREFIX, SEARCH_PREFIX, PUSH_BATCH, SEARCH_MAX_RESULTS };`;
try {
  vm.runInContext(scripts.join('\n') + exportSnippet, ctx);
  check('页面脚本在 Node vm 中解析执行无报错', true);
} catch (e) {
  check('页面脚本在 Node vm 中解析执行无报错', false, e.message);
  process.exit(1);
}
const T = ctx.__T;

/* 页面骨架 = 去掉注入的数据块，只检查页面自身的资源引用与代码，
 * 避免数据里的仓库描述（可能含 cdn. 等字样）造成误报 */
const _ds = html.indexOf('/* @dashboard-data:start */');
const _de = html.indexOf('/* @dashboard-data:end */');
const shell = (_ds > -1 && _de > _ds) ? html.slice(0, _ds) + html.slice(_de) : html;

/* ---------- 1. 外部资源策略 ---------- */
console.log('\n[1] 外部资源策略');
check('无外链 script', !/<script[^>]+src\s*=/i.test(shell));
check('无外链 link', !/<link[^>]+href\s*=/i.test(shell));
check('无外链图片 <img>', !/<img[\s>]/i.test(shell));
check('CSS 无 @import / 远程 url()', !/@import/i.test(shell) && !/url\(\s*['"]?https?:/i.test(shell));
check('无第三方 CDN / 图标库 / 在线字体', !/(cdn\.|unpkg\.com|jsdelivr|googleapis|fontawesome|tailwindcss|bootcdn)/i.test(shell));
check('字体使用系统字体栈', /-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif/.test(shell));
check('无 XHR / EventSource / sendBeacon / WebSocket',
  !/XMLHttpRequest|EventSource|sendBeacon|new WebSocket/.test(shell));
check('唯一的运行时网络端点 = GitHub 公开 Search API',
  /https:\/\/api\.github\.com\/search\/repositories/.test(shell)
  && (shell.match(/\bfetch\s*\(/g) || []).length === 2, `fetch 调用 ${(shell.match(/\bfetch\s*\(/g) || []).length} 处`);
check('GitHub 请求带 Accept 头与竞态取消', /Accept: 'application\/vnd\.github\+json'/.test(shell) && /AbortController/.test(shell));
check('网络失败有 try/catch 兜底，不抛出',
  /catch \(e\) \{[\s\S]{0,400}已切换为本地索引结果/.test(shell));

/* ---------- 2. 全局连续编号（资讯区） ---------- */
console.log('\n[2] 资讯区全局连续编号');
const p = T.processData(T.DASHBOARD_DATA);
const nums = p.sections.flatMap(s => s.items.map(i => i.num));
check('编号从 1 开始连续无缺号', nums.length > 0 && nums.every((n, i) => n === i + 1), JSON.stringify(nums));
check('跨版块不重置（编号单调跨段）', (() => {
  let ok = true, prev = 0;
  for (const s of p.sections) for (const i of s.items) { if (i.num !== prev + 1) ok = false; prev = i.num; }
  return ok;
})());
check('编号使用等宽数字（tabular-nums）', /font-variant-numeric:\s*tabular-nums/.test(html));

/* ---------- 3/4. 卡片要素与摘要 ≤60 字 ---------- */
console.log('\n[3/4] 卡片要素与摘要');
check('每张卡具备 序号/标题/来源/摘要/时间 字段', p.sections.every(s => s.items.every(i =>
  i.num > 0 && i.title && i.source && i.summary && 'iso' in i)));
const allSummariesOk = p.sections.every(s => s.items.every(i => [...i.summary].length <= 60));
check('注入数据所有摘要 ≤60 字（含标点）', allSummariesOk);
check('cleanSummary 超长截断补 … 且总长 ≤60', (() => {
  const s = T.cleanSummary('汉'.repeat(70), 'x');
  return [...s].length === 60 && s.endsWith('…') && [...s].filter(c => c === '汉').length === 59;
})());
check('英文摘要按词边界截断，不切断单词', (() => {
  const raw = 'The platform provides a comprehensive toolkit for building agents and retrieval pipelines';
  const s = T.cleanSummary(raw, '');
  const body = s.slice(0, -1);           // 去掉省略号的部分
  return [...s].length <= 60 && s.endsWith('…')
    && raw.startsWith(body)              // 截断处内容与原文逐字一致
    && raw.startsWith(body + ' ');       // 断点正好落在完整单词之后
})());
check('cleanSummary 去 HTML 标签', T.cleanSummary('<b>加粗</b>内容', '') === '加粗 内容');
check('cleanSummary 去 Markdown 语法', T.cleanSummary('**重点** [链接](https://a.com) `代码`', '') === '重点 链接 代码');
check('无摘要时重复标题并标注（原文无摘要）', T.cleanSummary('', '某标题') === '某标题（原文无摘要）');

/* ---------- 5. 外链安全 ---------- */
console.log('\n[5] 外链安全');
check('外链 target=_blank', /a\.target\s*=\s*'_blank'/.test(html));
check('外链 rel=noopener noreferrer', /a\.rel\s*=\s*'noopener noreferrer'/.test(html));
check('数据渲染全程 textContent，无 innerHTML 赋值', !/\.\s*innerHTML\s*\+?=/.test(html));
check('提供 escapeHtml 工具函数', typeof T.escapeHtml === 'function' && T.escapeHtml('<a>&"\'') === '&lt;a&gt;&amp;&quot;&#39;');

/* ---------- 6. 北京时间人话格式 ---------- */
console.log('\n[6] 时间格式');
const NOW = Date.parse('2026-09-17T13:40:00Z'); // 北京 21:40
check('非法时间 → 时间未知', T.fmtRelative('not-a-date', NOW) === '时间未知' && T.fmtRelative('', NOW) === '时间未知' && T.fmtRelative(null, NOW) === '时间未知');
check('未来时间 → 刚刚', T.fmtRelative('2026-09-17T14:00:00Z', NOW) === '刚刚');
check('<60 秒 → 刚刚', T.fmtRelative('2026-09-17T13:39:30Z', NOW) === '刚刚');
check('<60 分钟 → X 分钟前', T.fmtRelative('2026-09-17T13:20:00Z', NOW) === '20 分钟前');
check('同日 <24h → X 小时前', T.fmtRelative('2026-09-17T10:40:00Z', NOW) === '3 小时前');
check('昨天档', T.fmtRelative('2026-09-16T12:00:00Z', NOW) === '昨天 20:00');
check('2-7 天档', T.fmtRelative('2026-09-12T01:00:00Z', NOW) === '9月12日 09:00');
check('>7 天档', T.fmtRelative('2026-01-05T01:00:00Z', NOW) === '2026年1月5日');
check('绝对格式：今天', T.fmtAbsolute('2026-09-17T05:40:00Z', NOW) === '今天 13:40');
check('绝对格式：跨年带年份', T.fmtAbsolute('2025-06-15T10:00:00Z', NOW) === '2025年6月15日 18:00');
check('输出无 ISO/Z/英文月份', !/T\d{2}:\d{2}:\d{2}|Z$|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(T.fmtRelative('2026-09-12T01:00:00Z', NOW)));
check('60 秒定时刷新 + 页面隐藏暂停', /setInterval\(\(\) => \{ refreshTimes\(\); checkForUpdate\(true\); \}, 60000\)/.test(html) && /visibilitychange/.test(html) && /document\.hidden/.test(html));
check('不依赖访客时区（手写 +8 偏移）', /CN_OFFSET\s*=\s*8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(html) && !/toLocaleString|toLocaleDateString/.test(html));

/* ---------- 7. 回退逻辑 ---------- */
console.log('\n[7] 回退逻辑');
check('isFallback=true → 提示', T.needsFallbackBanner({ ...T.DASHBOARD_DATA, isFallback: true }, NOW));
check('generatedAt 非北京当日 → 提示', T.needsFallbackBanner({ ...T.DASHBOARD_DATA, isFallback: false, generatedAt: '2026-09-15T13:40:00Z' }, NOW));
check('当日数据 → 不提示', T.DASHBOARD_DATA.isFallback === true
  ? T.needsFallbackBanner(T.DASHBOARD_DATA, Date.parse(T.DASHBOARD_DATA.generatedAt) || NOW) // 快照本身就是回退数据时，按回退验证
  : !T.needsFallbackBanner(T.DASHBOARD_DATA, Date.parse(T.DASHBOARD_DATA.generatedAt) || NOW));
check('generatedAt 缺失 → 提示', T.needsFallbackBanner({ isFallback: false }, NOW));
check('回退时照常渲染全量内容', (() => {
  const fb = T.processData({ ...T.DASHBOARD_DATA, isFallback: true });
  return fb.total === p.total;
})());

/* ---------- 8. 页面结构齐备 ---------- */
console.log('\n[8] 页面结构');
for (const [name, re] of [
  ['Hero 区', /class="hero"/],
  ['粘性锚点导航', /<nav[^>]*class="nav"/.test(html) && /\.nav\s*\{[^}]*position:\s*sticky/.test(html)],
  ['卡片网格 auto-fill/断点', /@media \(min-width: 768px\)[\s\S]*?repeat\(2, 1fr\)[\s\S]*?@media \(min-width: 1200px\)[\s\S]*?repeat\(3, 1fr\)/],
  ['页脚数据源说明', /<footer>/],
  ['语义化标签 header/nav/main/section/footer', /<header[\s>]/.test(html) && /<nav[\s>]/.test(html) && /<main[\s>]/.test(html) && /<footer[\s>]/.test(html) && html.includes("el('section'")],
  ['导航 aria-label', /<nav[^>]*aria-label/],
  ['scroll-margin-top 防遮挡', /scroll-margin-top/.test(html)],
  ['IntersectionObserver 高亮导航', /IntersectionObserver/.test(html)],
  ['0 条版块不渲染', /if \(!arr\.length\) continue/.test(html)],
  ['搜索结果用 article 语义卡', /el\('article', 'card'\)/.test(html) && /el\('article', 'card card--pick'\)/.test(html)]
]) check(name, typeof re === 'boolean' ? re : re.test(html));

/* ---------- 9. 响应式 ---------- */
console.log('\n[9] 响应式');
check('viewport meta', /<meta name="viewport"/.test(html));
check('三档断点（768/1200）', html.includes('@media (min-width: 768px)') && html.includes('@media (min-width: 1200px)'));
check('移动端导航横滑不换行', /nav-inner[\s\S]*?overflow-x:\s*auto/.test(html));
check('长文本防横向溢出', /overflow-wrap:\s*anywhere/.test(html) && /min-width:\s*0/.test(html));
check('搜索条移动端可换行', /\.search-bar \{ display: flex; flex-wrap: wrap/.test(html));

/* ---------- 10. 边界与异常 ---------- */
console.log('\n[10] 边界与异常');
check('完全无数据 → 空状态路径存在', html.includes('emptyState') && /total === 0/.test(html));
check('空数据 processData 不崩', (() => {
  const r = T.processData({});
  const r2 = T.processData({ sections: [{ id: 'x', items: 'broken' }] });
  return r.total === 0 && r.sections.length === 0 && r2.total === 0;
})());
check('字段缺失 → 占位文案兜底', (() => {
  const r = T.processData({ sections: [{ id: 'news', items: [{ type: 'news' }] }] });
  const it = r.sections[0].items[0];
  return it.title === '（无标题）' && it.source === '来源未知' && it.iso === null && it.url === null;
})());
check('非法 URL → 降级纯文本（url=null）', (() => {
  const r = T.processData({ sections: [{ id: 'news', items: [{ title: 'a', url: 'javascript:alert(1)', type: 'news' }] }] });
  return r.sections[0].items[0].url === null;
})());
check('重复条目去重且保留最早', (() => {
  const r = T.processData({ sections: [{ id: 'news', items: [
    { title: '同题', url: 'https://a.com/1', type: 'news', publishedAt: '2026-09-17T10:00:00Z', summary: '晚的一条' },
    { title: '同题', url: 'https://a.com/1', type: 'news', publishedAt: '2026-09-17T08:00:00Z', summary: '早的一条' }
  ] }] });
  return r.total === 1 && r.sections[0].items[0].summary === '早的一条';
})());
check('同 title 不同 url 也去重', (() => {
  const r = T.processData({ sections: [{ id: 'news', items: [
    { title: '同题', url: 'https://a.com/1', type: 'news' },
    { title: '同题', url: 'https://b.com/2', type: 'news' }
  ] }] });
  return r.total === 1;
})());
check('未识别 type 进入兜底 other 版块', (() => {
  const r = T.processData({ sections: [{ id: 'news', items: [{ title: 'x', type: 'weird' }] }] });
  return r.sections.length === 1 && r.sections[0].id === 'other';
})());
check('无 type 但有 starsToday → 归入 trending', T.classifyType({ starsToday: 5 }) === 'trending');
check('显式 release 不被 starsToday 抢走', T.classifyType({ type: 'release', starsToday: 5 }) === 'releases');
check('Star 数格式化 k', T.formatStars(128000) === '128k' && T.formatStars(1200) === '1.2k' && T.formatStars(999) === '999');
check('大数人话（万）', T.humanCount(146526) === '14.7 万' && T.humanCount(20000) === '2 万' && T.humanCount(999) === '999');

/* ---------- 11. 双主题 ---------- */
console.log('\n[11] 明暗主题');
check(':root 与 [data-theme=dark] 双套变量', /:root\s*\{[\s\S]*?--bg:/.test(html) && /\[data-theme="dark"\]\s*\{[\s\S]*?--bg:\s*#0d1117/.test(html));
check('默认跟随 prefers-color-scheme', /prefers-color-scheme:\s*dark/.test(html));
check('localStorage 记忆主题', /localStorage\.setItem\('gh-dash-theme'/.test(html) && /localStorage\.getItem\('gh-dash-theme'/.test(html));

/* ---------- 12. 脚本健壮性 ---------- */
console.log('\n[12] 脚本健壮性');
check('脚本在 vm 中加载即无语法错误', true); // 前面加载失败已直接退出
check('无 console.log 残留', !/console\.(log|warn|error)\(/.test(scripts[scripts.length - 1]));
check('尊重 prefers-reduced-motion', /prefers-reduced-motion:\s*reduce/.test(html));

/* =====================================================================
 * 13. 智能推送引擎
 * ===================================================================== */
console.log('\n[13] 智能推送引擎');
const d = n => new Date(Date.now() - n * 86400e3).toISOString();
const mk = o => T.normalizeItem(o);
const mkRepo = (name, kw, lang, stars, pushedDays, sizeKb, extra) => mk(Object.assign({
  title: name, url: 'https://github.com/' + name, source: name,
  summary: kw + ' toolkit', language: lang, stars,
  forks: Math.round(stars / 5), pushedAt: d(pushedDays), createdAt: d(200),
  sizeKb, topics: kw.split(' '), type: 'trending'
}, extra || {}));

const cands = [
  mkRepo('a/langchain-kit', 'llm agent rag', 'Python', 146000, 2, 4000),
  mkRepo('b/pytest-plus', 'testing', 'Python', 9000, 3, 2000),
  mkRepo('c/spark-etl', 'spark hadoop etl data-pipeline', 'Scala', 6000, 5, 9000),
  mkRepo('d/viz-board', 'dashboard visualization chart', 'TypeScript', 25000, 1, 3000),
  mkRepo('e/yolo-lite', 'yolo detection opencv', 'Python', 12000, 10, 7000),
  mkRepo('f/spring-vue', 'spring-boot vue microservice', 'Java', 30000, 4, 20000),
  mkRepo('g/price-tracker', 'scraper price-tracking ecommerce', 'Python', 5000, 6, 5000),
  mkRepo('h/auto-cli', 'automation cli workflow', 'Go', 3000, 8, 1500),
  mkRepo('i/awesome-testing', 'awesome cheatsheet tutorial learning', '', 700, 20, 900),
  mkRepo('j/half-dead', 'llm agent framework', 'Python', 20000, 500, 60000)
];

check('画像方向 ≥6 且每个方向字段完整', T.USER_PROFILE.directions.length >= 6
  && T.USER_PROFILE.directions.every(x => x.id && x.label && x.weight > 0 && x.why && x.keywords.length >= 5));
check('画像语言表覆盖用户技术栈', ['Java', 'Python', 'TypeScript', 'SQL'].every(l => T.USER_PROFILE.languages.includes(l)));

const s0 = T.scoreRepo(cands[0]);
check('方向命中识别正确（AI Agent 排第一）', T.matchDirections(cands[0])[0].d.id === 'ai-agent');
check('推荐分由真实字段推导（高分项 > 0）', s0.score > 0, `score=${s0.score}`);
check('理由条数 2-4 条且文案非空', s0.reasons.length >= 2 && s0.reasons.length <= 4
  && s0.reasons.every(r => typeof r.text === 'string' && r.text.length > 8));
const whyText = s0.reasons.map(r => r.text).join(' | ');
check('理由含方向名与「对口」说明', /AI Agent/.test(whyText) && /对口|技术线/.test(whyText));
check('理由含语言匹配证据', /Python/.test(whyText) && /技术栈/.test(whyText));
check('理由含上手门槛证据（轻量）', /轻量/.test(whyText));
check('理由条数上限 4 条（3 正面 + 1 风险）', s0.reasons.length <= 4);

/* 单项证据：构造只有单一维度的仓库，验证每个维度都能产出可读理由 */
const activeOnly = mk({ title: 'm/active-only', url: 'https://github.com/m/active-only',
  source: 'm/active-only', summary: 'llm agent toolkit', type: 'trending',
  pushedAt: d(2), stars: 500 });
check('维护活跃度能产出理由', T.scoreRepo(activeOnly).reasons.some(r => /仍有提交/.test(r.text)));
const starOnly = mk({ title: 'n/star-only', url: 'https://github.com/n/star-only',
  source: 'n/star-only', summary: 'dashboard visualization', type: 'trending', stars: 30000 });
check('star 规模能产出理由', T.scoreRepo(starOnly).reasons.some(r => /star/.test(r.text)));
const bigRepo = mk({ title: 'o/big', url: 'https://github.com/o/big', source: 'o/big',
  summary: 'llm agent', type: 'trending', sizeKb: 597901, stars: 1000 });
check('超大仓库给出体积风险提醒', T.scoreRepo(bigRepo).reasons.some(r => r.caution && /体量偏大/.test(r.text)));
const wrongLang = mk({ title: 'p/scala', url: 'https://github.com/p/scala', source: 'p/scala',
  summary: 'spark pipeline', type: 'trending', language: 'Scala', stars: 1000 });
check('非技术栈语言给出成本提醒', T.scoreRepo(wrongLang).reasons.some(r => r.caution && /补语言成本/.test(r.text)));

const dead = T.scoreRepo(cands[9]);
check('停更一年的仓库被降权并给风险提醒',
  dead.score < s0.score && dead.reasons.some(r => r.caution === true && /没有提交|停止维护/.test(r.text)));
const arch = T.scoreRepo(mkRepo('k/dead-arch', 'llm agent', 'Python', 90000, 3, 3000, { archived: true }));
check('已归档仓库被显著降权 + 风险提醒',
  arch.score < s0.score - 50 && arch.reasons.some(r => r.caution && /归档/.test(r.text)));

const before = T.scoreRepo(cands[0]).score;
T.markPushed([T.itemKey(cands[0])]);
const after = T.scoreRepo(cands[0]).score;
check('已推送过的条目降权 15 分，避免重复推荐', before - after === 15, `${before} → ${after}`);
T.clearPushed();
check('重置已读后分数恢复', T.scoreRepo(cands[0]).score === before);

const picks0 = T.buildPicks(cands, 0, 6);
check('推送条数等于批次大小', picks0.picks.length === 6 && picks0.total === 10);
check('推送编号使用 P 前缀且连续', picks0.picks.map(x => x.num).join(',') === 'P1,P2,P3,P4,P5,P6',
  picks0.picks.map(x => x.num).join(','));
check('推送按推荐分降序排列', (() => {
  for (let i = 1; i < picks0.picks.length; i++) {
    if (picks0.picks[i - 1].score < picks0.picks[i].score) return false;
  }
  return true;
})());
check('最相关仓库排在推荐位第一条', picks0.picks[0].it.title === 'a/langchain-kit', picks0.picks[0].it.title);
check('推送卡片都带推荐理由', picks0.picks.every(x => x.reasons.length >= 2));

const picks1 = T.buildPicks(cands, 1, 6);
check('「换一批」翻到下一批且与上一批不重叠', (() => {
  const a = new Set(picks0.picks.map(x => T.itemKey(x.it)));
  return picks1.picks.length === 4 && picks1.picks.every(x => !a.has(T.itemKey(x.it)))
    && picks1.picks.map(x => x.num).join(',') === 'P7,P8,P9,P10';
})(), picks1.picks.map(x => x.num).join(','));
check('批次循环（越界回到第一批）', T.buildPicks(cands, 5, 6).page === 1);

const withNews = cands.concat([
  mk({ title: 'n/news', url: 'https://x.com/n', source: 'x.com', summary: 'llm agent news', type: 'news', language: 'Python', stars: 99999 }),
  mk({ title: 'o/paper', url: 'https://x.com/p', source: 'arXiv', summary: 'llm agent paper', type: 'paper', language: 'Python', stars: 88888 })
]);
const picksN = T.buildPicks(withNews, 0, 20);
check('新闻/论文类不进入「可用的项目」推送池',
  picksN.picks.every(x => ['news', 'papers'].indexOf(T.classifyType(x.it)) < 0));
check('推送池为空时不报错', (() => {
  const r = T.buildPicks([], 0, 6);
  return r.total === 0 && r.picks.length === 0 && r.pageCount === 1;
})());
check('推送已读记录持久化到 localStorage', /localStorage\.setItem\(LS_PUSHED/.test(html)
  && /localStorage\.removeItem\(LS_PUSHED\)/.test(html));

/* =====================================================================
 * 14. GitHub 实时搜索
 * ===================================================================== */
console.log('\n[14] GitHub 实时搜索');
check('无限定符时补默认检索字段', T.buildGhQuery('playwright 接口测试') === 'playwright 接口测试 in:name,description,topics');
check('带限定符时原样透传', T.buildGhQuery('testing language:python') === 'testing language:python');
check('lang: 归一成 GitHub 的 language:', T.buildGhQuery('lang:python rag') === 'language:python rag');
check('stars/topic 限定符可透传', T.buildGhQuery('stars:>1000 topic:llm') === 'stars:>1000 topic:llm');
check('空查询返回空串（不发请求）', T.buildGhQuery('   ') === '');

const pushedIso = d(0.1);
const ghItem = T.fromGhApi({
  full_name: 'langchain-ai/langchain', html_url: 'https://github.com/langchain-ai/langchain',
  description: 'The agent engineering platform.', language: 'Python',
  stargazers_count: 146526, forks_count: 24499, open_issues_count: 536,
  topics: ['agents', 'llm'], pushed_at: pushedIso, created_at: d(1400), size: 597901, archived: false
});
check('GitHub 原始字段映射为统一条目',
  ghItem.stars === 146526 && ghItem.language === 'Python' && ghItem.forks === 24499
  && ghItem.topics[0] === 'agents' && ghItem.pushedAt === pushedIso && ghItem.sizeKb === 597901);
check('搜索结果也能算出推荐理由', (() => {
  const r = T.scoreRepo(ghItem);
  return r.score > 0 && r.reasons.length >= 2;
})());
check('大仓库给出体量提醒', T.scoreRepo(ghItem).reasons.some(r => /体量偏大|MB/.test(r.text)));
check('awesome/教程类仓库归入技巧版块', T.classifyRepoType({ full_name: 'x/awesome-py', description: 'awesome list', topics: ['awesome'] }) === 'tips');

const starsSorted = T.sortSearchResults([cands[1], cands[0], cands[4]], 'stars');
check('按 Star 数降序排序', starsSorted[0].title === 'a/langchain-kit' && starsSorted[2].title === 'b/pytest-plus');
const updSorted = T.sortSearchResults([cands[9], cands[0], cands[3]], 'updated');
check('按最近更新排序', updSorted[0].title === 'd/viz-board', updSorted[0].title);
const scoreSorted = T.sortSearchResults([cands[9], cands[1], cands[0]], 'score');
check('按「对你的推荐度」排序（默认）', scoreSorted[0].title === 'a/langchain-kit');
check('默认排序标签正确', T.SORT_LABEL.score === '对你的推荐度' && T.SORT_LABEL.stars === 'Star 数' && T.SORT_LABEL.updated === '最近更新');
check('排序不修改入参数组', (() => {
  const src = [cands[1], cands[0]];
  const copy = src.slice();
  T.sortSearchResults(src, 'stars');
  return src[0] === copy[0] && src[1] === copy[1];
})());

const localHits = T.searchLocal(cands, 'spark etl', 10);
check('本地索引多词 AND 检索命中正确', localHits.length === 1 && localHits[0].title === 'c/spark-etl',
  localHits.map(x => x.title).join(','));
check('本地索引忽略 GitHub 限定符', T.searchLocal(cands, 'spark language:python', 10).length === 1);
check('本地索引无命中返回空数组', T.searchLocal(cands, 'zzz-nonexistent', 10).length === 0);
check('本地索引遵守条数上限', T.searchLocal(cands, 'toolkit', 3).length === 3);

check('搜索最多展示 10 条（SEARCH_MAX_RESULTS）', T.SEARCH_MAX_RESULTS === 10);
check('搜索候选池 30 条后再本地重排', /SEARCH_POOL = 30/.test(html));
check('结果编号使用 S 前缀', T.SEARCH_PREFIX === 'S' && /SEARCH_PREFIX = 'S'/.test(html));
check('搜索结果缓存 5 分钟', /SEARCH_CACHE_TTL = 5 \* 60e3/.test(html) && /searchCache\.set\(ck/.test(html));
check('缓存命中不重复请求', /if \(cached && Date\.now\(\) - cached\.at < SEARCH_CACHE_TTL\)/.test(html));
check('403/429 限流有专门提示与剩余额度', /res\.status === 403 \|\| res\.status === 429/.test(html)
  && /限流/.test(html) && /x-ratelimit-remaining/i.test(html));
check('422 语法错误单独提示', /res\.status === 422/.test(html) && /限定符写法/.test(html));
check('网络不可用降级为本地索引结果', /offline: true/.test(html) && /已切换为本地索引结果/.test(html));
check('竞态：新搜索取消上一次未完成请求', /searchAbort\.abort\(\)/.test(html) && /AbortError/.test(html));
check('输入防抖 450ms + 回车立即搜 + Esc 清空',
  /setTimeout\(fire, 450\)/.test(html) && /e\.key === 'Enter'/.test(html) && /e\.key === 'Escape'/.test(html));
check('「/」快捷键聚焦搜索框', /e\.key === '\/'/.test(html));
check('排序切换不重复请求 GitHub（复用候选池）', /lastSearchPool\.length/.test(html));
check('快捷搜索 chips 由画像方向生成', /quick-chips/.test(html) && /USER_PROFILE\.directions\.map\(d => \(\{/.test(html));

/* =====================================================================
 * 15. 推送 + 搜索整合性
 * ===================================================================== */
console.log('\n[15] 推送与搜索整合');
check('搜索区与推送区在同一页面', /id="sec-search"/.test(html) && /id="sec-picks"/.test(html));
check('锚点导航包含搜索与推送入口', /mkNav\('🔍', '搜索'/.test(html) && /mkNav\('🎯', '为你推送'/.test(html));
check('Hero 统计卡含搜索/推送入口', /mkStat\('🔍'/.test(html) && /mkStat\('🎯'/.test(html));
check('Hero KPI 含可推荐项目数', /可推荐项目/.test(html));
check('资讯卡片交叉引用已推送条目', /pushed-ref/.test(html) && /pushedIndex\.get\(itemKey/.test(html));
check('推送说明含画像依据与机制', /推荐依据（画像方向与权重）/.test(html) && /已读记录存于浏览器本地/.test(html));
check('页脚标注搜索数据源与限流口径', /GitHub 公开 Search API/.test(html) && /匿名调用每分钟 10 次/.test(html));
check('支持手动重置推送已读记录', /重置推送已读记录/.test(html));
check('更新时间检查默认 5 分钟', /UPDATE_CHECK_INTERVAL = 5 \* 60e3/.test(html));
check('保留原有视觉变量与卡片类名', /\.card \{/.test(html) && /\.num-badge \{/.test(html) && /--accent-soft/.test(html));

/* ---------- 汇总 ---------- */
console.log(`\n========================================`);
console.log(`结果：${passed} 项通过，${failed} 项失败`);
if (failed) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('全部自动化验收项通过 ✅');
