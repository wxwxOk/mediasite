// bitmagnet DHT 爬虫控制 agent —— 宿主机常驻服务（systemd 或直接 node 启动）
//
// 收敛式而非触发器：每 2s 把 bitmagnet-crawler 的实际状态拉回 mediasite 页面写入的期望状态。
// 好处是宿主重启 / 容器崩溃 / 有人手动 docker compose up -d 都能在 2s 内自动纠正。
// 控制通路走文件，mediasite 容器因此不需要任何 Docker 权限，也不新增监听端口。
//
// 需要能免密执行 docker start/stop/restart/inspect：agent 以某个用户身份跑，
// 就把该用户加进 docker 组（或为其配置 sudoers 免密），不要在本脚本里塞密码。
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

// 与 mediasite 容器共享的 data 目录（站点 compose 里挂载的那个卷）
const MEDIA = process.env.MEDIASITE_DATA_DIR ?? '/opt/mediasite/data';
const DESIRED = join(MEDIA, 'crawler.json');      // mediasite 写，本服务只读
const STATE = join(MEDIA, 'crawler-state.json');  // 本服务写，mediasite 只读
const CONFIG = process.env.BITMAGNET_CONFIG ?? '/opt/mediasite/crawler/config/config.yml';
const CONTAINER = process.env.CRAWLER_CONTAINER ?? 'bitmagnet-crawler';
const INTERVAL = 2000;

// 网速采样用的网卡：显式指定优先，否则取默认路由那块。
// 探测不到就整个关闭采样（容器里跑、或 /proc 不可用时），不影响启停控制。
async function resolveIface() {
  if (process.env.NET_IFACE) return process.env.NET_IFACE;
  try {
    const rows = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1);
    const def = rows.map((r) => r.trim().split(/\s+/)).find((c) => c[1] === '00000000');
    return def?.[0] ?? null;
  } catch {
    return null;
  }
}
const IFACE = await resolveIface();

// 档位 → dht_crawler.scaling_factor。10 是 bitmagnet 官方默认值，文档明写超过它收益递减
const PRESETS = { low: 5, mid: 10, high: 40 };
const DEFAULTS = { mode: 'auto', preset: 'mid', schedule: { enabled: true, start: '01:00', end: '08:00' } };

const MODES = new Set(['auto', 'on', 'off']);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// 绝不要依赖宿主的本地时区——服务器普遍是 UTC，那会让"凌晨 01:00"实际落在北京时间上午 9 点。
// 时区在代码里显式声明：谁改 unit 文件、谁换宿主，判定基准都不变。
const TZ = process.env.SCHEDULE_TZ ?? 'Asia/Shanghai';
const BJ = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});
const bjHM = (d = new Date()) => BJ.format(d);
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const inWindow = (hm, s, e) => (s <= e ? hm >= s && hm < e : hm >= s || hm < e);

const SF_RE = /^(\s*scaling_factor:\s*)(\d+)\s*$/m;
const SF_ALL = new RegExp(SF_RE.source, 'gm');

const docker = (...args) => new Promise((resolve, reject) => {
  execFile('docker', args, { timeout: 30_000 }, (e, stdout, stderr) =>
    (e ? reject(new Error((stderr || e.message).trim())) : resolve(stdout.trim())));
});

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 临时文件 + rename，避免 mediasite 读到写了一半的 JSON
async function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, file);
}

// 读当前档位；fix=true 时顺带校准。命中数不是 1 就宁可不动——
// 写坏 bitmagnet 的配置比不降档严重得多。
async function reconcileScalingFactor(want, fix) {
  const src = await readFile(CONFIG, 'utf8');
  const hits = [...src.matchAll(SF_ALL)];
  if (hits.length !== 1) {
    if (fix) throw new Error(`config.yml 中 scaling_factor 命中 ${hits.length} 处，拒绝修改`);
    return { cur: null, changed: false };
  }
  const cur = Number(hits[0][2]);
  if (!fix || cur === want) return { cur, changed: false };

  // 只在首次改动前留一份原始备份，后续不覆盖
  await writeFile(`${CONFIG}.bak-agent`, src, { flag: 'wx' })
    .catch((e) => { if (e.code !== 'EEXIST') throw e; });
  await writeFile(CONFIG, src.replace(SF_RE, `$1${want}`));
  return { cur: want, changed: true };
}

