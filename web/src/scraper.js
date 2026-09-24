import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db, tx, now, getMeta, setMeta } from './db.js';
import { tmdb } from './tmdb.js';
import { config } from './config.js';
import { rtRating } from './ratings.js';
import { checkMagnets } from './magnets.js';

const MIN_YEAR = 1996; // 只收录近 30 年

// total = 全量页数；日常每轮跑「前 hot 页（追新）+ 轮转 rotate 页（补旧）」
// 轮转游标保证整个榜单在 total/rotate 轮内被完整扫过一遍，从而让所有条目的 updated_at 都能刷新
// —— 否则 TMDB 条款要求的 180 天过期清理会把从不进热榜的条目整批误删
// dynamic = 该榜单要「取筛选条件下的全部」，页数每轮以 TMDB 实际 total_pages 为准（写死会随榜单增长静默截断）
// 非 dynamic 的榜单页数是刻意固定的窗口（趋势/正在上映只看最新几页），不能跟着 total_pages 放大
const LISTS = [
  {
    // 票数门槛放宽到 150 后总量 686 页，超 TMDB discover 单查询 500 页硬上限，按年份拆两段
    key: 'movie-popular', type: 'movie', path: '/discover/movie', total: 334, hot: 10, rotate: 20, dynamic: true,
    params: { sort_by: 'popularity.desc', 'vote_count.gte': 150, 'primary_release_date.gte': '2015-01-01' },
  },
  {
    // 旧段是固定集合（不再有新片流入），无需 hot 追新，全靠轮转补旧
    key: 'movie-popular-old', type: 'movie', path: '/discover/movie', total: 352, hot: 0, rotate: 30, dynamic: true,
    params: { sort_by: 'popularity.desc', 'vote_count.gte': 150, 'primary_release_date.gte': `${MIN_YEAR}-01-01`, 'primary_release_date.lte': '2014-12-31' },
  },
  {
    key: 'tv-popular', type: 'tv', path: '/discover/tv', total: 241, hot: 10, rotate: 20, dynamic: true,
    params: { sort_by: 'popularity.desc', 'vote_count.gte': 75, 'first_air_date.gte': `${MIN_YEAR}-01-01` },
  },
  {
    key: 'movie-top', type: 'movie', path: '/discover/movie', total: 316, hot: 3, rotate: 7, dynamic: true,
    params: { sort_by: 'vote_average.desc', 'vote_average.gte': 5, 'vote_count.gte': 500, 'primary_release_date.gte': `${MIN_YEAR}-01-01` },
  },
  {
    key: 'tv-top', type: 'tv', path: '/discover/tv', total: 99, hot: 3, rotate: 7, dynamic: true,
    params: { sort_by: 'vote_average.desc', 'vote_average.gte': 5, 'vote_count.gte': 250, 'first_air_date.gte': `${MIN_YEAR}-01-01` },
  },
  { key: 'movie-trending', type: 'movie', path: '/trending/movie/week', total: 3, hot: 3, rotate: 0 },
  { key: 'tv-trending', type: 'tv', path: '/trending/tv/week', total: 3, hot: 3, rotate: 0 },
  { key: 'movie-now', type: 'movie', path: '/movie/now_playing', total: 5, hot: 5, rotate: 0 },
  { key: 'movie-upcoming', type: 'movie', path: '/movie/upcoming', total: 5, hot: 5, rotate: 0 },
];

// TMDB /discover 单次查询硬上限 500 页，超出部分取不到
const TMDB_MAX_PAGES = 500;

function totalOf(list) {
  if (!list.dynamic) return list.total;
  const real = Number(getMeta(`${list.key}_total`));
  return Math.min(real > 0 ? real : list.total, TMDB_MAX_PAGES);
}

