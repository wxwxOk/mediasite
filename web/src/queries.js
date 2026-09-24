import { db, now } from './db.js';

export const PAGE_SIZE = 40;

const SORT = {
  popularity: 't.popularity DESC',
  vote: 't.vote_average DESC, t.vote_count DESC',
  newest: 't.release_date DESC',
  oldest: 't.release_date ASC',
};

// LIKE 的 % _ \ 是元字符，用户输入需转义后再配 ESCAPE
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 豆瓣评分只在详情页实时抓取（见 routes.js /api/douban/:id），不进列表查询
const LIST_COLS = `t.id, t.tmdb_id, t.media_type, t.title, t.original_title,
  t.poster_path, t.release_date, t.release_year, t.vote_average, t.vote_count, t.popularity,
  t.rt_critics, t.rt_audience, t.rt_vanity, t.magnet_count`;

function buildWhere(p) {
  const where = [];
  const args = [];

  if (p.type === 'movie' || p.type === 'tv') {
    where.push('t.media_type = ?');
    args.push(p.type);
  }
  if (p.genre?.length) {
    where.push(`EXISTS (SELECT 1 FROM title_genres g WHERE g.title_id = t.id AND g.genre_id IN (${p.genre.map(() => '?').join(',')}))`);
    args.push(...p.genre.map(Number));
  }
  if (p.decade?.length) {
    where.push(`(${p.decade.map(() => '(t.release_year >= ? AND t.release_year <= ?)').join(' OR ')})`);
    for (const d of p.decade) args.push(Number(d), Number(d) + 9);
  }
  if (p.lang?.length) {
    // cn 是 TMDB 遗留的中文代码，选 zh 时一并匹配
    const langs = p.lang.flatMap((l) => (l === 'zh' ? ['zh', 'cn'] : [l]));
    where.push(`t.original_language IN (${langs.map(() => '?').join(',')})`);
    args.push(...langs);
  }
  if (p.minVote) {
    where.push('t.vote_average >= ?');
    args.push(Number(p.minVote));
  }
  if (p.q) {
    const kw = `%${likeEsc(p.q)}%`;
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.original_title LIKE ? ESCAPE '\\')");
    args.push(kw, kw);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function listTitles(p = {}) {
  const { clause, args } = buildWhere(p);
  const order = SORT[p.sort] ?? SORT.popularity;

  const total = db.prepare(`SELECT count(*) AS n FROM titles t ${clause}`).get(...args).n;

  const pageSize = p.pageSize ?? PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(p.page) || 1), pages);

  const items = db
    .prepare(`SELECT ${LIST_COLS} FROM titles t ${clause} ORDER BY ${order}, t.id LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);

  return { items, total, page, pages, pageSize };
}

export function getTitle(id) {
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(id);
  if (!t) return null;
  t.genres = db
    .prepare(`SELECT g.id, g.name FROM title_genres tg
              JOIN genres g ON g.id = tg.genre_id AND g.media_type = ?
              WHERE tg.title_id = ? ORDER BY g.name`)
    .all(t.media_type, t.id);
  t.extra = t.extra ? JSON.parse(t.extra) : null;
  return t;
}

export function getGenres(type) {
  if (type === 'movie' || type === 'tv') {
    return db.prepare('SELECT id, name FROM genres WHERE media_type = ? ORDER BY name').all(type);
  }
  // 全部类型下合并电影/剧集两套，同名取同一 id
  return db.prepare('SELECT min(id) AS id, name FROM genres GROUP BY name ORDER BY name').all();
}

// cn 并入 zh（对应 buildWhere 的 lang 处理），按数量取前 18 种语言
export function getLanguages() {
  return db.prepare(`SELECT CASE WHEN original_language = 'cn' THEN 'zh' ELSE original_language END AS code
    FROM titles WHERE original_language IS NOT NULL AND original_language != ''
    GROUP BY code ORDER BY count(*) DESC LIMIT 18`).all();
}

export function getFavorites(status) {
  const clause = status ? 'WHERE f.status = ?' : '';
  const args = status ? [status] : [];
  return db
    .prepare(`SELECT ${LIST_COLS}, f.status, f.rating, f.note, f.updated_at
              FROM favorites f JOIN titles t ON t.id = f.title_id ${clause}
              ORDER BY f.updated_at DESC`)
    .all(...args);
}

export function getFavorite(titleId) {
  return db.prepare('SELECT * FROM favorites WHERE title_id = ?').get(titleId) ?? null;
}

export function setFavorite(titleId, status, rating, note) {
  const ts = now();
  db.prepare(`INSERT INTO favorites (title_id, status, rating, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(title_id) DO UPDATE SET
      status = excluded.status, rating = excluded.rating,
      note = excluded.note, updated_at = excluded.updated_at`)
    .run(titleId, status, rating, note, ts, ts);
}

export function removeFavorite(titleId) {
  db.prepare('DELETE FROM favorites WHERE title_id = ?').run(titleId);
}
