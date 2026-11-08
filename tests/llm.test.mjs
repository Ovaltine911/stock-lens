import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretIntent, validateModelIntent, modelCapabilities } from '../lib/llm.mjs';

const config = { LLM_API_KEY: 'test-only-fake-secret', LLM_MODEL: 'test-model', LLM_BASE_URL: 'https://model.example.test/v1' };
const draft = (overrides = {}) => ({ summary: '市盈率低于 20 倍', conditions: [{ id: 'draft-1', metric: 'pe_ttm', op: 'lt', value: 20, origin: 'PE<20' }], clarifications: [], warnings: [], unsupported: [], blocked: false, ...overrides });
const response = (raw) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }), { status: 200 });

test('未配置模型时明确使用规则，不发起网络请求', async () => {
  const result = await interpretIntent('市盈率小于20', { env: {}, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(result.mode, 'rules');
  assert.equal(result.conditions.length, 1);
  assert.equal(modelCapabilities({}).configured, false);
});
test('合规拦截先于模型调用', async () => {
  const result = await interpretIntent('推荐明天必涨的股票并买入', { env: config, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.conditions, []);
});
test('合法模型草稿校验后返回，密钥仅传往服务端请求头', async () => {
  let calls = 0;
  const result = await interpretIntent('市盈率小于20', { env: config, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://model.example.test/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.temperature, 0);
    assert.equal(body.messages[1].content, '市盈率小于20');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(options.headers.Authorization, `Bearer ${config.LLM_API_KEY}`);
    return response(draft());
  } });
  assert.equal(calls, 1);
  assert.equal(result.mode, 'llm');
  assert.equal(result.conditions[0].value, 20);
  assert.ok(!JSON.stringify(result).includes(config.LLM_API_KEY));
});
test('模型不可用时不静默伪装成规则成功', async () => {
  await assert.rejects(() => interpretIntent('市盈率小于20', { env: config, fetchImpl: async () => { throw new Error('provider sensitive error'); } }), e => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('sensitive'));
});
test('拒绝非加密外部模型地址', async () => {
  await assert.rejects(() => interpretIntent('市盈率小于20', { env: { ...config, LLM_BASE_URL: 'http://external.example/v1' }, fetchImpl: () => { throw new Error('must not fetch'); } }), e => e.code === 'MODEL_CONFIG');
});
test('模型返回矛盾草稿保留给确定性引擎，而非自动改写', () => {
  const input = draft({ conditions: [
    { id: 'a', metric: 'pe_ttm', op: 'lt', value: 10, origin: '小于10' },
    { id: 'b', metric: 'pe_ttm', op: 'gt', value: 30, origin: '大于30' },
  ] });
  assert.equal(validateModelIntent(input).conditions.length, 2);
});
test('拒绝未知指标、数值字符串以及脚本注入文本', () => {
  for (const patch of [{ metric: 'future_profit' }, { value: '20' }, { value: null }, { origin: '<script>alert(1)</script>' }]) {
    assert.throws(() => validateModelIntent(draft({ conditions: [{ ...draft().conditions[0], ...patch }] })), e => e.code === 'MODEL_SCHEMA');
  }
});
test('普通数学比较符不是HTML，草稿原文可保留', () => {
  assert.equal(validateModelIntent(draft()).conditions[0].origin, 'PE<20');
});
test('非法JSON与HTTP错误不显示上游内容', async () => {
  await assert.rejects(() => interpretIntent('市盈率小于20', { env: config, fetchImpl: async () => new Response('private provider message', { status: 401 }) }), e => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('private'));
  await assert.rejects(() => interpretIntent('市盈率小于20', { env: config, fetchImpl: async () => new Response('not-json') }), e => e.code === 'MODEL_SCHEMA');
});
test('不支持项必须逐字来自用户输入，禁止凭空追加限制', () => {
  assert.throws(() => validateModelIntent(draft({ unsupported: ['行业、ST排除'] }), '市盈率小于20'), e => e.code === 'MODEL_UNGROUNDED');
  const valid = validateModelIntent(draft({ unsupported: ['股息率大于5%'] }), '市盈率小于20且股息率大于5%');
  assert.deepEqual(valid.unsupported, ['股息率大于5%']);
});
test('草稿摘要的条件数从结构计算，不信任模型口算', () => {
  const result = validateModelIntent(draft({ summary: '共99条条件' }));
  assert.match(result.summary, /1 条/);
  assert.ok(!result.summary.includes('99'));
});
test('空输入与超长输入被拒绝', async () => {
  for (const text of ['', ' '.repeat(3), null, 'a'.repeat(2001)]) await assert.rejects(() => interpretIntent(text, { env: {} }), e => e.code === 'INVALID_INPUT');
});