function pagePlan(list, firstRun) {
  const total = totalOf(list);
  if (firstRun) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = Array.from({ length: list.hot }, (_, i) => i + 1);
  if (!list.rotate) return pages;

  // 游标只在热榜页之后循环，避免与 hot 段重复取页
  const start = Number(getMeta(`${list.key}_cursor`)) || list.hot + 1;
  let c = start > total ? list.hot + 1 : start;
  for (let i = 0; i < list.rotate; i++) {
    pages.push(c);
    c = c >= total ? list.hot + 1 : c + 1;
  }
  setMeta(`${list.key}_cursor`, c);
  return pages;
}

const upsertTitle = db.prepare(`
  INSERT INTO titles (tmdb_id, media_type, title, original_title, overview, poster_path,
    backdrop_path, release_date, release_year, vote_average, vote_count, popularity,
    original_language, origin_country, genre_ids, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
    title             = excluded.title,
    original_title    = excluded.original_title,
    overview          = excluded.overview,
    poster_path       = excluded.poster_path,
    backdrop_path     = excluded.backdrop_path,
    release_date      = excluded.release_date,
    release_year      = excluded.release_year,
    vote_average      = excluded.vote_average,
    vote_count        = excluded.vote_count,
    popularity        = excluded.popularity,
    original_language = excluded.original_language,
    origin_country    = excluded.origin_country,
    genre_ids         = excluded.genre_ids,
    updated_at        = excluded.updated_at
`);

const selectId = db.prepare('SELECT id FROM titles WHERE tmdb_id = ? AND media_type = ?');
const clearGenres = db.prepare('DELETE FROM title_genres WHERE title_id = ?');
const addGenre = db.prepare('INSERT OR IGNORE INTO title_genres (title_id, genre_id) VALUES (?,?)');
const saveDetail = db.prepare('UPDATE titles SET extra = ?, detail_fetched_at = ? WHERE id = ?');
// TMDB 条款：缓存不得超过 6 个月。已收藏的条目保留，避免清掉用户数据
const purgeStale = db.prepare(`
  DELETE FROM titles
  WHERE updated_at < ? AND id NOT IN (SELECT title_id FROM favorites)
`);
const CACHE_DAYS = 180;
const pendingDetails = db.prepare(`
  SELECT id, tmdb_id, media_type FROM titles
  WHERE detail_fetched_at IS NULL
  ORDER BY popularity DESC
  LIMIT ?
`);

function saveItem(it, type) {
  // TMDB 字段名按类型分叉：movie 用 title/original_title/release_date，tv 用 name/original_name/first_air_date
  const movie = type === 'movie';
  const date = (movie ? it.release_date : it.first_air_date) || '';
  const title = (movie ? it.title : it.name) ?? '';
  const year = date ? Number(date.slice(0, 4)) : null;
  if (!title) return 0;                        // 无标题视为无效条目
  if (year && year < MIN_YEAR) return 0;       // 已知年份且超出范围则丢弃；未知年份保留

  const ts = now();
  upsertTitle.run(
    it.id, type, title, (movie ? it.original_title : it.original_name) ?? null, it.overview ?? null,
    it.poster_path ?? null, it.backdrop_path ?? null, date || null, year,
    it.vote_average ?? 0, it.vote_count ?? 0, it.popularity ?? 0,
    it.original_language ?? null, JSON.stringify(it.origin_country ?? []),
    JSON.stringify(it.genre_ids ?? []), ts, ts
  );
  return 1;
}

async function syncList(list, pages) {
  let written = 0;
  for (const page of pages) {
    const data = await tmdb(list.path, { ...list.params, page });

    // 每轮以第 1 页回报的真实页数校正，写死的快照会随榜单增长而静默少抓
    if (page === 1 && list.dynamic && data.total_pages) {
      setMeta(`${list.key}_total`, Math.min(data.total_pages, TMDB_MAX_PAGES));
      if (data.total_pages > TMDB_MAX_PAGES) {
        console.warn(`[sync] ${list.key} 共 ${data.total_pages} 页，超 TMDB 上限，仅抓前 ${TMDB_MAX_PAGES} 页`);
      }
    }

    const items = data.results ?? [];
    if (!items.length) break;

    tx(() => {
      for (const it of items) {
        const id = saveItem(it, list.type);
        if (!id) continue;
        written++;
        const row = selectId.get(it.id, list.type);
        clearGenres.run(row.id);
        for (const g of it.genre_ids ?? []) addGenre.run(row.id, g);
      }
    });
  }
  return written;
}

