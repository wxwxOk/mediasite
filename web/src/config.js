const num = (v, d) => (v == null || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8899),
  dataDir: process.env.DATA_DIR ?? '/app/data',

  // TMDB：Bearer Token 为主，v3 API Key 为备用认证路径
  tmdbToken: process.env.TMDB_TOKEN ?? '',
  tmdbKey: process.env.TMDB_KEY ?? '',
  tmdbRps: num(process.env.TMDB_RPS, 8),

  // 0 表示不限制，一次跑完全部待补详情
  detailMaxPerRun: num(process.env.DETAIL_MAX_PER_RUN, 0),

  // 烂番茄批量抓取：每轮上限、刷新周期（天）；豆瓣已改为详情页实时抓取，按 doubanRps 节流
  ratingMaxPerRun: num(process.env.RATING_MAX_PER_RUN, 100),
  ratingRefreshDays: num(process.env.RATING_REFRESH_DAYS, 30),

  // 磁力缓存：每轮后台探测上限、缓存周期（天）。列表标记只读缓存，实时探测在详情页点击
  magnetMaxPerRun: num(process.env.MAGNET_MAX_PER_RUN, 300),
  magnetTtlDays: num(process.env.MAGNET_TTL_DAYS, 30),
  doubanRps: num(process.env.DOUBAN_RPS, 1),
  algoliaRps: num(process.env.ALGOLIA_RPS, 5),

  syncIntervalH: num(process.env.SYNC_INTERVAL_H, 24),
  fullSync: process.env.FULL_SYNC === '1',

  sitePassword: process.env.SITE_PASSWORD ?? '',
  siteSecret: process.env.SITE_SECRET ?? '',

  bitmagnetUrl: process.env.BITMAGNET_URL ?? 'http://host.docker.internal:3333',
  prowlarrUrl: process.env.PROWLARR_URL ?? 'http://host.docker.internal:9696',
  prowlarrKey: process.env.PROWLARR_API_KEY ?? '',

  imgcacheMaxMb: num(process.env.IMGCACHE_MAX_MB, 2048),
};

if (!config.tmdbToken && !config.tmdbKey) {
  throw new Error('缺少 TMDB 凭据：需设置 TMDB_TOKEN（Bearer）或 TMDB_KEY（v3）');
}
