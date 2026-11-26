/**
 * 给手写条目补正文。
 *
 * - 精选事件：用 RAW 里的 w 字段（维基条目名）抓
 * - 神话条目：标题本身多是维基条目名，直接按标题抓
 * - 输出 data/long.json，页面加载时按标题合并
 *
 * 用法：node tools/enrich-featured.mjs
 */

const UA = 'history-search-baker/1.0 (https://github.com/; contact: local)';
const OUT = new URL('../data/long.json', import.meta.url);
const MAX = 700;
const CONCURRENCY = 3;

const { readFile, writeFile, mkdir } = await import('node:fs/promises');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const mRaw = html.match(/const RAW = (\[[\s\S]*?\n\];)/);
if (!mRaw) throw new Error('index.html 里没找到 RAW 数组');
const RAW = new Function('return ' + mRaw[1])();

const mMy = html.match(/const MYTH_RAW = (\[[\s\S]*?\n\];)/);
const MYTH_RAW = mMy ? new Function('return ' + mMy[1])() : [];

const mArt = html.match(/const ART_RAW = (\[[\s\S]*?\n\];)/);
const ART_RAW = mArt ? new Function('return ' + mArt[1])() : [];

function longText(text, max = MAX) {
  const paras = (text || '')
    .split(/\n+/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const stop = /^(参考|参考文献|参考文獻|外部链接|外部連結|参见|參見|注释|註釋|延伸阅读|延伸閱讀|来源|來源|引用|书目|書目|腳註|脚注|相關條目|相关条目|参考链接)/;
  const out = [];
  let len = 0;
  for (const p of paras) {
    if (stop.test(p)) break;
    if (p.length < 12) continue;
    if (len && len + p.length > max) break;
    out.push(p);
    len += p.length;
  }
  let joined = out.join('\n');
  if (joined.length > max) {
    const cut = joined.slice(0, max);
    const s = cut.match(/^[\s\S]*[。！？；.!?]/);
    joined = (s ? s[0] : cut) + '…';
  }
  return joined;
}

async function one(title) {
  const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2',
    titles: title, prop: 'extracts',
    exchars: '900', explaintext: '1', exlimit: '1',
    redirects: '1', variant: 'zh-cn', origin: '*',
  });
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const p = j && j.query && j.query.pages && j.query.pages[0];
  return p && p.extract ? p.extract : '';
}

const seen = new Set();
const jobs = [];
for (const a of RAW) {
  const title = a[2], wiki = a[6];
  if (!title || !wiki || seen.has(wiki)) continue;
  seen.add(wiki);
  jobs.push({ t: title, w: wiki });
}
for (const a of MYTH_RAW) {
  const title = a[2];
  if (!title || seen.has(title)) continue;
  seen.add(title);
  jobs.push({ t: title, w: title });
}
// 艺术条目标题常带书名号，去掉再查
for (const a of ART_RAW) {
  const title = a[2];
  const wiki = title.replace(/^《|》$/g, '');
  if (!title || seen.has(wiki)) continue;
  seen.add(wiki);
  jobs.push({ t: title, w: wiki });
}
console.log(`待处理 ${jobs.length} 条`);

const out = [];
// 缓存已抓到的正文，中断重跑时不用重新请求
const CACHE = new URL('../.cache/enrich.json', import.meta.url);
let cache = {};
try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch (e) { /* 首次运行 */ }

let idx = 0, done = 0, failed = 0;
async function worker() {
  while (idx < jobs.length) {
    const job = jobs[idx++];
    if (cache[job.w]) {
      out.push({ t: job.t, d: cache[job.w] });
      done++;
      continue;
    }
    let text = '';
    try {
      text = await one(job.w);
    } catch (e) {
      failed++;
      await new Promise(r => setTimeout(r, 2500));
      continue;
    }
    const d = longText(text);
    if (d) { out.push({ t: job.t, d }); cache[job.w] = d; }
    done++;
    if (done % 20 === 0) {
      console.log(`  ${done}/${jobs.length}`);
      await writeFile(CACHE, JSON.stringify(cache), 'utf8');
    }
    await new Promise(r => setTimeout(r, 120));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(CACHE, JSON.stringify(cache), 'utf8');

// 保持与 RAW / MYTH_RAW 相同顺序，方便对比
const order = new Map();
[...RAW.map(a => a[2]), ...MYTH_RAW.map(a => a[2]), ...ART_RAW.map(a => a[2])].forEach((t, i) => order.set(t, i));
out.sort((x, y) => (order.get(x.t) ?? 1e9) - (order.get(y.t) ?? 1e9));

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
console.log(`完成：${out.length} 条 → data/long.json（失败 ${failed} 次）`);