async function syncGenres() {
  const ts = now();
  const upsert = db.prepare(
    'INSERT INTO genres (id, media_type, name) VALUES (?,?,?) ON CONFLICT(id, media_type) DO UPDATE SET name = excluded.name'
  );
  for (const type of ['movie', 'tv']) {
    const { genres = [] } = await tmdb(`/genre/${type}/list`);
    tx(() => { for (const g of genres) upsert.run(g.id, type, g.name); });
  }
  setMeta('genres_synced_at', ts);
}

// 串行时受往返延迟限制（实测约 1.7 req/s，远低于 TMDB_RPS 配额），并发化以吃满配额
const DETAIL_CONCURRENCY = 6;
const DETAIL_BATCH = 200;

async function enrichDetails(budget) {
  let done = 0;
  for (;;) {
    if (budget > 0 && done >= budget) break;
    const limit = budget > 0 ? Math.min(DETAIL_BATCH, budget - done) : DETAIL_BATCH;
    const rows = pendingDetails.all(limit);
    if (!rows.length) break;

    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const row = rows[i++];
        const type = row.media_type;
        let d;
        try {
          d = await tmdb(`/${type}/${row.tmdb_id}`, { append_to_response: 'credits' });
        } catch {
          saveDetail.run(JSON.stringify({ error: 'fetch_failed' }), now(), row.id);
          done++;
          continue;
        }
        const extra = type === 'movie'
          ? {
              runtime: d.runtime ?? null,
              status: d.status ?? null,
              tagline: d.tagline || null,
              imdb_id: d.imdb_id ?? null,
              budget: d.budget || null,
              revenue: d.revenue || null,
            }
          : {
              seasons: d.number_of_seasons ?? null,
              episodes: d.number_of_episodes ?? null,
              status: d.status ?? null,
              tagline: d.tagline || null,
              last_air_date: d.last_air_date ?? null,
            };
        extra.cast = (d.credits?.cast ?? []).slice(0, 12).map((c) => ({
          name: c.name, role: c.character, img: c.profile_path ?? null,
        }));
        saveDetail.run(JSON.stringify(extra), now(), row.id);
        done++;
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  }
  return done;
}

// 烂番茄评分补充抓取（豆瓣改为详情页实时抓取，见 routes.js /api/douban/:id）。
// 待抓 = 从未抓过 或 已超过刷新周期；网络失败把时间戳拨到「明天到期」，
// 接口恢复后一天内自动重试，而不是干等整个刷新周期
const pendingRatings = db.prepare(`
  SELECT id, title, original_title, release_year, media_type FROM titles
  WHERE rating_fetched_at IS NULL OR rating_fetched_at < ?
  ORDER BY popularity DESC LIMIT ?
`);
const saveRating = db.prepare(`
  UPDATE titles SET rt_critics=?, rt_audience=?, rt_vanity=?, rating_fetched_at=? WHERE id=?
`);

const RATING_CONCURRENCY = 3;
const RATING_BATCH = 100;

async function enrichRatings(budget) {
  let done = 0;
  for (;;) {
    if (budget > 0 && done >= budget) break;
    const limit = budget > 0 ? Math.min(RATING_BATCH, budget - done) : RATING_BATCH;
    const cutoff = new Date(Date.now() - config.ratingRefreshDays * 86400_000).toISOString();
    const rows = pendingRatings.all(cutoff, limit);
    if (!rows.length) break;

    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const row = rows[i++];
        let r = null;
        let failed = false;
        try {
          r = await rtRating(row);
        } catch (e) {
          failed = true;
          console.warn(`[ratings] 烂番茄 ${row.id} ${row.title}: ${e.message}`);
        }
        saveRating.run(
          r?.critics ?? null, r?.audience ?? null, r?.vanity ?? null,
          failed ? new Date(Date.now() - Math.max(1, config.ratingRefreshDays - 1) * 86400_000).toISOString() : now(),
          row.id
        );
        done++;
      }
    };
    await Promise.all(Array.from({ length: RATING_CONCURRENCY }, worker));
  }
  return done;
}

