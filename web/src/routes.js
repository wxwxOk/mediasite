import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { config } from './config.js';
import { db, now } from './db.js';
import { doubanRating } from './ratings.js';
import { COOKIE, authEnabled, checkPassword, issue, verify } from './auth.js';
import {
  listTitles, listTop250, getTitle, getGenres, getLanguages, getFavorites, getFavorite,
  setFavorite, removeFavorite,
} from './queries.js';
import { browsePage, top250Page, detailPage, favoritesPage, loginPage, crawlerPage } from './views/pages.js';
import { checkMagnets } from './magnets.js';
import { setAuthEnabled } from './views/layout.js';
import { readDesired, readState, writeDesired, normalize, agentAlive } from './crawler.js';

const IMG_BASE = 'https://image.tmdb.org/t/p/';
const SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original']);
const CACHE = 'public, max-age=604800, immutable';
const inflight = new Map(); // 并发去重：同一张图只向上游取一次

// 豆瓣评分：详情页打开时实时抓取（低频 + DB 缓存 + 并发去重），不做后台批量，避免触发豆瓣风控
const doubanGet = db.prepare(`
  SELECT title, original_title, release_year, media_type,
    douban_rating, douban_votes, douban_id, douban_fetched_at
  FROM titles WHERE id = ?`);
const doubanSave = db.prepare(
  'UPDATE titles SET douban_rating=?, douban_votes=?, douban_id=?, douban_fetched_at=? WHERE id=?'
);
const doubanInflight = new Map();

