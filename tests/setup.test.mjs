import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createSetupServer, validateDeepSeekKey } from '../scripts/setup-model.mjs';
import { withLocalModelConfig } from '../lib/local-config.mjs';

const testKey = 'test-placeholder-for-mock-only-1234567890';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stock-lens-setup-test-'));
  const configPath = path.join(root, 'private/model.json');
  const server = createSetupServer({ configPath, validate: async key => {
    assert.equal(key, testKey);
    return { LLM_API_KEY: key, LLM_MODEL: 'deepseek-flash', LLM_BASE_URL: 'https://api.deepseek.com' };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/status')).json();
  const submit = (body = { key: testKey }, headers = {}) => fetch(base + '/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Setup-CSRF': state.csrf, ...headers }, body: JSON.stringify(body),
  });
  return { base, state, submit, configPath, root };
}

test('本机配置受跨站和令牌保护，未知Host拒绝', async t => {
  const { base, submit } = await fixture(t);
  assert.equal((await submit(undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await submit(undefined, { 'X-Setup-CSRF': 'invalid' })).status, 403);
  // Node fetch normalizes Host, so use http.get to actually send an invalid Host.
  const status = await new Promise((resolve, reject) => {
    const request = http.get(base + '/status', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});
test('保存后权限0600，状态接口不回显密钥，替换需明确确认', async t => {
  const { base, submit, configPath } = await fixture(t);
  const response = await submit();
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(testKey));
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).LLM_MODEL, 'deepseek-flash');
  const state = await (await fetch(base + '/status')).text();
  assert.ok(!state.includes(testKey));
  assert.equal(JSON.parse(state).configured, true);
  assert.equal((await submit()).status, 409);
  assert.equal((await submit({ key: testKey, replace: true })).status, 200);
});
test('私有配置不受静态路径访问，页面脚本可用', async t => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/setup.js')).status, 200);
  assert.equal((await fetch(base + '/tokens.css')).status, 200);
  assert.equal((await fetch(base + '/model.json')).status, 404);
  assert.equal((await fetch(base + '/.local/model.json')).status, 404);
});
test('配置读取优先环境变量，生产模式不加载本机凭证', async t => {
  const { submit, configPath } = await fixture(t);
  await submit();
  assert.equal(withLocalModelConfig({}, configPath).LLM_MODEL, 'deepseek-flash');
  const env = { NODE_ENV: 'production' };
  assert.deepEqual(withLocalModelConfig(env, configPath), env);
  assert.equal(withLocalModelConfig({ LLM_API_KEY: 'deployment-key' }, configPath).LLM_API_KEY, 'deployment-key');
  await writeFile(configPath, '{broken');
  assert.deepEqual(withLocalModelConfig({}, configPath), {});
});
test('DeepSeek验证仅使用官方模型列表，不运行推理', async () => {
  let requested;
  const result = await validateDeepSeekKey(testKey, { fetchImpl: async (url, options) => {
    requested = url;
    assert.equal(options.headers.Authorization, `Bearer ${testKey}`);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
  } });
  assert.equal(requested, 'https://api.deepseek.com/models');
  assert.equal(result.LLM_MODEL, 'deepseek-flash');
});
test('无效或未经支持的模型明确报错，异常不回显上游文本', async () => {
  await assert.rejects(() => validateDeepSeekKey('bad'), /密钥格式/);
  await assert.rejects(() => validateDeepSeekKey(testKey, { fetchImpl: async () => new Response('sensitive', { status: 401 }) }), e => e.status === 401 && !e.message.includes('sensitive'));
  await assert.rejects(() => validateDeepSeekKey(testKey, { fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'unknown' }] })) }), e => e.status === 422);
});
