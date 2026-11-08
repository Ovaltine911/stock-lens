import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { loadSnapshot } from '../lib/data.mjs';

async function runApp(t, opts = {}) {
  const server = createApp({ env: {}, ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, options = {}) => {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { base, request };
}
const condition = (value = 20) => ({ id: 'c1', metric: 'pe_ttm', op: 'lt', value, origin: '用户编辑' });

test('服务健康检查不暴露凭证，静态目录不暴露环境文件', async t => {
  const { base, request } = await runApp(t, { env: { LLM_API_KEY: 'test-secret-only', LLM_MODEL: 'model', FUYAO_API_KEY: 'data-secret-only' } });
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.model.configured, true);
  assert.ok(!JSON.stringify(health.body).includes('secret'));
  for (const target of ['/.env', '/server.mjs', '/%2eenv', '/lib/data.mjs']) assert.equal((await fetch(base + target)).status, 404);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /选股有据/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('真实主链路：解析、合成快照、确认筛选、证据、同快照对比', async t => {
  const { request } = await runApp(t);
  const parsed = await request('/api/interpret', { text: '市盈率小于20' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.mode, 'rules');
  const data = await request('/api/snapshot', { mode: 'demo' });
  assert.equal(data.status, 200);
  assert.equal(data.body.stocks.length, 12);
  const screened = await request('/api/screen', { snapshotId: data.body.id, conditions: parsed.body.conditions, confirmed: true });
  assert.equal(screened.status, 200);
  assert.equal(screened.body.counts.total, 12);
  assert.ok(screened.body.counts.pass > 0 && screened.body.counts.fail > 0 && screened.body.counts.unknown > 0);
  assert.ok(screened.body.rows.every(row => row.checks[0].evidence.source));
  const diff = await request('/api/screen', { snapshotId: data.body.id, conditions: [condition(30)], baselineConditions: parsed.body.conditions, confirmed: true });
  assert.equal(diff.status, 200);
  assert.ok(diff.body.diff.added.length > 0);
  assert.equal(diff.body.diff.removed.length, 0);
});
test('模糊意图的年化波动率指标在合成快照上不是全未知', async t => {
  const { request } = await runApp(t);
  const parsed = await request('/api/interpret', { text: '经营改善、估值合理、走势稳定' });
  assert.equal(parsed.status, 200);
  assert.ok(parsed.body.clarifications.length >= 3);
  assert.equal(parsed.body.conditions.length, 5);
  const data = await request('/api/snapshot', { mode: 'demo' });
  const screened = await request('/api/screen', { snapshotId: data.body.id, conditions: parsed.body.conditions, confirmed: true });
  assert.equal(screened.status, 200);
  assert.ok(screened.body.counts.pass > 0, '完整模糊示例应存在通过样本，避免跨模块period不匹配');
});
test('确认、冲突、空条件和伪造快照都有明确错误', async t => {
  const { request } = await runApp(t);
  const data = await request('/api/snapshot', { mode: 'demo' });
  const base = { snapshotId: data.body.id, conditions: [condition()], confirmed: true };
  assert.equal((await request('/api/screen', { ...base, confirmed: false })).status, 422);
  assert.equal((await request('/api/screen', { ...base, conditions: [] })).status, 422);
  const conflict = await request('/api/screen', { ...base, conditions: [condition(10), { ...condition(30), id: 'c2', op: 'gt' }] });
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.error.code, 'CONFLICT');
  assert.ok(conflict.body.conflicts.length);
  assert.equal((await request('/api/screen', { ...base, snapshotId: 'nonexistent' })).status, 410);
});
test('快照到期明确拒绝，不悄悄换数据后计算', async t => {
  let time = 1000;
  const { request } = await runApp(t, { now: () => time, cacheTtlMs: 50 });
  const data = await request('/api/snapshot', { mode: 'demo' });
  time += 51;
  assert.equal((await request('/api/screen', { snapshotId: data.body.id, conditions: [condition()], confirmed: true })).status, 410);
});
test('来源调用失败不降级为demo；未知异常不暴露原文', async t => {
  const { request } = await runApp(t, { snapshotLoader: async mode => {
    if (mode === 'demo') return loadSnapshot('demo');
    throw new Error('private-secret-provider-debug');
  } });
  const failed = await request('/api/snapshot', { mode: 'public' });
  assert.equal(failed.status, 500);
  assert.ok(!JSON.stringify(failed.body).includes('private-secret'));
  assert.equal(failed.body.stocks, undefined);
});
test('没有扶摇凭证时诚实报错，禁止跨站请求', async t => {
  const { request } = await runApp(t);
  const failed = await request('/api/snapshot', { mode: 'fuyao' });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error.message, /未配置/);
  assert.equal((await request('/api/interpret', { text: '市盈率小于20' }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })).status, 403);
});
test('非法JSON与大请求有界处理', async t => {
  const { base } = await runApp(t);
  assert.equal((await fetch(base + '/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(40_000) }) })).status, 413);
});
test('速率上限保护模型与数据服务', async t => {
  const { request } = await runApp(t, { rateLimit: 1 });
  assert.equal((await request('/api/interpret', { text: '市盈率小于20' })).status, 200);
  assert.equal((await request('/api/interpret', { text: '市盈率小于20' })).status, 429);
});
