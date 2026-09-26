import { db, tx, now, getMeta, setMeta, upsertTitle, selectTitleId, clearGenres, addGenre } from './db.js';
import { config } from './config.js';
import { doubanFetch } from './ratings.js';
import { tmdb } from './tmdb.js';

// 豆瓣电影 Top250 榜。网页无 API：PC 列表页 /top250?start=N 带 bid cookie 可直接抓，10 页 × 25 条。
// 榜单变动极慢，按周期刷新，失败沿用旧快照；库内片名是 TMDB 的 zh-CN 字段，与豆瓣主片名高度一致，
// 故匹配 = 片名（主名/别名/外文原名归一化后精确相等）+ 年份 ±1，容不下同名的重拍片与续集。
const PAGE = 25;
const TOTAL = 250;

const unesc = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const parsePage = (html) => {
  const out = [];
  for (const chunk of String(html ?? '').split('<div class="item">').slice(1)) {
    const rank = Number(chunk.match(/<em>(\d+)<\/em>/)?.[1]);
    const id = chunk.match(/subject\/(\d+)\//)?.[1];
    // 两个 <span class="title"> 依次是主片名与外文名，<span class="other"> 是港台译名等别名
    const names = [...chunk.matchAll(/<span class="title">([\s\S]*?)<\/span>/g)]
      .map((m) => unesc(m[1]).replace(/^[\s/]+/, '').trim());
    const other = chunk.match(/<span class="other">([\s\S]*?)<\/span>/)?.[1];
    if (!rank || !id || !names[0]) continue;
    out.push({
      rank,
      douban_id: id,
      title: names[0],
      alt: [...names.slice(1), ...(other ? unesc(other).split(/\s*\/\s*/) : [])].filter(Boolean),
      // 年份取 <br> 后第一个四位数字：豆瓣对同一部片会列多个年份（如 1961(中国大陆) / 1978）
      year: Number(chunk.match(/<br>\s*(\d{4})/)?.[1]) || null,
      rating: Number(chunk.match(/rating_num" property="v:average">([\d.]+)</)?.[1]) || null,
      votes: Number(chunk.match(/>(\d+)人评价</)?.[1]) || null,
    });
  }
  return out;
};

async function fetchTop250() {
  const out = [];
  for (let start = 0; start < TOTAL; start += PAGE) {
    const items = parsePage(await doubanFetch(`https://movie.douban.com/top250?start=${start}&filter=`));
    if (!items.length) throw new Error(`第 ${start / PAGE + 1} 页解析为空`);
    out.push(...items);
  }
  return out;
}

const upsert = db.prepare(`
  INSERT INTO douban_top250 (rank, douban_id, title, alt, year, rating, votes, updated_at)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(rank) DO UPDATE SET
    douban_id = excluded.douban_id, title = excluded.title, alt = excluded.alt, year = excluded.year,
    rating = excluded.rating, votes = excluded.votes, updated_at = excluded.updated_at
`);
// 本轮未写到的 rank 即已跌出榜单（含榜单整体缩短），连行删除
const dropStale = db.prepare('DELETE FROM douban_top250 WHERE updated_at < ?');
const listAll = db.prepare('SELECT rank, douban_id, title, alt, year FROM douban_top250');
const setLink = db.prepare('UPDATE douban_top250 SET title_id = ? WHERE rank = ?');

// 片名归一化：罗马数字并入阿拉伯数字，去掉大小写、全半角标点与空格差异
const ROMAN = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ';
const norm = (s) => String(s ?? '')
  .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, (c) => String(ROMAN.indexOf(c) + 1))
  .toLowerCase()
  .replace(/[\s　:：·‧・.。()（）[\]【】\-—–_~/／、，,！!？?"'“”‘’《》<>|+&]/g, '');

const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 1;

const movies = db.prepare(`SELECT id, title, original_title, release_year, douban_id, popularity
  FROM titles WHERE media_type = 'movie'`);

// 榜上有、库里没有的片：多是早于收录下限的老片，TMDB 的列表查询一律从 config.minYear 起，
// 正常同步永远收不到它们，只能按片名单独搜 TMDB 补录；补上后挂 title_id，卡片就能点进详情页
const missing = db.prepare('SELECT rank, douban_id, title, alt, year FROM douban_top250 WHERE title_id IS NULL');
// 已挂榜的条目要按周期回捞：不在任何列表里的老片 updated_at 不会自己刷新，
// 放着不管会被 scraper 的 180 天过期清理整批删掉（删除时 title_id 置空，下次又回到 missing 重搜）
const staleLinked = db.prepare(`SELECT t.id, t.tmdb_id FROM douban_top250 d JOIN titles t ON t.id = d.title_id
  WHERE t.updated_at < ?`);

// 把榜单条目解析到库内电影：按归一化片名在库内 title/original_title 里精确找，候选要求年份 ±1。
// 只用精确相等是刻意的——豆瓣片名与库内 zh-CN 片名本就高度一致，而放宽到子串会立刻出错
// （C.R.A.Z.Y. 的 crazy 会命中 Crazy Stone，单字符片名「A」会命中一切）。
// 主名权重高于别名：豆瓣的别名列表混有噪声（「告白」的别名里挂着「母亲」），等权时会被热度抢走。
const W_MAIN = 3;
const W_ALT = 2;

function resolve(entries) {
  const byName = new Map();
  const add = (k, r) => {
    if (!k) return;
    const list = byName.get(k);
    if (list) list.push(r);
    else byName.set(k, [r]);
  };
  for (const r of movies.all()) {
    add(norm(r.title), r);
    add(norm(r.original_title), r);
  }

  const links = [];
  for (const e of entries) {
    const cands = new Map();
    const mark = (name, w) => {
      for (const r of byName.get(norm(name)) ?? []) {
        const c = cands.get(r.id);
        if (!c || c.w < w) cands.set(r.id, { r, w });
      }
    };
    mark(e.title, W_MAIN);
    for (const a of e.alt ? JSON.parse(e.alt) : []) mark(a, W_ALT);

    const all = [...cands.values()];
    const best = all.find((c) => c.r.douban_id === e.douban_id)
      ?? all.filter((c) => near(c.r.release_year, e.year))
        .sort((a, b) => b.w - a.w || b.r.popularity - a.r.popularity)[0];
    links.push([best?.r.id ?? null, e.rank]);
  }
  return links;
}

// 候选打分与 resolve 同源：主名归一化精确相等 3 分，别名 2 分，其余不算
function hit(r, names) {
  const t = norm(r.title);
  const o = norm(r.original_title);
  const has = (n) => {
    const x = norm(n);
    return x && (x === t || x === o);
  };
  if (has(names[0])) return 3;
  return names.slice(1).some(has) ? 2 : 0;
}

// 用豆瓣主名（中文）搜，落空再试第一个别名。不带 year 参数：TMDB 与豆瓣的上映年常差一年，
// 交给 API 过滤会把这类候选直接滤掉，年份一律由本地 ±1 判定
async function findOnTmdb(e) {
  const names = [e.title, ...(e.alt ? JSON.parse(e.alt) : [])];
  for (const q of names.slice(0, 2)) {
    if (!q) continue;
    const { results = [] } = await tmdb('/search/movie', { query: q });
    const best = results
      .map((r) => ({ r, w: hit(r, names), y: Number(String(r.release_date ?? '').slice(0, 4)) || null }))
      .filter((c) => c.w && near(c.y, e.year))
      .sort((a, b) => b.w - a.w || (b.r.vote_count ?? 0) - (a.r.vote_count ?? 0))[0];
    if (best) return best.r.id;
  }
  return null;
}

// 写库走与列表同步同一条 INSERT；详情字段（genres/origin_country）在 /movie/{id} 里一次取全，
// extra（演职员等）留给 scraper 的 enrichDetails 补，路径与列表进来的条目完全一致
function saveMovie(d) {
  const date = d.release_date || '';
  const ts = now();
  upsertTitle.run(
    d.id, 'movie', d.title ?? '', d.original_title ?? null, d.overview ?? null,
    d.poster_path ?? null, d.backdrop_path ?? null, date || null, date ? Number(date.slice(0, 4)) : null,
    d.vote_average ?? 0, d.vote_count ?? 0, d.popularity ?? 0,
    d.original_language ?? null, JSON.stringify(d.origin_country ?? []),
    JSON.stringify((d.genres ?? []).map((g) => g.id)), ts, ts
  );
  const id = selectTitleId.get(d.id, 'movie').id;
  clearGenres.run(id);
  for (const g of d.genres ?? []) addGenre.run(id, g.id);
  return id;
}

export async function syncTop250() {
  const last = getMeta('douban250_synced_at');
  const stale = !last || Date.now() - Date.parse(last) > config.douban250RefreshDays * 86400_000;
  let fetched = 0;

  if (stale) {
    try {
      const items = await fetchTop250();
      const ts = now();
      tx(() => {
        for (const it of items) {
          upsert.run(it.rank, it.douban_id, it.title, JSON.stringify(it.alt), it.year, it.rating, it.votes, ts);
        }
        dropStale.run(ts);
      });
      setMeta('douban250_synced_at', ts);
      fetched = items.length;
    } catch (e) {
      // 被风控（302）或页面改版时保留旧快照，下一轮再试，不影响其余同步
      console.warn(`[top250] 抓取失败，沿用旧快照: ${e.message}`);
    }
  }

  // 解析每轮都做：库内每天都在进新片，榜单本身却很少变
  const links = resolve(listAll.all());
  tx(() => { for (const [id, rank] of links) setLink.run(id, rank); });

  // 补录与回捞按周期跑：搜不到的条目重试多少次结果都一样，没必要每轮都打 TMDB
  let filled = 0;
  let refreshed = 0;
  const lastFill = getMeta('douban250_filled_at');
  if (!lastFill || Date.now() - Date.parse(lastFill) > config.douban250RefreshDays * 86400_000) {
    let errors = 0;
    for (const e of missing.all()) {
      try {
        const tmdbId = await findOnTmdb(e);
        if (!tmdbId) {
          console.log(`[top250] TMDB 无匹配，跳过: ${e.rank}. ${e.title} (${e.year ?? '?'})`);
          continue;
        }
        setLink.run(saveMovie(await tmdb(`/movie/${tmdbId}`)), e.rank);
        filled++;
      } catch (err) {
        errors++;
        console.warn(`[top250] 补录失败 ${e.title}: ${err.message}`);
      }
    }
    const cutoff = new Date(Date.now() - config.douban250RefreshDays * 86400_000).toISOString();
    for (const t of staleLinked.all(cutoff)) {
      try {
        saveMovie(await tmdb(`/movie/${t.tmdb_id}`));
        refreshed++;
      } catch { /* 取不到就留旧数据，下一轮再说 */ }
    }
    // 有网络类失败就不记时间戳，下一轮 sync 接着重试，别让一次故障白等一个周期
    if (!errors) setMeta('douban250_filled_at', now());
  }

  return { fetched, linked: links.filter(([id]) => id != null).length, filled, refreshed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncTop250().then((r) => {
    console.log('[top250]', JSON.stringify(r));
    process.exit(0);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
