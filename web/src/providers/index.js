import { search as bitmagnet } from './bitmagnet.js';
import { search as prowlarr } from './prowlarr.js';
import { relevant } from './relevance.js';

const RES_RANK = { 2160: 4, 1080: 3, 720: 2, 480: 1 };

const sizeText = (b) =>
  b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;

// 分辨率归一（'2160'/'1080'/'720'/'480'）：画质字段常为空（种子解析不出），发布名里同样带一份。
// 显式分辨率优先且画质字段排在前；4K/UHD 只作兜底——"1080p ... UHD Blu-ray" 说的是片源而非分辨率
const resOf = (r) => {
  const s = `${r.quality ?? ''} ${r.title ?? ''}`.toLowerCase();
  const m = /(2160|1080|720|480)[pi]/.exec(s);
  if (m) return m[1];
  return /\b(?:4k|uhd|2160)\b/.test(s) ? '2160' : '';
};

// 中文字幕只在发布名里写着（任何元数据源都不带），实测约 1/3 的资源能确认，其余是"看不出"而非"没有"。
// 只认点名了语言/字形的写法；GB 不能用——既是 BIG5 简写又是体积单位（实测命中全是 "3.53 GB"）
const ZH_SUB = /中文字幕|中字|中英|英中|简繁|繁简|简英|繁英|简中|中简|繁中|中繁|(?:国语|国配|粤语|双语)字幕|双字|(?<![a-z])(?:chs|cht|zht|zhs|big5)(?![a-z])/i;

// 剧集的季同样只在发布名里：S01 / S01E05 / Season 1 / 第2季 / 2季。
// 跨季范围（S01-S07、1-8季）与"全集"整包归合集，认不出的单列，都不能按某一季混进去
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const cnNum = (s) => {
  if (/^\d+$/.test(s)) return Number(s);
  const [a, b] = s.split('十');
  if (b === undefined) return CN_NUM[a] ?? NaN;
  return (a === '' ? 1 : CN_NUM[a] ?? 0) * 10 + (b === '' ? 0 : CN_NUM[b] ?? 0);
};

// 西里尔/波兰语的"季"在这批资源里成规模出现（сезон 1、Sezon 11），一并认
const SEASON_WORD = 'season|sezon|сезон|saison|staffel';
const SPAN = new RegExp(`(?<![a-z0-9])s\\d{1,2}[ ._-]*(?:-|~|–|to)[ ._-]*s?\\d{1,2}(?![a-z0-9])|(?:${SEASON_WORD})[ ._-]?\\d{1,2}[ ._-]*(?:-|~|–|to)[ ._-]*\\d{1,2}|(?:第)?[一二三四五六七八九十\\d]{1,3}\\s*[-~–至]\\s*(?:第)?[一二三四五六七八九十\\d]{1,3}[季部]`, 'i');
const ONE = new RegExp(`(?<![a-z0-9])s(\\d{1,2})(?:e\\d{1,4})?|(?:${SEASON_WORD})[ ._-]?(\\d{1,2})|第([一二三四五六七八九十\\d]{1,3})[季部]|(?<![\\d])(\\d{1,2})季`, 'i');

const seasonOf = (title) => {
  if (/complete|全集|全季|合集/i.test(title)) return { pack: true };
  if (SPAN.test(title)) return { pack: true };
  const m = ONE.exec(title);
  const n = m ? cnNum(m[1] ?? m[2] ?? m[3] ?? m[4]) : NaN;
  return n >= 1 && n <= 40 ? { season: n } : null;
};

export async function searchMagnets(t) {
  const args = {
    title: t.title,
    originalTitle: t.original_title,
    year: t.release_year,
    tmdbId: t.tmdb_id,
    mediaType: t.media_type,
  };

  // 单个 provider 失败不影响整体
  const [bm, pl] = await Promise.allSettled([bitmagnet(args), prowlarr(args)]);
  // live = 主索引 bitmagnet 给了答复。全挂时的空结果与「确实没有」无法区分，调用方据此决定是否落缓存
  const live = Array.isArray(bm.value);

  // 同一 infoHash 归一：保留做种更多的一条，来源并列
  const merged = new Map();
  for (const r of [...(bm.value ?? []), ...(pl.value ?? [])]) {
    const prev = merged.get(r.infoHash);
    if (!prev) {
      merged.set(r.infoHash, { ...r, sources: [r.source] });
      continue;
    }
    if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
    if ((r.seeders ?? -1) > (prev.seeders ?? -1)) {
      prev.seeders = r.seeders;
      prev.leechers = r.leechers;
    }
    prev.exact = prev.exact || r.exact;
    if (!prev.quality && r.quality) prev.quality = r.quality;
  }

  // 全文检索的同名噪声（续集、衍生剧、花絮、成人内容）在合并后统一剔除
  const all = [...merged.values()];
  const items = all
    .filter((r) => relevant(r.title, t, r.exact))
    .map((r) => {
      const s = t.media_type === 'movie' ? null : seasonOf(r.title);
      return { ...r, res: resOf(r), sub: ZH_SUB.test(r.title), season: s?.season ?? null, pack: !!s?.pack };
    });

  return {
    filtered: all.length - items.length,
    live,
    items: items
      .sort((a, b) =>
        (Number(b.exact) - Number(a.exact)) ||
        ((b.seeders ?? -1) - (a.seeders ?? -1)) ||
        ((RES_RANK[b.res] ?? 0) - (RES_RANK[a.res] ?? 0)) ||
        String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))
      .map((r) => ({ ...r, sizeText: sizeText(r.size) })),
  };
}
