// 发布名相关性过滤：bitmagnet 是全文检索，同名续集、衍生剧、预告花絮、成人内容都会命中
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/\p{M}+/gu, '')
  .replace(/['’`´]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const JUNK_EN = new Set(['trailer', 'teaser', 'featurette', 'sample', 'interview', 'soundtrack', 'ost', 'deleted', 'porn', 'parody', 'xxx', 'hentai']);
const JUNK_ZH = ['预告', '花絮', '抢先', '片段', '成人', '无码', '中出', '淫'];
// 成人内容常把片名当诱饵挂在后面（"【明星淫梦】…复仇者联盟…"），全名扫描
const HARD = ['porn', 'xxx', 'hentai', '无码', '中出', '爆操', '淫梦'];

const isJunk = (after) =>
  after.split(' ').some((w) => JUNK_EN.has(w)) || JUNK_ZH.some((w) => after.includes(w));

// 标题后的常见形态词（带数字的形态另由"含数字"放行）
const FORM = new Set([
  'complete', 'season', 'seasons', 'series', 'episode', 'episodes', 'finale', 'special',
  'web', 'webrip', 'webdl', 'bluray', 'bdrip', 'brrip', 'dvdrip', 'hdtv', 'hdrip', 'uhd', 'remux',
  'hdr', 'dv', 'dolby', 'vision', 'dsnp', 'amzn', 'nf', 'atvp', 'itunes', 'ma', 'dvd',
  'aac', 'ac3', 'eac3', 'dts', 'dd', 'ddp', 'truehd', 'atmos', 'flac',
  'hevc', 'avc', 'x264', 'x265', 'h264', 'h265', 'xvid', 'divx', 'av1', 'bit',
  'internal', 'repack', 'proper', 'extended', 'remastered', 'uncut', 'unrated', 'imax', 'matte',
  'multi', 'dual', 'dubbed', 'subbed', 'subs', 'sub', 'eng', 'english', 'chinese', 'mandarin',
  'mkv', 'mp4', 'avi', 'm2ts', 'iso', 'file', 'files', 'disc', 'part',
  'bd', 'hd', 'fhd', 'cam', 'ts', 'tc',
  'us', 'uk', 'ca', 'au',
]);

// 中文标签开头，用于区分"第二季/中字"这类标签与"欧洲喋血篇"这类副标题
const ZH_TAIL = /^(?:第|全|共|完结|中字|中英|中文|简繁|繁英|双语|双字|国语|国粤|国英|英语|粤语|多音|原声|配音|译制|字幕|无字|高清|蓝光|原盘|合集|全集|加长|导演|未删减|修复|重制|压制|剧场|特别|纪念|收藏|系列|版)/;

// 季范围的下一个词（"格蕾 1 2"、"格蕾 1 16季"、"神偷奶爸 1 3BD"）
const RANGE_NEXT = /^\d{1,2}(?:季|集|部|bd|hd|web|dvd|bluray)?$/i;
// 粘连在编号后的画质/音轨/季集标记（"4K"、"2CH"、"2季"），反之即续集编号（"4终局之战"）
const GLUED_OK = /^(?:k|ch|[季集部语]|声道|音轨)/;

// 主标题 + 副标题拆出的子标题：发布名常在中英名之间插字（"蝙蝠侠前传2：黑暗骑士"），
// 或只写副标题（"指环王3 加长版"）；首词只在带季/部编号时单列，避免"蝙蝠侠"这类总前缀泛匹配
const needles = (t) => {
  const all = [...new Set([t.title, t.original_title].filter(Boolean).map(norm).filter(Boolean))];
  const subs = [];
  for (const n of all) {
    const ws = n.split(' ');
    if (ws.length < 2 || !/\p{Script=Han}/u.test(n)) continue;
    ws.forEach((w, i) => {
      if (!(i === 0 ? /\d/.test(w) : /\p{Script=Han}/u.test(w))) return;
      if (w.length > 1) subs.push(w);
    });
  }
  return [...new Set([...all, ...subs])];
};

// 连续词段的首字母缩写（"special victims unit" → svu）
function abbrsOf(n) {
  const ws = n.split(' ');
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    let s = '';
    for (let j = i; j < ws.length; j++) {
      s += ws[j][0];
      if (j > i) out.push(s);
    }
  }
  return out;
}

// 发布名里的年份集合（论坛转帖常带发布日期前缀，取任意一个与上映年吻合即可）
const yearsOf = (body) => new Set([...body.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0])));

// 标题后的第一个实质词（跳过重复出现的标题词与副标题缩写）
function tailWord(after, ns) {
  const words = new Set(ns.flatMap((n) => n.split(' ')));
  const abbr = new Set(ns.flatMap(abbrsOf));
  const toks = after.split(' ').filter(Boolean);
  let i = 0;
  while (i < toks.length && (words.has(toks[i]) || abbr.has(toks[i]))) i++;
  return { w: toks[i] ?? null, next: toks[i + 1] ?? null };
}

const formOk = (w) => {
  if (/\d/.test(w)) return true;                    // S22E05 / 1080p / DDP5.1 / 第二十二季
  const han = /\p{Script=Han}/u.test(w);
  if (!han) return FORM.has(w);                     // 纯拉丁形态词
  if (!/[a-z]/i.test(w)) return ZH_TAIL.test(w);    // 纯中文标签
  // 混合词按开头判断："imax版" ✓ / "纽约篇第二季csi" ✗
  return /\p{Script=Han}/u.test(w[0])
    ? ZH_TAIL.test(w)
    : FORM.has(/^[a-z]+/i.exec(w)[0].toLowerCase());
};

function afterTitle(hay, needle) {
  const pos = hay.indexOf(` ${needle} `);
  if (pos >= 0) return hay.slice(pos + needle.length + 2);
  if (!/\p{Script=Han}/u.test(needle)) return null;
  // 中文标题在发布名里常与前后文粘连（"超感警探S1"），用无边界子串再试
  const re = new RegExp(needle.replace(/ /g, '\\s*'), 'gu');
  let m;
  while ((m = re.exec(hay))) {
    const before = hay[m.index - 1];
    if (!(before && /\p{Script=Han}/u.test(before))) return hay.slice(m.index + m[0].length);
  }
  return null;
}

export function relevant(releaseTitle, t, exact) {
  if (exact) return true;
  const body = norm(releaseTitle);
  if (!body) return false;
  if (HARD.some((w) => body.includes(w))) return false;
  const hay = ` ${body} `;
  const ns = needles(t);
  // 发布年与上映年吻合时放宽：命名写法不同（美版 "Sorcerers Stone" 对 TMDB 英版原名）不算错配
  const ys = t.media_type === 'movie' ? yearsOf(body) : null;
  const yearHit = !!t.release_year && !!ys?.size && [...ys].some((y) => Math.abs(y - t.release_year) <= 1);
  for (const n of ns) {
    const after = afterTitle(hay, n);
    if (after == null || isJunk(after)) continue;
    const { w, next } = tailWord(after, ns);
    if (w == null) return true;                     // 只有片名，无附加信息
    // 独立数字是续集编号（"复仇者联盟 4 终局之战"），季范围（"格蕾 1 2"）除外
    const glued = /^(\d{1,2})([^\d].*)$/.exec(w);
    if ((/^\d{1,2}$/.test(w) && !RANGE_NEXT.test(next ?? '')) || (glued && !GLUED_OK.test(glued[2]))) {
      if (yearHit) return true;
      continue;
    }
    if (formOk(w) || yearHit) return true;
  }
  return false;
}