const ctype = (f) => (f.endsWith('.png') ? 'image/png' : f.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg');
const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
// checkbox 同名参数在 fastify 下可能是数组，统一归并成数组
const many = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((s) => String(s).trim()).filter(Boolean);

// Fastify 对字符串默认回 text/plain，页面必须显式标类型，否则浏览器直接显示源码
const html = (reply, body) => reply.type('text/html; charset=utf-8').send(body);

// 无需登录即可访问：登录页、图片代理、logo、健康检查
const OPEN = (url) =>
  url === '/healthz' || url === '/login' || url === '/tmdb-logo.svg' || url.startsWith('/img/');

export default async function routes(app) {
  await app.register(cookie);
  await app.register(formbody);
  setAuthEnabled(authEnabled());

  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled() || OPEN(req.raw.url)) return;
    if (verify(req.cookies[COOKIE])) return;
    if (req.headers.accept?.includes('text/html')) return reply.redirect('/login');
    return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/healthz', () => ({ ok: true, auth: authEnabled() }));

  app.get('/login', (req, reply) => {
    if (!authEnabled()) return reply.redirect('/');
    return html(reply, loginPage(req.query.e === '1'));
  });

  app.post('/login', (req, reply) => {
    if (!checkPassword(req.body?.password)) return reply.redirect('/login?e=1');
    reply.setCookie(COOKIE, issue(), {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600,
    });
    return reply.redirect('/');
  });

  app.get('/logout', (req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  app.post('/api/favorites/:id', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTitle(id)) return reply.code(404).send({ error: 'title not found' });

    if (req.body?.op === 'remove') removeFavorite(id);
    else {
      const status = ['want', 'watching', 'done'].includes(req.body?.status) ? req.body.status : 'want';
      const r = Number(req.body?.rating);
      setFavorite(id, status, Number.isInteger(r) && r >= 1 && r <= 10 ? r : null, req.body?.note?.slice(0, 500) || null);
    }
    return req.headers.accept?.includes('text/html') ? reply.redirect(`/t/${id}`) : { ok: true };
  });

  app.get('/', (req, reply) => {
    const f = {
      q: pick(req.query.q),
      type: pick(req.query.type),
      genre: many(req.query.genre),
      decade: many(req.query.decade),
      lang: many(req.query.lang),
      minVote: pick(req.query.minVote),
      sort: pick(req.query.sort),
      page: pick(req.query.page) || '1',
    };
    const result = listTitles({ ...f, page: Number(f.page) });
    return html(reply, browsePage({ result, f, genres: getGenres(f.type), langs: getLanguages() }));
  });

  // 豆瓣 Top250 榜单独占一页，不参与筛选/排序，只按名次平铺
  app.get('/top250', (req, reply) => html(reply, top250Page(listTop250())));

  app.get('/t/:id', (req, reply) => {
    const t = getTitle(Number(req.params.id));
    if (!t) return reply.code(404).type('text/html; charset=utf-8').send('404 未找到该条目');
    return html(reply, detailPage(t, getFavorite(t.id)));
  });

  app.get('/favorites', (req, reply) => html(reply, favoritesPage(getFavorites())));

  // 爬虫控制台：只往 data/ 写一个 JSON，由宿主机的 crawler-agent 执行，站点本身无 Docker 权限
  app.get('/crawler', async (req, reply) => {
    const [desired, state] = await Promise.all([readDesired(), readState()]);
    return html(reply, crawlerPage({ desired, state, alive: agentAlive(state) }));
  });

  app.post('/crawler', async (req, reply) => {
    await writeDesired(normalize(req.body));
    return reply.redirect('/crawler');
  });

  app.get('/api/magnets/:id', async (req, reply) => {
    const t = getTitle(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'title not found' });
    // 顺手把结论写进缓存，给列表页的 🧲 标记供数
    const { items, filtered, live } = await checkMagnets(t).catch((e) => {
      req.log.error(e, 'magnet search failed');
      return { items: [], filtered: 0, live: false };
    });
    return { count: items.length, filtered, live, items };
  });

  app.get('/api/douban/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = doubanGet.get(id);
    if (!row) return reply.code(404).send({ error: 'title not found' });

    // 缓存命中即直接返回，含「豆瓣无此条目」的负缓存，周期内不再打豆瓣
    const fresh = new Date(Date.now() - config.ratingRefreshDays * 86400_000).toISOString();
    if (row.douban_fetched_at >= fresh) {
      return { rating: row.douban_rating, votes: row.douban_votes, id: row.douban_id };
    }

    let p = doubanInflight.get(id);
    if (!p) {
      p = doubanRating(row)
        .then((d) => {
          doubanSave.run(d?.rating ?? null, d?.votes ?? null, d?.id ?? null, now(), id);
          return d;
        })
        .finally(() => doubanInflight.delete(id));
      doubanInflight.set(id, p);
    }
    try {
      const d = await p;
      return d ?? { rating: null };
    } catch (e) {
      // 被风控（302）等异常不落缓存，下次打开详情页再试；页面照常渲染
      req.log.warn({ id, err: e.message }, 'douban fetch failed');
      return { rating: null };
    }
  });

  app.get('/tmdb-logo.svg', async (req, reply) => {
    try {
      const svg = await readFile(new URL('./views/tmdb-logo.svg', import.meta.url));
      return reply.type('image/svg+xml').header('cache-control', CACHE).send(svg);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/img/:size/*', async (req, reply) => {
    const { size } = req.params;
    // Fastify 通配参数不含前导斜杠，统一补齐后再校验
    const raw = req.params['*'];
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    if (!SIZES.has(size) || !/^\/[\w.\/-]+$/.test(path) || path.includes('..')) {
      return reply.code(400).send('bad image path');
    }

    const key = `${size}${path}`;
    const file = join(config.dataDir, 'imgcache', size, path.slice(1));

    try {
      return reply.type(ctype(file)).header('cache-control', CACHE).send(await readFile(file));
    } catch { /* 未缓存，回源 */ }

    let p = inflight.get(key);
    if (!p) {
      p = fetch(IMG_BASE + key, { signal: AbortSignal.timeout(20_000) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`upstream ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, buf);
          return { buf, ct: r.headers.get('content-type') ?? 'image/jpeg' };
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }

    try {
      const { buf, ct } = await p;
      return reply.type(ct).header('cache-control', CACHE).send(buf);
    } catch (e) {
      req.log.warn({ key, err: e.message }, 'img fetch failed');
      return reply.code(502).send('image unavailable');
    }
  });
}
