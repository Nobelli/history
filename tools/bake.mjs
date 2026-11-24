/**
 * 把维基数据里的“重大事件”抓下来，生成 data/events.json
 *
 * 用法：
 *   node tools/bake.mjs               # 默认 4000 条
 *   node tools/bake.mjs --limit 300   # 少抓一些
 *   node tools/bake.mjs --budget 100  # 最多跑 100 秒，先把现有的写成文件
 *
 * 筛选逻辑：类型限定为战争 / 战役 / 革命 / 起义 / 政变 / 条约 / 屠杀 / 种族灭绝 /
 * 恐怖袭击 / 行刺 / 地震 / 饥荒 / 瘟疫 / 灾害 / 经济危机 / 社会运动 / 罢工 /
 * 探险 / 科学发现 / 航天任务 / 会议；要求有中文维基条目，跨语言条目数门槛
 * 默认 12（战役 45、会议 40，避开小题大做），按跨语言条目数降序取前 N 条。
 * 摘要取中文维基条目的首段（简体），取不到时退回维基数据的一句话描述。
 *
 * 抓到的摘要会缓存在 .cache/extracts.json，中断后重跑会跳过已抓的部分。
 */

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) || 4000 : 4000;
})();
const BUDGET = (() => {
  const i = process.argv.indexOf('--budget');
  return i > -1 ? (parseInt(process.argv[i + 1], 10) || 0) * 1000 : 0;
})();
const MIN_SITELINKS = 12;

const UA = 'history-search-baker/1.0 (https://github.com/; contact: local)';
const OUT = new URL('../data/events.json', import.meta.url);
const CACHE = new URL('../.cache/extracts.json', import.meta.url);

const { writeFile, mkdir, readFile } = await import('node:fs/promises');

const TYPES = {
  Q198: '战争', Q178561: '战争', Q645883: '战争',
  Q10931: '政治', Q124734: '政治', Q45382: '政治', Q131569: '政治',
  Q1464916: '政治', Q3882219: '政治', Q625994: '政治',
  Q3199915: '社会', Q2223653: '社会', Q41397: '社会',
  Q49773: '社会', Q49776: '社会', Q273120: '社会',
  Q7944: '灾难', Q3241045: '灾难', Q3839081: '灾难',
  Q168247: '灾难', Q12184: '灾难',
  Q290178: '经济',
  Q12772819: '科技',
  Q6502154: '探索', Q2133344: '探索',
};

// 战役、会议这两个类太容易滥，门槛高一点
const TYPE_MIN = { Q178561: 45, Q625994: 40 };

const SPARQL = `
SELECT DISTINCT ?item ?type ?label ?desc ?date ?sitelinks ?article ?countryLabel WHERE {
  VALUES ?type { ${Object.keys(TYPES).map(q => 'wd:' + q).join(' ')} }
  ?item wdt:P31 ?type .
  { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${MIN_SITELINKS})
  ${Object.entries(TYPE_MIN).map(([q, n]) => `FILTER(?type != wd:${q} || ?sitelinks >= ${n})`).join('\n  ')}
  ?article schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
}
ORDER BY DESC(?sitelinks)
LIMIT 30000`;

const CHINA_TEXT = /(中国|中國|中华|中華)/;

async function sparql(query) {
  const r = await fetch('https://query.wikidata.org/sparql?format=json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': UA,
    },
    body: 'query=' + encodeURIComponent(query),
  });
  if (!r.ok) throw new Error('SPARQL HTTP ' + r.status);
  return (await r.json()).results.bindings;
}

function yearOf(iso) {
  const m = /^(-?\d{1,4})-/.exec(iso || '');
  if (!m) return null;
  let y = parseInt(m[1], 10);
  // xsd:dateTime 用天文纪年：-0489 实为公元前 490 年
  if (y < 0) y -= 1;
  return y;
}

function titleFromArticle(url) {
  const seg = url.split('/wiki/')[1] || '';
  return decodeURIComponent(seg).replace(/_/g, ' ');
}

