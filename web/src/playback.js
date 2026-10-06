// 播放 sidecar 客户端：磁力加种、流决策（直出/HLS 转码）、停止清理。
// sidecar（stremio-libtorrent-server）的 remove/destroy 是 GET（POST 会 405）；remove 只移出 swarm，
// 下载数据留在它自己的缓存目录由淘汰器按预算 LRU 清理，所以停止播放无需关心磁盘删除。
import { config } from './config.js';

const HASH_RE = /^[0-9a-f]{40}$/;

export const isHash = (v) => HASH_RE.test(v);

const fileUrl = (hash, idx) => `${config.streamUrl}/${hash}/${idx}`;

async function sidecar(path, { method = 'GET', body, timeout = 10_000 } = {}) {
  const res = await fetch(`${config.streamUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const e = new Error(`sidecar ${method} ${path} -> ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// 加种并等元数据就绪（sidecar 端约 30s 超时；sources 传空——DHT + 其内建 tracker 表足够，实测秒级）。
// 对已存在的种子幂等立即返回，播放页可放心重复调用
export async function createTorrent(hash) {
  const r = await sidecar(`/${hash}/create`, {
    method: 'POST',
    body: { peerSearch: { sources: [] }, guessFileIdx: {} },
    timeout: 45_000,
  });
  return {
    hash,
    name: r.name ?? '',
    files: (r.files ?? []).map((f, idx) => ({ idx, name: f.name, length: f.length })),
    guessedFileIdx: Number.isInteger(r.guessedFileIdx) ? r.guessedFileIdx : null,
  };
}

// probe 结果只取决于文件本身的编码参数，进程内缓存即可；缓存 Promise 兼作并发去重
const probeCache = new Map();
const PROBE_TTL = 30 * 60_000;

function probe(hash, idx) {
  const key = `${hash}:${idx}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.t < PROBE_TTL) return hit.p;
  const p = sidecar(`/hlsv2/probe?mediaURL=${encodeURIComponent(fileUrl(hash, idx))}`, { timeout: 40_000 })
    .catch((e) => {
      if (probeCache.get(key)?.p === p) probeCache.delete(key); // 失败不缓存，下次重试
      throw e;
    });
  probeCache.set(key, { t: Date.now(), p });
  return p;
}

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);

// 直出判定：浏览器 <video> 原生可解才走直出。mp4/webm 容器 + h264 + 常见音频编码；
// mkv、HEVC、AC3/DTS 等一律进 HLS（sidecar 会先试 remux 直拷，真要重编码才起 VAAPI）
function canDirectPlay(p) {
  if (!/mp4|webm/.test(String(p?.format?.name ?? ''))) return false;
  const streams = p?.streams ?? [];
  const v = streams.find((s) => s.track === 'video');
  const a = streams.find((s) => s.track === 'audio');
  if (!v || v.codec !== 'h264' || v.isHdr) return false;
  return !a || DIRECT_AUDIO.has(a.codec);
}

// 输出 URL 一律是 mediasite 自己的 /stream 同源代理路径（SITE_PASSWORD 钩子内），sidecar 端口不暴露。
// force='hls' 供前端在直出播放失败时回退（判定只看编码参数，同一文件结果稳定，靠 force 打破）。
// probe 失败（新加种的数据未到位，sidecar 等 30s 会 504）不阻断：先给直出，浏览器放不了由页面自动回退 HLS。
// hevc=前端上报的设备能力：支持时声明 hevc 并放开 maxWidth，HEVC 源零转码 remux 由设备硬解
// （4K 资源几乎全是 HEVC，本机软解 4K 10bit 远达不到实时，转码必卡——直拷是唯一可行路）
export async function decide(hash, idx, force, hevc) {
  if (force !== 'hls') {
    const p = await probe(hash, idx).catch(() => null);
    if (!p || canDirectPlay(p)) return { mode: 'direct', url: `/stream/${hash}/${idx}` };
  }
  const q = new URLSearchParams({
    mediaURL: fileUrl(hash, idx),
    audioCodecs: 'aac',
    maxAudioChannels: '2',
    maxWidth: String(hevc ? 4096 : config.streamMaxWidth),
  });
  // videoCodecs 是 sidecar 的列表参数（重复键），源编码在列表内才直拷，否则重编码；
  // 不带 hevc 时退化为最小公分母 h264（浏览器 <video> 与 iOS 原生 HLS 都稳吃 h264+aac）
  q.append('videoCodecs', 'h264');
  if (hevc) q.append('videoCodecs', 'hevc');
  return { mode: 'hls', url: `/stream/hlsv2/${hash}-${idx}/master.m3u8?${q}` };
}

export async function stats(hash, idx) {
  return sidecar(`/${hash}/${idx}/stats.json`, { timeout: 10_000 });
}

// 停止播放：移出 swarm + 销毁转码任务。都是尽力而为——失败也有 sidecar 的空闲回收兜底，不影响用户
export async function stop(hash, idx) {
  await fetch(`${config.streamUrl}/${hash}/remove`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  if (Number.isInteger(idx)) {
    await fetch(`${config.streamUrl}/hlsv2/${hash}-${idx}/destroy`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
}
