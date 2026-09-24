import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, 'mediasite.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS titles (
  id                INTEGER PRIMARY KEY,
  tmdb_id           INTEGER NOT NULL,
  media_type        TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
  title             TEXT    NOT NULL,
  original_title    TEXT,
  overview          TEXT,
  poster_path       TEXT,
  backdrop_path     TEXT,
  release_date      TEXT,
  release_year      INTEGER,
  vote_average      REAL    NOT NULL DEFAULT 0,
  vote_count        INTEGER NOT NULL DEFAULT 0,
  popularity        REAL    NOT NULL DEFAULT 0,
  original_language TEXT,
  origin_country    TEXT,
  genre_ids         TEXT,
  extra             TEXT,
  detail_fetched_at TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  UNIQUE(tmdb_id, media_type)
);
CREATE INDEX IF NOT EXISTS ix_titles_type_pop ON titles(media_type, popularity DESC);
CREATE INDEX IF NOT EXISTS ix_titles_year     ON titles(release_year);
CREATE INDEX IF NOT EXISTS ix_titles_vote     ON titles(vote_average DESC, vote_count DESC);
CREATE INDEX IF NOT EXISTS ix_titles_pending  ON titles(detail_fetched_at) WHERE detail_fetched_at IS NULL;

CREATE TABLE IF NOT EXISTS genres (
  id         INTEGER NOT NULL,
  media_type TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  PRIMARY KEY (id, media_type)
);

CREATE TABLE IF NOT EXISTS title_genres (
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL,
  PRIMARY KEY (title_id, genre_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_tg_genre ON title_genres(genre_id);

CREATE TABLE IF NOT EXISTS favorites (
  title_id   INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL CHECK (status IN ('want','watching','done')),
  rating     INTEGER,
  note       TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fav_status ON favorites(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

// 评分列迁移：新库建表后、旧库启动时统一走 ALTER，避免两处 DDL 不一致
// douban_fetched_at 是豆瓣「详情页实时抓取」的缓存时间戳，与 RT 批量抓取的 rating_fetched_at 分开
const titleCols = new Set(db.prepare('PRAGMA table_info(titles)').all().map((c) => c.name));
for (const [name, type] of [
  ['douban_rating', 'REAL'], ['douban_votes', 'INTEGER'], ['douban_id', 'TEXT'], ['douban_fetched_at', 'TEXT'],
  ['rt_critics', 'INTEGER'], ['rt_audience', 'INTEGER'], ['rt_vanity', 'TEXT'],
  ['rating_fetched_at', 'TEXT'],
  ['magnet_count', 'INTEGER'], ['magnet_checked_at', 'TEXT'],
]) {
  if (!titleCols.has(name)) db.exec(`ALTER TABLE titles ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS ix_titles_rating ON titles(rating_fetched_at)');
// 索引必须建在 ALTER 之后：旧库先建会 no such column
db.exec('CREATE INDEX IF NOT EXISTS ix_titles_magnet ON titles(magnet_checked_at)');

export const now = () => new Date().toISOString();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
);

export const getMeta = (k) => getMetaStmt.get(k)?.v ?? null;
export const setMeta = (k, v) => setMetaStmt.run(k, String(v));
