import { config } from './config.js';

// 豆瓣与烂番茄的评分补充抓取。两个数据源都没有可用的官方公开 API：
// - 豆瓣：/j/subject_suggest 搜索匹配条目，再抓 m.douban.com 移动端详情页拿评分
//   （PC 详情页无 cookie 会被 302 到安全验证，移动端不拦且自带 ratingValue 元数据）
// - 烂番茄：官方搜索前端用的 Algolia 公开索引（页面内嵌 search-only key），
//   一次查询同时拿到 Tomatometer、Popcornmeter 与页面 vanity slug

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ALGOLIA_APP = '79FRDP12PN';
const ALGOLIA_KEY = '175588f6e5f8319b27702e4cc4013561';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局节流：两个数据源都无公开配额协议，保守控速防封；±20% 抖动让请求间隔不呈现机械规律
function throttle(rps) {
  let gate = Promise.resolve();
  let lastAt = 0;
  return () => {
    gate = gate.then(async () => {
      const wait = lastAt + (1000 / rps) * (0.8 + Math.random() * 0.4) - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
    });
    return gate;
  };
}
const doubanGate = throttle(config.doubanRps);
const algoliaGate = throttle(config.algoliaRps);

// 豆瓣风控：302 表示被安全验证拦截（IP 级，带 cookie 也无效），抛错让 scraper 明天重试；
// 403/404 等按「无此条目」返回 null。redirect:manual 避免静默跟到验证页拿到无用 HTML
async function fetchText(url, headers, gate, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(i * 800);
    await gate();
    let res;
    try {
      res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.ok) return await res.text();
    if (res.status >= 300 && res.status < 400) throw new Error(`blocked ${res.status}`);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${res.status}`);
      continue;
    }
    return null;
  }
  throw lastErr;
}

// 合法格式的 bid cookie（豆瓣下发的访客标识），降低无 cookie 请求被风控的概率
const BID = Array.from({ length: 2 }, () => Math.random().toString(36).slice(2)).join('');

// 标题归一化：去空格/标点/大小写差异，用于候选匹配
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s　:：·.()（）\-—–/]+/g, '');

// 归一化后完全相等 2 分，互相包含 1 分
const titleScore = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  if (x.includes(y) || y.includes(x)) return 1;
  return 0;
};

const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 1;

// 移动端详情页的两个 meta 标签：评分与评价人数
const parseDetail = (page) => {
  const rating = page?.match(/ratingValue" content="([\d.]+)"/)?.[1];
  const votes = page?.match(/reviewCount" content="(\d+)"/)?.[1];
  return rating && Number(rating) > 0
    ? { rating: Number(rating), votes: votes ? Number(votes) : null }
    : null;
};

// 入参即 SQL 行的 titles 字段（snake_case），与 scraper 的 SELECT 结果直接对接
export async function doubanRating({ title, original_title, release_year: year, media_type: type }) {
  // suggest 对中文匹配更准；标题本身不是中文（如纯外文条目）才退到原名
  const q = /\p{Script=Han}/u.test(title ?? '') ? title : original_title;
  if (!q) return null;

  // 主路径：subject_suggest 带年份，匹配更准
  const text = await fetchText(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`,
    { 'User-Agent': UA_DESKTOP, Referer: 'https://movie.douban.com/', Cookie: `bid=${BID}` }, doubanGate
  );
  let list = [];
  try {
    list = Array.isArray(JSON.parse(text ?? '')) ? JSON.parse(text) : [];
  } catch { /* 非 JSON 即不可用，走兜底 */ }

  let id = null;
  let bestScore = 0;
  for (const c of list) {
    // 候选按「标题相似度 + 年份吻合」打分；剧集 suggest 会返回各季，年份过滤恰好淘汰非首播季
    const cy = Number(c.year) || null;
    if (cy != null && year != null && Math.abs(cy - year) > 1) continue;
    let s = titleScore(c.title, title) + titleScore(c.sub_title, original_title);
    if (near(cy, year)) s += 2;
    if (s > bestScore) {
      id = c.id;
      bestScore = s;
    }
  }

  if (!id || bestScore < 2) {
    // 兜底：suggest 索引覆盖不全（如「侠探杰克」返回空）。
    // 移动端搜索页结果无年份/类型，靠详情页 <title> 里的「电影/电视剧」甄别，剧集只认主页（第一季）
    const page = await fetchText(`https://m.douban.com/search/?query=${encodeURIComponent(q)}`, { 'User-Agent': UA_MOBILE, Cookie: `bid=${BID}` }, doubanGate);
    const items = [...(page ?? '').matchAll(/<a href="\/movie\/subject\/(\d+)\/">\s*<img[^>]*\/>\s*<div class="subject-info">\s*<span class="subject-title">([^<]*)<\/span>/g)]
      .map((m) => ({ id: m[1], title: m[2], s: titleScore(m[2], q) }))
      .filter((it) => it.s > 0)
      .sort((a, b) => b.s - a.s);
    for (const it of items.slice(0, 3)) {
      if (type === 'tv' && /第[二三四五六七八九十百\d]+季/.test(it.title)) continue;
      const detail = await fetchText(`https://m.douban.com/movie/subject/${it.id}/`, { 'User-Agent': UA_MOBILE, Cookie: `bid=${BID}` }, doubanGate);
      const kind = detail?.match(/<title>[\s\S]*?-\s*(电影|电视剧|动画|综艺|纪录片|短片)\s*-\s*豆瓣/)?.[1];
      if (!kind) continue;
      // 豆瓣类型词映射到 TMDB 的 movie/tv：动画电影、短片归电影，综艺/纪录片/动画剧集归剧
      const isTv = ['电视剧', '综艺', '纪录片'].includes(kind) || (kind === '动画' && /第[一二三四五六七八九十百\d]+季/.test(it.title));
      if (isTv !== (type === 'tv')) continue;
      const d = parseDetail(detail);
      return d ? { ...d, id: it.id } : null;
    }
    return null;
  }

  const page = await fetchText(`https://m.douban.com/movie/subject/${id}/`, { 'User-Agent': UA_MOBILE, Cookie: `bid=${BID}` }, doubanGate);
  const d = parseDetail(page);
  return d ? { ...d, id } : null;
}

export async function rtRating({ title, original_title, release_year: year, media_type: type }) {
  const q = original_title ?? title;
  if (!q) return null;

  await algoliaGate();
  const res = await fetch(
    `https://${ALGOLIA_APP}-dsn.algolia.net/1/indexes/content/query`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': ALGOLIA_KEY,
      },
      body: JSON.stringify({ query: q, hitsPerPage: 8 }),
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!res.ok) return null;

  const hits = (await res.json()).hits ?? [];
  const name = original_title ?? title;
  let best = null;
  let bestScore = 0;
  for (const h of hits) {
    if (h.type !== type) continue;
    const hy = h.releaseYear ?? null;
    if (hy != null && year != null && Math.abs(hy - year) > 1) continue;
    let s = titleScore(h.title, name);
    for (const t of h.titles ?? []) s = Math.max(s, titleScore(t, name));
    if (near(hy, year)) s += 2;
    if (s > bestScore) {
      best = h;
      bestScore = s;
    }
  }
  if (!best || bestScore < 2) return null;

  const rt = best.rottenTomatoes ?? {};
  const critics = rt.criticsScore ?? null;
  const audience = rt.audienceScore ?? null;
  if (!critics && !audience) return null; // 该片暂无任何评分，不值得存
  return { critics, audience, vanity: best.vanity ?? null };
}
