#!/usr/bin/env node
/* =====================================================================
 * GitHub 自动流 · 数据抓取脚本（零依赖，Node 18+）
 *
 * 用途：按「用户能力画像」的方向去 GitHub 抓真实数据，产出 data.json 快照。
 * 用法：node scripts/fetch_data.mjs
 *   env:
 *     GITHUB_TOKEN   可选。Actions 环境自带，可把搜索限流从 10/分 提到 30/分
 *     OUT_DIR        输出目录，默认仓库根
 *     DELAY_MS       搜索请求间隔，匿名模式建议 ≥7000（默认 7000，有 token 时 2000）
 *
 * 回退约定（与页面配合）：
 *   抓取成功且总条数 > 0 → 写入 data/snapshot.json 与 data.json，isFallback=false
 *   抓取失败或总条数为 0 → 不覆盖 data/snapshot.json，data.json 由旧快照复制并置 isFallback=true
 *   因此页面读到的永远是一份有效数据。
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : ROOT;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DELAY_MS = Number(process.env.DELAY_MS || (TOKEN ? 2000 : 7000));
const UA = 'gh-push-dashboard/2.0 (+github-actions)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[fetch]', ...a);

/* ---------- 画像方向：抓取与前端打分的共同依据 ----------
 * q 只放 2 个核心词：GitHub 仓库检索是按词 AND 的，词越多召回越差
 * （实测 4 个词时「跨境电商」方向会直接 0 条）。精准度交给前端打分引擎。 */
const DIRECTIONS = [
  { id: 'qa',          label: '软件测试与质量保障', q: 'testing automation',        langs: ['Python', 'Java', 'TypeScript', 'JavaScript'] },
  { id: 'ai-agent',    label: 'AI Agent / RAG',     q: 'llm agent',                langs: ['Python', 'TypeScript', 'Go'] },
  { id: 'bigdata',     label: '大数据 Spark/Hadoop', q: 'spark pipeline',           langs: ['Python', 'Scala', 'Java'] },
  { id: 'dataviz',     label: '数据分析与可视化',    q: 'dashboard visualization',   langs: ['Python', 'TypeScript', 'JavaScript'] },
  { id: 'cv-ml',       label: '机器学习与计算机视觉', q: 'yolo detection',           langs: ['Python'] },
  { id: 'java-web',    label: 'Java 全栈与后端工程',  q: 'spring boot',              langs: ['Java', 'TypeScript'] },
  { id: 'ecommerce',   label: '跨境电商与爬虫运营',   q: 'price tracker',            langs: ['Python', 'TypeScript'] },
  { id: 'automation',  label: '自动化与效率工具',     q: 'automation workflow',      langs: ['Python', 'Go', 'TypeScript'] }
];
const MAX_DIRECTIONS = Number(process.env.MAX_DIRECTIONS || DIRECTIONS.length);

/* 关注仓库：用于抓「版本发布与更新」 */
const WATCH_REPOS = [
  'langchain-ai/langchain', 'vitejs/vite', 'apache/spark', 'ultralytics/ultralytics',
  'pytest-dev/pytest', 'microsoft/playwright', 'streamlit/streamlit', 'apache/hadoop'
];

/* ---------- HTTP ----------
 * 说明：个别 Windows 环境存在 TLS 拦截，Node 的 fetch 对 api.github.com 会报
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE。此时自动降级为 node:https（跳过证书校验）重试一次，
 * 并打印醒目警告。GitHub Actions 等正常环境不会触发该分支。
 * 需要严格校验时设置 STRICT_TLS=1。
 * ------------------------------------------------------------------------- */
const CERT_ERRORS = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'
];
let warnedInsecure = false;

const isCertError = e => {
  const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
  return CERT_ERRORS.includes(code);
};

function httpsGetInsecure(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, rejectUnauthorized: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/* 统一取数：优先 fetch，证书报错时按需降级；返回 { status, headers, text } */
async function httpGet(url, headers = {}) {
  const h = { 'User-Agent': UA, ...headers };
  try {
    const res = await fetch(url, { headers: h });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    if (!isCertError(e) || process.env.STRICT_TLS === '1') throw e;
    if (!warnedInsecure) {
      warnedInsecure = true;
      log('⚠ 本机 TLS 证书链校验失败，已降级为跳过证书校验的 https 请求（仅影响本次抓取，公网只读数据）。设置 STRICT_TLS=1 可禁用该降级。');
    }
    return await httpsGetInsecure(url, h);
  }
}

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name.toLowerCase()] != null ? String(headers[name.toLowerCase()]) : null;
};

