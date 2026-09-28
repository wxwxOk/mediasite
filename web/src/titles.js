import {
  db, now, tx, upsertTitle, selectTitleId, clearGenres, addGenre,
  clearCredits, addCredit, upsertPerson,
} from './db.js';
import { tmdb } from './tmdb.js';

// 单条 TMDB 条目的取回与落库，豆瓣榜补录（douban250）与搜索按需补录（ondemand）共用这一条路径。
// 列表同步走的是 discover 列表结构（只有 genre_ids、无 credits），字段来源不同，仍留在 scraper.saveItem。

const saveDetail = db.prepare('UPDATE titles SET extra = ?, detail_fetched_at = ? WHERE id = ?');

const DIRECTOR_JOBS = ['Director'];
// TMDB 的编剧职位分散在多个 job 名上；不含 Novel/Characters 这类原著署名，否则会把小说作者也算成编剧
const WRITER_JOBS = ['Writer', 'Screenplay', 'Story', 'Teleplay'];
// 剧集门槛：只收演过 5 集以上的角色，滤掉一次性客串（aggregate_credits 里连龙套都算，全量约 280 万行）
const MIN_TV_EPISODES = 5;

// 剧集的 credits.cast 只有常驻主演（权游 14 人），完整名单在 aggregate_credits（589 人）；
// 电影两者等价，不额外取。返回结构统一为 TMDB cast 形状，character 取戏份最重的那个角色
export const fetchDetail = (type, tmdbId) => tmdb(`/${type}/${tmdbId}`, {
  append_to_response: type === 'tv' ? 'credits,aggregate_credits' : 'credits',
});

function castOf(d, type) {
  const agg = type === 'tv' ? d.aggregate_credits?.cast : null;
  if (!agg) return d.credits?.cast ?? [];
  return agg
    .filter((c) => (c.total_episode_count ?? 0) >= MIN_TV_EPISODES)
    .map((c) => ({ ...c, character: c.roles?.[0]?.character ?? null }));
}

// 按 job 取 crew 并按 id 去重：同一人常挂多个编剧职位（如既挂 Screenplay 又挂 Story）
function crewOf(d, jobs) {
  const seen = new Map();
  for (const c of d.credits?.crew ?? []) {
    if (c.id && jobs.includes(c.job) && !seen.has(c.id)) seen.set(c.id, c);
  }
  return [...seen.values()];
}

// 详情接口的附加字段映射：批量补详情（scraper.enrichDetails）与单条补录共用，免得字段清单两处漂移
function buildExtra(type, d) {
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
  extra.cast = castOf(d, type).slice(0, 12).map((c) => ({
    id: c.id, name: c.name, role: c.character, img: c.profile_path ?? null,
  }));
  // 主创只留 id 与姓名：详情页按名字出 chip，作品页要的是 id
  const brief = (p) => ({ id: p.id, name: p.name });
  extra.director = crewOf(d, DIRECTOR_JOBS).map(brief);
  extra.writer = crewOf(d, WRITER_JOBS).map(brief);
  // 剧集没有剧集级导演，主创挂在 created_by，详情页按「创作者」单独标出
  if (type === 'tv') extra.creator = (d.created_by ?? []).map(brief);
  return extra;
}

// 演职员进 join 表存全量（详情页只展示前 12 位）：配角演员也得有作品页，否则越靠后的演员越是空页
function saveCredits(titleId, type, d) {
  const rows = [
    ...castOf(d, type).map((c, i) => [c, 'cast', c.character ?? '', i]),
    ...crewOf(d, DIRECTOR_JOBS).map((p) => [p, 'director', '', 0]),
    ...crewOf(d, WRITER_JOBS).map((p) => [p, 'writer', '', 0]),
    // 剧集主创与电影导演同为「导演作品」一类，作品页不区分
    ...(type === 'tv' ? (d.created_by ?? []) : []).map((p) => [p, 'director', '', 0]),
  ];
  clearCredits.run(titleId);
  for (const [p, kind, role, ord] of rows) {
    if (!p.id) continue;
    addCredit.run(titleId, p.id, kind, role, ord);
    upsertPerson.run(p.id, p.name ?? '', p.profile_path ?? null);
  }
}

// extra 与演职员表一并写，两处调用（批量补详情、单条补录）共用，免得字段与事务边界漂移
export function saveDetails(id, type, d) {
  const ts = now();
  tx(() => {
    saveDetail.run(JSON.stringify(buildExtra(type, d)), ts, id);
    saveCredits(id, type, d);
  });
}

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
  if (d.credits) saveDetails(id, type, d);
  return id;
}

// 返回库内 id（新建或更新已有条目）
// 补录的条目当场就有片长与演职员，不必等下一轮 enrichDetails
export async function importTitle(type, tmdbId) {
  return saveTitle(await fetchDetail(type, tmdbId), type);
}
