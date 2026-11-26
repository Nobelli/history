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
 *
 * 每条输出：
 *   y/e  年份（公元前为负数）        t  标题      w  中文维基条目名
 *   wen  英文维基条目名（新增）      s  卡片摘要（180 字）
 *   d    详情正文（多段，换行分隔）  c  分类      n  跨语言条目数（重要度）
 *
 * 抓取结果缓存：
 *   .cache/sparql2.json  维基数据查询结果（12 小时内复用）
 *   .cache/extracts2.json 每条正文（中断重跑会跳过已抓的）
 *   .cache/enlinks.json  英文标题（同上）
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

// 每条正文抓多少字（维基 exchars 上限内）。想更详细就调大，比如 1200 / 1500
const CHARS = 900;
// 详情正文的最大字数（段落累计），一般略小于 CHARS
const LONG_MAX = 800;

const UA = 'history-search-baker/1.0 (https://github.com/; contact: local)';
const OUT = new URL('../data/events.json', import.meta.url);
const CACHE = new URL('../.cache/extracts2.json', import.meta.url);
const EN_CACHE = new URL('../.cache/enlinks.json', import.meta.url);
const SPARQL_CACHE = new URL('../.cache/sparql2.json', import.meta.url);

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

/**
 * 想只用维基 API 拿英文标题（不查 ?en）的话，把下面 OPTIONAL 那一行注释掉即可，
 * 脚本会用 langlinks 批量补，效果一样，而且查询更快。
 */
const SPARQL = `
SELECT DISTINCT ?item ?type ?label ?desc ?date ?sitelinks ?article ?en WHERE {
  VALUES ?type { ${Object.keys(TYPES).map(q => 'wd:' + q).join(' ')} }
  ?item wdt:P31 ?type .
  { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${MIN_SITELINKS})
  ${Object.entries(TYPE_MIN).map(([q, n]) => `FILTER(?type != wd:${q} || ?sitelinks >= ${n})`).join('\n  ')}
  ?article schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> .
  OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
}
ORDER BY DESC(?sitelinks)
LIMIT 40000`;

async function sparql(query, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
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
    } catch (e) {
      lastErr = e;
      process.stdout.write(`  查询失败（${e.message}），重试…\n`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
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

function clip(text, max = 190) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = cut.match(/^[\s\S]*[。！？；.!?]/);
  return (m ? m[0] : cut) + '…';
}

/**
 * 把维基正文整理成多段长文：
 * - 段落之间用换行分隔（页面按段落渲染，`=== 标题 ===` 会变成小标题）
 * - 遇到“参考文献 / 参见 / 外部链接”等章节就停
 */
function longText(text, max = LONG_MAX) {
  const paras = (text || '')
    .split(/\n+/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const stop = /^(参考|参考文献|参考文獻|外部链接|外部連結|参见|參見|注释|註釋|延伸阅读|延伸閱讀|来源|來源|引用|书目|書目|腳註|脚注|相關條目|相关条目|参考链接)/;
  const out = [];
  let len = 0;
  for (const p of paras) {
    // 维基的章节标题会带 = 号，去掉再判断
    if (stop.test(p.replace(/^=+\s*/, '').replace(/\s*=+$/, ''))) break;
    if (p.length < 12) continue;
    if (len && len + p.length > max) break;
    out.push(p);
    len += p.length;
  }
  let joined = out.join('\n');
  if (joined.length > max) {
    const cut = joined.slice(0, max);
    const m = cut.match(/^[\s\S]*[。！？；.!?]/);
    joined = (m ? m[0] : cut) + '…';
  }
  return joined;
}

// 逐条抓正文：TextExtracts 的 exchars 与 exlimit>1 不兼容，只能一次一条
async function wikitextOne(title) {
  const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2',
    titles: title, prop: 'extracts',
    exchars: String(CHARS), explaintext: '1', exlimit: '1',
    redirects: '1', variant: 'zh-cn', origin: '*',
  });
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('wiki HTTP ' + r.status);
  const j = await r.json();
  const p = j && j.query && j.query.pages && j.query.pages[0];
  if (!p) return null;
  if (!p.extract) return { title: p.title, extract: '' };
  return { title: p.title, extract: p.extract };
}

/**
 * 用 langlinks 批量拿英文标题（一次 50 个）。
 * 比在 SPARQL 里加 OPTIONAL 快得多，也不怕查询超时。
 */
async function fetchEnTitles(titles, chunk = 50) {
  const map = new Map();
  for (let i = 0; i < titles.length; i += chunk) {
    const batch = titles.slice(i, i + chunk);
    const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2',
      titles: batch.join('|'), prop: 'langlinks',
      lllang: 'en', lllimit: 'max', redirects: '1', origin: '*',
    });
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const q = (j && j.query) || {};
      const pages = q.pages || [];
      const byTitle = new Map(pages.map(p => [p.title, p]));
      // 归一化 / 简繁转换 / 重定向：请求时的原标题 → 真实页面
      const forward = new Map();
      for (const key of ['normalized', 'converted', 'redirects']) {
        for (const n of q[key] || []) forward.set(n.from, n.to);
      }
      for (const t of batch) {
        let key = t, guard = 0;
        while (forward.has(key) && guard++ < 5) key = forward.get(key);
        const p = byTitle.get(key) || byTitle.get(t);
        const ll = p && p.langlinks && p.langlinks.find(x => x.lang === 'en');
        if (ll && ll.title) map.set(t, ll.title);
      }
    } catch (e) {
      process.stdout.write(`  英文标题批次失败：${e.message}\n`);
    }
    await new Promise(r => setTimeout(r, 150));
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
      wen: b.en ? titleFromArticle(b.en.value) : '',   // 英文维基条目名
      sl: parseInt(b.sitelinks.value, 10) || 0,
      desc: b.desc ? b.desc.value : '',
    });
  }
  return [...seen.values()].sort((a, b) => b.sl - a.sl).slice(0, LIMIT);
}