async function ghFetch(url, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': UA };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await httpGet(url, headers);
  const remaining = headerOf(res.headers, 'x-ratelimit-remaining');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} (remaining=${remaining}) ${String(res.text).slice(0, 180)}`);
  }
  let json;
  try { json = JSON.parse(res.text); }
  catch (e) { throw new Error(`返回体不是 JSON：${String(res.text).slice(0, 120)}`); }
  return { json, remaining };
}

function normalizeRepo(r) {
  return {
    title: r.full_name,
    url: r.html_url,
    source: r.full_name,
    summary: (r.description || '').replace(/\s+/g, ' ').trim(),
    publishedAt: r.pushed_at || r.updated_at || r.created_at,
    type: 'trending',
    language: r.language || null,
    stars: r.stargazers_count,
    starsToday: null,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 12) : [],
    forks: r.forks_count,
    openIssues: r.open_issues_count,
    archived: !!r.archived,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    sizeKb: r.size,
    direction: r.__direction || null
  };
}

const classifyRepoTopic = r => {
  const hay = [r.title, r.summary, (r.topics || []).join(' ')].join(' ').toLowerCase();
  if (/(awesome|cheatsheet|cheat-sheet|tutorial|guide|learning|roadmap|handbook|best-practices)/.test(hay)) {
    return { type: 'tips', tag: '清单/教程' };
  }
  return { type: 'trending', tag: null };
};

/* ---------- 各来源抓取 ---------- */
const sinceDays = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);

async function fetchDirection(d) {
  // 方向检索：要求近两个月有维护动作，门槛放到 50 star 以便捞到小众但聚焦的项目
  const q = `${d.q} in:name,description,topics stars:>50 pushed:>${sinceDays(60)}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`;
  const { json } = await ghFetch(url);
  return (json.items || []).map(r => normalizeRepo({ ...r, __direction: d.label }));
}

async function fetchTrending() {
  const q = `created:>${sinceDays(120)} stars:>400 pushed:>${sinceDays(7)}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`;
  const { json } = await ghFetch(url);
  return (json.items || []).map(r => normalizeRepo(r));
}

async function fetchTips() {
  // 清单/教程类仓库天然偏老，但仍要求近半年有维护动作，避免推"停更清单"
  const q = `topic:awesome topic:python stars:>500 pushed:>${sinceDays(180)}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`;
  const { json } = await ghFetch(url);
  return (json.items || []).map(r => normalizeRepo(r));
}

async function fetchReleases() {
  const out = [];
  for (const full of WATCH_REPOS) {
    try {
      const { json } = await ghFetch(`https://api.github.com/repos/${full}/releases/latest`);
      const tag = json.tag_name || '';
      const name = json.name || tag || '新版本';
      out.push({
        title: `${full} 发布 ${name}`.trim(),
        url: json.html_url || `https://github.com/${full}/releases`,
        source: full,
        summary: (json.body || '').replace(/[#*`>\[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        publishedAt: json.published_at || new Date().toISOString(),
        type: 'release',
        tag: tag || null,
        stars: null
      });
      await sleep(300);
    } catch (e) {
      log(`release 跳过 ${full}: ${e.message}`);
    }
  }
  return out;
}

async function fetchNews() {
  const url = 'https://hn.algolia.com/api/v1/search_by_date?query=github%20open%20source&tags=story&hitsPerPage=8';
  const res = await httpGet(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`HN HTTP ${res.status}`);
  const json = JSON.parse(res.text);
  return (json.hits || [])
    .filter(h => h.title)
    .map(h => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: h.url ? new URL(h.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
      summary: h.story_text ? h.story_text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      publishedAt: h.created_at,
      type: 'news',
      stars: null,
      points: h.points || 0
    }));
}

