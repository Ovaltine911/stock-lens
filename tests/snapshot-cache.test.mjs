import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotCache } from '../lib/snapshot-cache.mjs';

test('缓存同一市场快照，返回深拷贝且不修改上游时点', async () => {
  let calls = 0, t = Date.parse('2026-11-08T12:00:00Z');
  const cache = createSnapshotCache({ now: () => t, load: async mode => { calls++; return { mode, asOf: '2026-11-06', stocks: [{ metrics: { pe: 10 } }] }; } });
  const a = await cache.get('auto'); a.stocks[0].metrics.pe = 999; t += 2000;
  const b = await cache.get('auto');
  assert.equal(calls, 1); assert.equal(a.cached, false); assert.equal(b.cached, true); assert.equal(b.cacheAgeSeconds, 2);
  assert.equal(b.stocks[0].metrics.pe, 10); assert.equal(b.asOf, '2026-11-06');
});
test('并发相同请求只有一次上游调用', async () => {
  let calls = 0;
  const cache = createSnapshotCache({ load: async mode => { calls++; await new Promise(r => setTimeout(r, 10)); return { mode }; } });
  const results = await Promise.all([cache.get('auto'), cache.get('auto'), cache.get('auto')]);
  assert.equal(calls, 1); assert.equal(results.filter(r => !r.cached).length, 1);
});
test('失败不缓存为成功，下次可重试', async () => {
  let calls = 0;
  const cache = createSnapshotCache({ load: async mode => { if (++calls === 1) throw new Error('unavailable'); return { mode }; } });
  await assert.rejects(() => cache.get('auto'));
  assert.equal((await cache.get('auto')).cached, false); assert.equal(calls, 2);
});
test('过期与跨上海自然日不复用缓存，模式严格隔离', async () => {
  let calls = 0, t = Date.parse('2026-11-08T15:59:59Z');
  const cache = createSnapshotCache({ now: () => t, ttlMs: 10000, load: async mode => ({ mode, calls: ++calls }) });
  await cache.get('auto'); t += 2000; assert.equal((await cache.get('auto')).cached, false);
  await cache.get('demo'); assert.equal(calls, 3);
  t += 11000; await cache.get('auto'); assert.equal(calls, 4);
});
