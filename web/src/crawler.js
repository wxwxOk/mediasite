// DHT 爬虫控制台的数据层。
// mediasite 与宿主机的 crawler-agent 只通过 data/ 下的两个 JSON 交换状态，
// 因此站点不需要任何 Docker 权限，也不新增监听端口：
//   crawler.json       —— 本模块写（用户意图），agent 只读
//   crawler-state.json —— agent 写（实际状态），本模块只读
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const DESIRED = join(config.dataDir, 'crawler.json');
const STATE = join(config.dataDir, 'crawler-state.json');

export const MODES = ['auto', 'on', 'off'];
export const PRESETS = ['low', 'mid', 'high'];
export const DEFAULTS = {
  mode: 'auto',
  preset: 'mid',
  schedule: { enabled: true, start: '01:00', end: '08:00' },
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 临时文件 + rename，避免 agent 读到写了一半的 JSON
async function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, file);
}

export const readDesired = () => readJson(DESIRED, DEFAULTS);
export const readState = () => readJson(STATE, null);
export const writeDesired = (d) => writeJson(DESIRED, d);

// 表单值一律白名单校验后回落默认：非法输入不该写坏控制文件，也不值得报错
export function normalize(body = {}) {
  return {
    mode: MODES.includes(body.mode) ? body.mode : DEFAULTS.mode,
    preset: PRESETS.includes(body.preset) ? body.preset : DEFAULTS.preset,
    schedule: {
      enabled: body.scheduleEnabled === '1',
      start: HM.test(body.start) ? body.start : DEFAULTS.schedule.start,
      end: HM.test(body.end) ? body.end : DEFAULTS.schedule.end,
    },
    updatedAt: new Date().toISOString(),
  };
}

// agent 每 2s 刷一次状态；超过 30s 说明它挂了，页面上的改动不会生效
export const agentAlive = (state) =>
  !!state && Date.now() - Date.parse(state.agentAt ?? 0) < 30_000;