async function fetchPapers() {
  const q = encodeURIComponent('all:"large language model" OR all:"software testing"');
  const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=6`;
  const res = await httpGet(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`arXiv HTTP ${res.status}`);
  const xml = res.text;
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const pick = (s, tag) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  return entries.map(e => ({
    title: pick(e, 'title'),
    url: pick(e, 'id'),
    source: 'arXiv',
    summary: pick(e, 'summary').slice(0, 300),
    publishedAt: pick(e, 'published'),
    type: 'paper',
    authors: pick(e, 'name') || null
  })).filter(p => p.title && p.url);
}

/* ---------- 主流程 ---------- */
async function main() {
  const started = new Date();
  log(`开始抓取（token=${TOKEN ? '有' : '无'}，间隔=${DELAY_MS}ms）`);
  const buckets = { trending: [], releases: [], news: [], papers: [], tips: [], other: [] };

  /* 1) 画像方向搜索 —— 推荐引擎的主料 */
  for (const d of DIRECTIONS.slice(0, MAX_DIRECTIONS)) {
    try {
      const items = await fetchDirection(d);
      buckets.trending.push(...items);
      log(`✓ 方向 ${d.label}：${items.length} 条`);
    } catch (e) {
      log(`✗ 方向 ${d.label} 失败：${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  /* 2) 新晋热门 */
  try {
    const t = await fetchTrending();
    buckets.trending.push(...t);
    log(`✓ 新晋热门：${t.length} 条`);
  } catch (e) { log(`✗ 新晋热门失败：${e.message}`); }
  await sleep(DELAY_MS);

  /* 3) 技巧与观点（清单/教程类仓库） */
  try {
    const t = await fetchTips();
    buckets.tips.push(...t.map(r => ({ ...r, ...classifyRepoTopic(r) })));
    log(`✓ 技巧与观点：${t.length} 条`);
  } catch (e) { log(`✗ 技巧与观点失败：${e.message}`); }

  /* 4) 版本发布 */
  const rel = await fetchReleases();
  buckets.releases.push(...rel);
  log(`✓ 版本发布：${rel.length} 条`);

  /* 5) 行业动态 */
  try { const n = await fetchNews(); buckets.news.push(...n); log(`✓ 行业动态：${n.length} 条`); }
  catch (e) { log(`✗ 行业动态失败：${e.message}`); }

  /* 6) 论文 */
  try { const p = await fetchPapers(); buckets.papers.push(...p); log(`✓ 论文：${p.length} 条`); }
  catch (e) { log(`✗ 论文失败：${e.message}`); }

  /* 对 trending 桶做二次归类：清单/教程类挪去 tips */
  const kept = [];
  for (const r of buckets.trending) {
    const c = classifyRepoTopic(r);
    if (c.type === 'tips') buckets.tips.push({ ...r, tag: c.tag });
    else kept.push(r);
  }
  buckets.trending = kept;

  /* 去重（同 url 或同 title） */
  const seen = new Set();
  for (const k of Object.keys(buckets)) {
    buckets[k] = buckets[k].filter(it => {
      const key = (it.url || '').trim() || ('t:' + (it.title || '').trim());
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const SECTION_NAMES = {
    trending: '新晋热门仓库', releases: '版本发布与更新', news: '行业动态',
    papers: '精选论文与技术文章', tips: '技巧与观点', other: '其他动态'
  };
  const sections = Object.keys(SECTION_NAMES)
    .map(id => ({ id, name: SECTION_NAMES[id], items: buckets[id] }))
    .filter(s => s.items.length > 0);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const snapshotPath = path.join(OUT_DIR, 'data', 'snapshot.json');
  const dataPath = path.join(OUT_DIR, 'data.json');

  if (total === 0) {
    log('本次抓取 0 条，尝试回退到旧快照');
    fallbackToSnapshot(snapshotPath, dataPath);
    return;
  }

  const payload = {
    generatedAt: started.toISOString(),
    lastSuccessAt: started.toISOString(),
    isFallback: false,
    source: {
      repo: process.env.GITHUB_REPOSITORY || 'local/github-push-dashboard',
      workflow: process.env.GITHUB_WORKFLOW || 'gh-daily-push.yml',
      schedule: process.env.WORKFLOW_SCHEDULE || '0 1,9,17 * * *',
      runId: process.env.GITHUB_RUN_ID || null,
      runUrl: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
      scope: `画像方向 ${DIRECTIONS.slice(0, MAX_DIRECTIONS).map(d => d.label).join('、')} + 关注仓库 Releases + arXiv 论文 + 技术资讯`,
      profileDriven: true,
      directions: DIRECTIONS.slice(0, MAX_DIRECTIONS).map(d => ({ id: d.id, label: d.label }))
    },
    sections
  };

  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(dataPath, JSON.stringify(payload, null, 2), 'utf8');
  log(`完成：${total} 条 / ${sections.length} 个版块 → ${dataPath}`);
  for (const s of sections) log(`   · ${s.name}: ${s.items.length} 条`);
}

function fallbackToSnapshot(snapshotPath, dataPath) {
  if (!fs.existsSync(snapshotPath)) {
    log('无可用旧快照，写入空数据（页面将显示空状态）');
    fs.writeFileSync(dataPath, JSON.stringify({
      generatedAt: null, lastSuccessAt: null, isFallback: true,
      source: { repo: process.env.GITHUB_REPOSITORY || 'local', workflow: 'gh-daily-push.yml', scope: '抓取失败且无历史快照' },
      sections: []
    }, null, 2), 'utf8');
    return;
  }
  const old = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const out = {
    ...old,
    isFallback: true,
    generatedAt: new Date().toISOString(),           // 本次构建时间
    lastSuccessAt: old.generatedAt || old.lastSuccessAt // 回退到的那次成功时间
  };
  if (old.source) out.source = { ...old.source, fallbackFrom: old.generatedAt || null };
  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2), 'utf8');
  log(`已回退到快照（${old.generatedAt}）→ ${dataPath}`);
}

main().catch(e => { log('致命错误：', e); process.exit(1); });
