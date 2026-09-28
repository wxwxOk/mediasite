import { db, now, upsertTitle, selectTitleId, clearGenres, addGenre } from './db.js';
import { tmdb } from './tmdb.js';

// 单条 TMDB 条目的取回与落库，豆瓣榜补录（douban250）与搜索按需补录（ondemand）共用这一条路径。
// 列表同步走的是 discover 列表结构（只有 genre_ids、无 credits），字段来源不同，仍留在 scraper.saveItem。

export const saveDetail = db.prepare('UPDATE titles SET extra = ?, detail_fetched_at = ? WHERE id = ?');

// 详情接口的附加字段映射：批量补详情（scraper.enrichDetails）与单条补录共用，免得字段清单两处漂移
export function buildExtra(type, d) {
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
  return extra;
}

// credits 一并取回：补录的条目当场就有片长与演员表，不必等下一轮 enrichDetails
const fetchTitle = (type, tmdbId) => tmdb(`/${type}/${tmdbId}`, { append_to_response: 'credits' });

// 与 scraper.saveItem 同一条 INSERT，年份不受 config.minYear 限制——补录本就是为了收下限之外的片
function saveTitle(d, type) {
  const movie = type === 'movie';
  const date = (movie ? d.release_date : d.first_air_date) || '';
  const ts = now();
  upsertTitle.run(
    d.id, type, (movie ? d.title : d.name) ?? '', (movie ? d.original_title : d.original_name) ?? null,
    d.overview ?? null, d.poster_path ?? null, d.backdrop_path ?? null, date || null,
    date ? Number(date.slice(0, 4)) : null,
    d.vote_average ?? 0, d.vote_count ?? 0, d.popularity ?? 0,
    d.original_language ?? null, JSON.stringify(d.origin_country ?? []),
    JSON.stringify((d.genres ?? []).map((g) => g.id)), ts, ts
  );
  const id = selectTitleId.get(d.id, type).id;
  clearGenres.run(id);
  for (const g of d.genres ?? []) addGenre.run(id, g.id);
  // 没有 credits 的响应不写 extra：留空让 enrichDetails 下一轮照常补
  if (d.credits) saveDetail.run(JSON.stringify(buildExtra(type, d)), ts, id);
  return id;
}

// 返回库内 id（新建或更新已有条目）
export async function importTitle(type, tmdbId) {
  return saveTitle(await fetchTitle(type, tmdbId), type);
}