// 磁力缓存补充：详情页点击是低频实时路径，这里按热度把整个库扫一遍，给列表页的 🧲 标记供数。
// 从未探测的排最前，避免首轮全库扫完之前预算被「已到期待刷新」的条目占满。
// tmdb_id 必须带上：bitmagnet 靠它置 exact，缺了会让 relevant() 的短路失效、计数与详情页对不上
const pendingMagnets = db.prepare(`
  SELECT id, tmdb_id, title, original_title, release_year, media_type FROM titles
  WHERE magnet_checked_at IS NULL OR magnet_checked_at < ?
  ORDER BY (magnet_checked_at IS NOT NULL), popularity DESC LIMIT ?
`);

const MAGNET_CONCURRENCY = 2;
const MAGNET_BATCH = 50;

async function enrichMagnets(budget) {
  let done = 0;
  for (;;) {
    if (budget > 0 && done >= budget) break;
    const limit = budget > 0 ? Math.min(MAGNET_BATCH, budget - done) : MAGNET_BATCH;
    const cutoff = new Date(Date.now() - config.magnetTtlDays * 86400_000).toISOString();
    const rows = pendingMagnets.all(cutoff, limit);
    if (!rows.length) break;

    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        await checkMagnets(rows[i++]);
        done++;
      }
    };
    await Promise.all(Array.from({ length: MAGNET_CONCURRENCY }, worker));
  }
  return done;
}

// 图片缓存：先清 7 天前的，再按 LRU 削到 IMGCACHE_MAX_MB 以下
async function pruneImageCache() {
  const root = join(config.dataDir, 'imgcache');
  const files = [];
  let total = 0;

  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    for (const f of await readdir(dir).catch(() => [])) {
      const p = join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s?.isFile()) {
        files.push({ p, at: s.mtimeMs, size: s.size });
        total += s.size;
      }
    }
  }

  const cutoff = Date.now() - 7 * 86400_000;
  const cap = config.imgcacheMaxMb * 1e6;
  files.sort((a, b) => a.at - b.at);

  let removed = 0;
  for (const f of files) {
    if (f.at >= cutoff && total <= cap) break;
    await unlink(f.p).catch(() => {});
    total -= f.size;
    removed++;
  }
  return removed;
}

let running = false;

export async function runSync() {
  if (running) return { skipped: 'already_running' };
  running = true;
  const startedAt = Date.now();
  try {
    await syncGenres();

    const firstRun = config.fullSync || getMeta('full_sync_done') !== '1';

    const stats = { full: firstRun, lists: {}, details: 0, ratings: 0, magnets: 0 };
    for (const list of LISTS) {
      const pages = pagePlan(list, firstRun);
      const n = await syncList(list, pages);
      stats.lists[list.key] = n;
      console.log(`[sync] ${list.key}: ${n} 条 (${pages.length} 页)`);
    }

    setMeta('full_sync_done', '1');
    stats.details = await enrichDetails(config.detailMaxPerRun);
    stats.ratings = await enrichRatings(config.ratingMaxPerRun);
    stats.magnets = await enrichMagnets(config.magnetMaxPerRun);

    const cutoff = new Date(Date.now() - CACHE_DAYS * 86400_000).toISOString();
    stats.purged = purgeStale.run(cutoff).changes;
    stats.imgPruned = await pruneImageCache();
    setMeta('last_sync_at', now());
    stats.elapsedMs = Date.now() - startedAt;
    console.log('[sync] 完成', JSON.stringify(stats));
    return stats;
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSync().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
