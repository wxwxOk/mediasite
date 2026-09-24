import Fastify from 'fastify';
import { config } from './config.js';
import { runSync } from './scraper.js';
import routes from './routes.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(routes);

// 首轮延迟 10s，让 HTTP 先可用；失败则 5 分钟后重试，而非干等一整个周期
const RETRY_MS = 5 * 60_000;
const CYCLE_MS = config.syncIntervalH * 3600_000;

async function tick(delay) {
  await new Promise((r) => setTimeout(r, delay));
  let next = CYCLE_MS;
  try {
    await runSync();
  } catch (e) {
    app.log.error(e, 'sync failed, retrying in 5min');
    next = RETRY_MS;
  }
  void tick(next);
}

void tick(10_000);

await app.listen({ port: config.port, host: '0.0.0.0' });
