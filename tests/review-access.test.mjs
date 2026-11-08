import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

async function fixture(t, env) {
  const server = createApp({ env });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const password = 'test-review-password-not-real';
const auth = p => `Basic ${Buffer.from(`reviewer:${p}`).toString('base64')}`;

test('配置评审访问后未认证无法查看页面或调用付费接口', async t => {
  const base = await fixture(t, { REVIEW_PASSWORD: password });
  const page = await fetch(base);
  assert.equal(page.status, 401);
  assert.match(page.headers.get('www-authenticate'), /Basic/);
  const response = await fetch(base + '/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'ifind' }) });
  assert.equal(response.status, 401);
  assert.equal((await fetch(base, { headers: { Authorization: auth('wrong') } })).status, 401);
});
test('正确评审账号可操作页面，健康检查不泄露凭证', async t => {
  const base = await fixture(t, { NODE_ENV: 'production', REVIEW_PASSWORD: password, LLM_API_KEY: 'fake-provider-key', LLM_MODEL: 'demo' });
  assert.equal((await fetch(base, { headers: { Authorization: auth(password) } })).status, 200);
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  const text = await health.text();
  assert.ok(!text.includes(password));
  assert.ok(!text.includes('fake-provider-key'));
});
test('生产使用付费凭证但没配置评审保护时拒绝业务访问', async t => {
  const base = await fixture(t, { NODE_ENV: 'production', LLM_API_KEY: 'fake-provider-key', LLM_MODEL: 'demo' });
  const res = await fetch(base);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'ACCESS_CONFIG');
});
test('过短评审口令不悄悄降级成公开站点', async t => {
  const base = await fixture(t, { REVIEW_PASSWORD: 'short' });
  assert.equal((await fetch(base)).status, 503);
});