function titleFromExtract(ex) {
  const seg = (ex || '').split(/[（(]/)[0].trim();
  if (/^(位于|是|属于|屬於|又称|又稱|本条目|本条|该|此)/.test(seg)) return '';
  if (seg && seg.length <= 16 && !/[，。；：、,„]/.test(seg)) return seg;
  return '';
}

function clip(text, max = 190) {  let t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = cut.match(/^[\s\S]*[。！？；.!?]/);
  return (m ? m[0] : cut) + '…';
}

async function wikitext(titles) {
  const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2',
    titles: titles.join('|'), prop: 'extracts',
    exintro: '1', explaintext: '1', exlimit: 'max',
    redirects: '1', converttitles: '1', variant: 'zh-cn', origin: '*',
  });
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('wiki HTTP ' + r.status);
  const j = await r.json();
  const q = (j && j.query) || {};
  const pages = q.pages || [];
  const byTitle = new Map();
  for (const p of pages) byTitle.set(p.title, { title: p.title, extract: p.extract || '' });
  const map = new Map();
  for (const p of pages) if (p.extract) map.set(p.title, byTitle.get(p.title));
  // 归一化 / 简繁转换 / 重定向：请求时的原标题 → 真实页面
  for (const key of ['normalized', 'converted', 'redirects']) {
    for (const n of q[key] || []) {
      const hit = byTitle.get(n.to);
      if (hit && hit.extract) map.set(n.from, hit);
    }
  }
  return map;
}

function pick(rows) {
  const seen = new Map();
  for (const b of rows) {
    const title = titleFromArticle(b.article.value);
    if (!title || seen.has(title)) continue;
    const y = yearOf(b.date.value);
    if (y == null) continue;
    seen.set(title, {
      y,
      e: null,
      t: b.label ? b.label.value : title,
      s: clip(b.desc ? b.desc.value : ''),
      c: TYPES[b.type.value.split('/').pop()] || '',
      r: '',
      w: title,
      sl: parseInt(b.sitelinks.value, 10) || 0,
      desc: b.desc ? b.desc.value : '',
    });
  }
  return [...seen.values()].sort((a, b) => b.sl - a.sl).slice(0, LIMIT);
}

async function loadCache() {
  try { return new Map(Object.entries(JSON.parse(await readFile(CACHE, 'utf8')))); }
  catch (e) { return new Map(); }
}
async function saveCache(map) {
  await mkdir(new URL('../.cache/', import.meta.url), { recursive: true });
  await writeFile(CACHE, JSON.stringify(Object.fromEntries(map)), 'utf8');
}

async function main() {
  const t0 = Date.now();
  process.stdout.write('查询维基数据…\n');
  const rows = await sparql(SPARQL);
  process.stdout.write(`候选 ${rows.length} 行\n`);
  const items = pick(rows);
  process.stdout.write(`去重后 ${items.length} 条\n`);

  const cache = await loadCache();
  const todo = items.filter(x => !cache.has(x.w));
  process.stdout.write(`已缓存 ${items.length - todo.length}，需抓摘要 ${todo.length}\n`);

  const batches = [];
  for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));

  let idx = 0, fetched = 0;
  async function worker() {
    while (idx < batches.length) {
      if (BUDGET && Date.now() - t0 > BUDGET) return;
      const b = batches[idx++];
      let map = new Map();
      for (let attempt = 0; attempt < 3 && map.size === 0; attempt++) {
        try {
          map = await wikitext(b.map(x => x.w));
        } catch (err) {
          process.stdout.write(`  失败重试（${err.message}）\n`);
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      if (map.size === 0) continue;          // 整批失败就不写缓存，下次重试
      for (const it of b) {
        const hit = map.get(it.w) || null;
        cache.set(it.w, hit ? { title: hit.title, extract: clip(hit.extract) } : { title: '', extract: '' });
      }
      fetched += b.length;
      if (fetched % 200 < 20) {
        process.stdout.write(`  摘要 ${fetched}/${todo.length}\n`);
        await saveCache(cache);
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await saveCache(cache);

  for (const it of items) {
    const hit = cache.get(it.w);
    if (hit && hit.extract) {
      it.s = hit.extract;
      if (hit.title) { it.w = hit.title; it.t = titleFromExtract(hit.extract) || hit.title; }
    }
    if (!it.s) it.s = it.desc || '';
    it.r = '';   // 自动抓来的条目地域判不准，就不乱标了
  }

  const out = items
    .filter(it => it.s)          // 没摘要的不进数据，免得点了空白
    .map(it => ({ y: it.y, e: it.e, t: it.t, s: it.s, c: it.c, r: it.r, w: it.w, n: it.sl }))
    .sort((a, b) => a.y - b.y);

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
  const left = items.length - items.filter(x => cache.get(x.w) && cache.get(x.w).extract).length;
  process.stdout.write(`\n完成：${out.length} 条 → data/events.json，还有 ${left} 条未抓到摘要，重跑可继续\n`);
}

main().catch(err => {
  console.error('失败：', err);
  process.exit(1);
});