let prevNet = null;
const stat = (name) => readFile(`/sys/class/net/${IFACE}/statistics/${name}`, 'utf8').then(Number);

// 注意：这是整块网卡的速率，包含机器上所有其他流量（Jellyfin 串流等），不是爬虫单独的
async function sampleNet() {
  if (!IFACE) return null;
  const [rb, tb, rp, tp] = await Promise.all(['rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets'].map(stat));
  const cur = { t: Date.now(), rb, tb, rp, tp };
  const p = prevNet;
  prevNet = cur;
  if (!p) return null;

  const dt = (cur.t - p.t) / 1000;
  if (dt <= 0) return null;
  return {
    rxKBs: +((cur.rb - p.rb) / dt / 1000).toFixed(1),
    txKBs: +((cur.tb - p.tb) / dt / 1000).toFixed(1),
    rxPps: Math.round((cur.rp - p.rp) / dt),
    txPps: Math.round((cur.tp - p.tp) / dt),
  };
}

let lastError = null;
let lastRunning = null;

function log(msg) {
  console.log(`[crawler-agent] ${bjHM()} ${msg}`);
}

async function tick() {
  let error = null;
  let running = false;
  let sfNow = null;
  let shouldRun = false;
  let inWin = true;
  let nextChange = null;
  const hm = bjHM();

  const desired = await readJson(DESIRED, DEFAULTS);
  const mode = MODES.has(desired.mode) ? desired.mode : DEFAULTS.mode;
  const preset = Object.hasOwn(PRESETS, desired.preset) ? desired.preset : DEFAULTS.preset;
  const sch = desired.schedule ?? {};
  const start = HM.test(sch.start) ? sch.start : DEFAULTS.schedule.start;
  const end = HM.test(sch.end) ? sch.end : DEFAULTS.schedule.end;

  try {
    inWin = inWindow(hm, start, end);
    shouldRun = mode === 'on' ? true : mode === 'off' ? false : (sch.enabled ? inWin : true);

    if (mode === 'auto' && sch.enabled) {
      const t = shouldRun ? end : start;
      nextChange = `${toMin(t) > toMin(hm) ? '今天' : '明天'} ${t}`;
    }

    // 配置与运行状态是正交的两个维度，都无条件收敛。
    // 先改 config.yml 再决定起停：配置在进程启动时读取，所以窗口到点只需一次 start 即为正确状态；
    // restart 只在「要保持运行 + 配置刚变过」时发生，停着的时候写配置不产生任何重启。
    const { cur, changed } = await reconcileScalingFactor(PRESETS[preset], true);
    sfNow = cur;

    running = (await docker('inspect', '-f', '{{.State.Running}}', CONTAINER)) === 'true';

    if (shouldRun) {
      if (!running) {
        await docker('start', CONTAINER);
        running = true;
        log(`start（档位 ${preset}，scaling_factor=${PRESETS[preset]}）`);
      } else if (changed) {
        await docker('restart', CONTAINER);
        log(`restart → scaling_factor=${PRESETS[preset]}`);
      }
    } else if (running) {
      await docker('stop', CONTAINER);
      running = false;
      log('stop（不在运行时段）');
    }

    if (running !== lastRunning && lastRunning !== null) {
      log(`爬虫${running ? '已运行' : '已停止'}`);
    }
    lastRunning = running;
  } catch (e) {
    error = e.message;
  }

  const net = await sampleNet().catch(() => null);
  await writeJson(STATE, {
    mode, preset, scalingFactor: sfNow, running, inWindow: inWin,
    nextChange, bjTime: hm, tz: TZ, net, agentAt: new Date().toISOString(), error,
  });

  if (error && error !== lastError) console.error('[crawler-agent] 错误:', error);
  lastError = error;
}

let inFlight = false;
async function loop() {
  if (inFlight) return;   // docker 卡住时不要叠轮询
  inFlight = true;
  try {
    await tick();
  } finally {
    inFlight = false;
  }
}

log(`启动，每 ${INTERVAL / 1000}s 一轮（时间表按 ${TZ} 判定；网速采样 ${IFACE ?? '已关闭'}）`);
await loop();
setInterval(loop, INTERVAL);
