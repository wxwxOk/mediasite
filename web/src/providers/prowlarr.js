import { config } from '../config.js';

const hashFromMagnet = (m) => m?.match(/btih:([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? null;

export async function search({ title, year, mediaType }) {
  if (!config.prowlarrKey) return [];

  const url = new URL('/api/v1/search', config.prowlarrUrl);
  url.searchParams.set('query', [title, year].filter(Boolean).join(' '));
  url.searchParams.set('type', mediaType === 'movie' ? 'movie' : 'tvsearch');
  url.searchParams.set('categories', mediaType === 'movie' ? '2000' : '5000');
  url.searchParams.set('indexerIds', '-2'); // -2 = 全部 torrent 索引器

  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-Api-Key': config.prowlarrKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return []; // Prowlarr 未运行：静默降级，不影响 bitmagnet 的结果
  }
  if (!res.ok) return [];

  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const infoHash = r.infoHash?.toLowerCase() ?? hashFromMagnet(r.magnetUrl);
    if (!infoHash) return null;
    return {
      infoHash,
      title: r.title,
      size: r.size ?? null,
      seeders: r.seeders ?? null,
      leechers: r.leechers ?? null,
      quality: [r.quality?.quality?.name, r.quality?.source, r.quality?.resolution]
        .filter(Boolean).join(' '),
      publishedAt: r.publishDate ?? null,
      magnet: r.magnetUrl ?? null,
      source: r.indexer ?? 'prowlarr',
      exact: false,
    };
  }).filter(Boolean);
}
