import { config } from './config.js';

const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/';

// 实测 TMDB 不返回 x-ratelimit-* 响应头，只能自行保守控速
let gate = Promise.resolve();
let lastAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle() {
  gate = gate.then(async () => {
    const wait = lastAt + 1000 / config.tmdbRps - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  });
  return gate;
}

export async function tmdb(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('language', 'zh-CN');
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }

  const headers = { accept: 'application/json' };
  if (config.tmdbToken) headers.authorization = `Bearer ${config.tmdbToken}`;
  else url.searchParams.set('api_key', config.tmdbKey);

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await sleep(Math.min(2 ** attempt * 400, 8000));
    await throttle();

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      lastErr = e; // 网络错误可重试
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`TMDB ${res.status} ${path}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > 0) await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`TMDB ${res.status} ${path}`); // 4xx 不重试
  }
  throw lastErr;
}

export const posterUrl = (path, size = 'w500') => (path ? `${IMG_BASE}${size}${path}` : null);
