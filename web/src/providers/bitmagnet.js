import { config } from '../config.js';

const LIMIT = 100;

const QUERY = `query ($q: String!) {
  torrentContent { search(input: { queryString: $q, limit: ${LIMIT} }) {
    totalCount
    items {
      infoHash title seeders leechers videoResolution videoSource videoCodec releaseGroup publishedAt
      torrent { size magnetUri }
      content { source id }
    }
  } }
}`;

export async function search({ title, originalTitle, year, tmdbId }) {
  // 中文标题在 DHT 的发布名里几乎不出现，优先用原名；两者不同则都查一遍再合并
  const terms = [...new Set([originalTitle, title].filter(Boolean))];
  const out = new Map();
  if (!terms.length) return [];

  let ok = 0;
  for (const term of terms) {
    const q = [term, year].filter(Boolean).join(' ');
    let res;
    try {
      res = await fetch(`${config.bitmagnetUrl}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { q } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      continue; // 该词失败；整体是否可达由 ok 决定
    }
    if (!res.ok) continue;

    const body = await res.json().catch(() => null);
    if (!body) continue;
    ok++;
    for (const it of body.data?.torrentContent?.search?.items ?? []) {
      if (!it.infoHash || out.has(it.infoHash)) continue;
      const hit = it.content?.source === 'tmdb' && String(it.content.id) === String(tmdbId);
      out.set(it.infoHash, {
        infoHash: it.infoHash,
        title: it.title,
        size: it.torrent?.size ?? null,
        seeders: it.seeders ?? null,
        leechers: it.leechers ?? null,
        quality: [it.videoResolution?.replace(/^V/, ''), it.videoSource, it.videoCodec, it.releaseGroup]
          .filter(Boolean).join(' '),
        publishedAt: it.publishedAt ?? null,
        magnet: it.torrent?.magnetUri ?? null,
        source: 'bitmagnet',
        exact: hit,
      });
    }
  }
  // null = 上游不可达，[] = 确实没有：调用方靠这个区分，否则会把故障当成「没有资源」写进缓存
  return ok ? [...out.values()] : null;
}
