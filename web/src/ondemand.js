import { db, now } from './db.js';
import { tmdb } from './tmdb.js';
import { importTitle } from './titles.js';
import { titleScore, refreshRating } from './ratings.js';
import { checkMagnets } from './magnets.js';

// 搜索兜底补录：库内搜不到时按片名去 TMDB 找，收进库。
// 收录下限（config.minYear）之外的片子各榜单查询一律取不到，正常同步永远收不进来——这条是它们唯一的入库通道
// （另一条是豆瓣 Top250 的缺片补录，见 douban250.js）。

// 回捞周期（天）：这些片不在任何榜单里，updated_at 不会自己刷新，须远早于 scraper 的 180 天清理线
const REFRESH_DAYS = 30;

const cand = (r, type) => {
  const movie = type === 'movie';
  const date = (movie ? r.release_date : r.first_air_date) || '';
  return {
    tmdb_id: r.id,
    media_type: type,
    title: (movie ? r.title : r.name) ?? '',
    original_title: (movie ? r.original_title : r.original_name) || null,
    year: date ? Number(date.slice(0, 4)) : null,
    vote_average: r.vote_average ?? 0,
    vote_count: r.vote_count ?? 0,
    poster_path: r.poster_path ?? null,
  };
};

// 电影、剧集各查一次（/search/multi 会混进人物，还要再筛，不如两次直取）。
// 排序刻意不看 TMDB 的返回次序：同名优先，其余按票数——用户打的港台译名与 TMDB 的中文片名对不上时，
// 票数比 TMDB 的相关性更能把正主顶上来
export async function searchTmdb(q) {
  const [mv, tv] = await Promise.all([
    tmdb('/search/movie', { query: q }),
    tmdb('/search/tv', { query: q }),
  ]);
  return [...(mv.results ?? []).map((r) => cand(r, 'movie')), ...(tv.results ?? []).map((r) => cand(r, 'tv'))]
    .map((c) => ({ ...c, score: Math.max(titleScore(c.title, q), titleScore(c.original_title, q)) }))
    .sort((a, b) => b.score - a.score || b.vote_count - a.vote_count)
    .slice(0, 8);
}

// 归一化后与查询完全同名才算「精确命中」：重名重拍片因此不会自动入库，留给用户点选
export const pickExact = (q, items) =>
  items.filter((c) => c.score === 2).sort((a, b) => b.vote_count - a.vote_count)[0] ?? null;

const titleRow = db.prepare(
  'SELECT id, tmdb_id, title, original_title, release_year, media_type FROM titles WHERE id = ?'
);

const remember = db.prepare('INSERT OR IGNORE INTO ondemand_titles (title_id, added_at) VALUES (?,?)');
const stale = db.prepare(`
  SELECT t.tmdb_id, t.media_type FROM ondemand_titles o JOIN titles t ON t.id = o.title_id
  WHERE t.updated_at < ?
`);

// 补录后随即补齐评分与磁力：这两项在批量同步里按热度排队，冷门老片可能几周轮不到。
// 都要打外站（秒级），不阻塞响应，失败静默——下一轮 sync 仍会兜底
function fillLater(id) {
  const row = titleRow.get(id);
  if (!row) return;
  refreshRating(row).catch(() => {});
  checkMagnets(row).catch(() => {});
}

export async function pullTitle(type, tmdbId) {
  const id = await importTitle(type, tmdbId);
  remember.run(id, now());
  fillLater(id);
  return id;
}

export async function syncOndemand() {
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86400_000).toISOString();
  let n = 0;
  for (const t of stale.all(cutoff)) {
    try {
      await importTitle(t.media_type, t.tmdb_id);
      n++;
    } catch { /* 取不到就留旧数据，下一轮再试 */ }
  }
  return n;
}
