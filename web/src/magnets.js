// 磁力探测结论的落库缓存：列表页的 🧲 标记只读 magnet_count，写入入口只此一处。
// providers/ 保持无 DB 依赖，scraper 只管排期与预算。
import { db, now } from './db.js';
import { config } from './config.js';
import { searchMagnets } from './providers/index.js';

const saveMagnets = db.prepare('UPDATE titles SET magnet_count = ?, magnet_checked_at = ? WHERE id = ?');
// 上游不可达时拿到的是空结果，不能把这种 0 锁进缓存：只把时间戳拨到「明天到期」，保留上次结论等重试
const deferMagnets = db.prepare('UPDATE titles SET magnet_checked_at = ? WHERE id = ?');

export async function checkMagnets(t) {
  const r = await searchMagnets(t);
  try {
    if (r.live) saveMagnets.run(r.items.length, now(), t.id);
    else deferMagnets.run(new Date(Date.now() - Math.max(1, config.magnetTtlDays - 1) * 86400_000).toISOString(), t.id);
  } catch (e) {
    // 跨进程写竞争（SQLITE_BUSY）不应影响本次结果返回
    console.warn(`[magnets] 缓存写入失败 ${t.id}: ${e.message}`);
  }
  return r;
}
