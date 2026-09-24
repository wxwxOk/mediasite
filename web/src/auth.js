import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const COOKIE = 'ms_auth';
const TTL_MS = 30 * 24 * 3600_000;

const secret = config.siteSecret || randomBytes(32).toString('hex');
export const authEnabled = () => Boolean(config.sitePassword);
export const secretIsEphemeral = () => !config.siteSecret;

if (authEnabled() && secretIsEphemeral()) {
  console.warn('[auth] SITE_SECRET 未设置，已随机生成：重启后既有会话全部失效');
}

const mac = (s) => createHmac('sha256', secret).update(s).digest();

export function issue() {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${mac(exp).toString('base64url')}`;
}

export function verify(token) {
  if (typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const exp = token.slice(0, i);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const got = Buffer.from(token.slice(i + 1), 'base64url');
  const want = mac(exp);
  return got.length === want.length && timingSafeEqual(got, want);
}

// 先 HMAC 再比较，使两侧等长，避免长度侧信道
export function checkPassword(input) {
  if (!authEnabled()) return false;
  return timingSafeEqual(mac(String(input ?? '')), mac(config.sitePassword));
}