async function loadJSON(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (e) {
    // 只有“文件不存在”才算首次运行；损坏时报错，避免把旧缓存覆盖成空
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`缓存文件读取失败：${e.message}。删掉 .cache/ 后重跑即可`);
  }
}
async function saveJSON(url, data) {
  await mkdir(new URL('../.cache/', import.meta.url), { recursive: true });
  await writeFile(url, JSON.stringify(data), 'utf8');
}

async function getRows() {
  const { stat } = await import('node:fs/promises');
  try {
    const st = await stat(SPARQL_CACHE);
    if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) {
      process.stdout.write('使用缓存的查询结果\n');
      return JSON.parse(await readFile(SPARQL_CACHE, 'utf8'));
    }
  } catch (e) { /* 没缓存 */ }
  process.stdout.write('查询维基数据…\n');
  const rows = await sparql(SPARQL);
  await saveJSON(SPARQL_CACHE, rows);
  return rows;
}

async function main() {
  const t0 = Date.now();
  const rows = await getRows();
  process.stdout.write(`候选 ${rows.length} 行\n`);
  const items = pick(rows);
  process.stdout.write(`去重后 ${items.length} 条\n`);

  // ---- 1. 抓中文正文 ----
  const cache = new Map(Object.entries(await loadJSON(CACHE, {})));
  const todo = items.filter(x => !cache.has(x.w));
  process.stdout.write(`已缓存 ${items.length - todo.length}，需抓正文 ${todo.length}\n`);

  const CONCURRENCY = 3;
  let idx = 0, fetched = 0;
  const worker = async () => {
    while (idx < todo.length) {
      if (BUDGET && Date.now() - t0 > BUDGET) return;
      const it = todo[idx++];
      let hit;
      try {
        hit = await wikitextOne(it.w);
      } catch (err) {
        process.stdout.write(`  失败（${err.message}），稍后重试\n`);
        await new Promise(r => setTimeout(r, 2500));
        continue;                       // 不写缓存，下轮再试
      }
      if (hit === null) continue;
      cache.set(it.w, {
        title: hit.title,
        long: longText(hit.extract),
        brief: clip(hit.extract, 180),
      });
      fetched++;
      if (fetched % 100 === 0) {
        process.stdout.write(`  正文 ${fetched}/${todo.length}\n`);
        await saveJSON(CACHE, Object.fromEntries(cache));
      }
      await new Promise(r => setTimeout(r, 120));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await saveJSON(CACHE, Object.fromEntries(cache));

  for (const it of items) {
    const hit = cache.get(it.w);
    if (hit && (hit.long || hit.brief)) {
      it.d = hit.long || hit.brief;
      it.s = hit.brief || clip(hit.long, 180);
      if (hit.title) { it.w = hit.title; it.t = titleFromExtract(hit.long || hit.brief) || hit.title; }
    }
    if (!it.s) it.s = it.desc || '';
    it.r = '';
  }

  // ---- 2. 补英文标题（SPARQL 没给到的，用 langlinks 批量补）----
  const enCache = await loadJSON(EN_CACHE, {});
  const needEn = items.filter(x => !x.wen);
  if (needEn.length) {
    const known = needEn.filter(x => enCache[x.w]);
    for (const it of known) it.wen = enCache[it.w];
    const unknown = needEn.filter(x => !enCache[x.w]);
    process.stdout.write(`英文标题：缓存 ${known.length} 条，需查询 ${unknown.length} 条\n`);
    if (unknown.length) {
      const map = await fetchEnTitles(unknown.map(x => x.w));
      for (const it of unknown) {
        if (map.has(it.w)) {
          enCache[it.w] = map.get(it.w);
          it.wen = map.get(it.w);
        } else {
          enCache[it.w] = '';           // 没有英文条目，记空避免重复查
        }
      }
      await saveJSON(EN_CACHE, enCache);
    }
  }

  // ---- 3. 输出 ----
  const out = items
    .filter(it => it.s)
    .map(it => ({
      y: it.y, e: it.e, t: it.t, s: it.s, d: it.d || it.s,
      c: it.c, r: it.r, w: it.w, wen: it.wen || '', n: it.sl,
    }))
    .sort((a, b) => a.y - b.y);

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');

  const withEn = out.filter(x => x.wen).length;
  const left = items.length - items.filter(x => { const c = cache.get(x.w); return c && (c.long || c.brief); }).length;
  process.stdout.write(
    `\n完成：${out.length} 条 → data/events.json（${withEn} 条带英文条目）` +
    `，还有 ${left} 条未抓到正文，重跑可继续\n`
  );
}

main().catch(err => {
  console.error('失败：', err);
  process.exit(1);
});
