import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createApp } from '../server.mjs';
import { createDemoSnapshot } from '../lib/data.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

let browser, server, base;
const calls = [];
test.before(async () => {
  server = createApp({ env: {}, rateLimit: 1000, snapshotLoader: async mode => {
    calls.push(mode);
    return { ...createDemoSnapshot(), mode, source: '测试注入的合成数据，非真实行情', supportedMetrics: ['pe_ttm','pb_mrq','roe','revenue_yoy_annual','profit_yoy_annual','volatility_20d'] };
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
});
async function pageFor(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  t.after(() => context.close());
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], '浏览器不应出现未捕获异常'));
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#healthText').textContent.includes('正在'));
  return page;
}
async function submit(page, text, expectScreen = true) {
  await page.locator('#intentInput').fill(text);
  const interpreted = page.waitForResponse(r => r.url().endsWith('/api/interpret'));
  const screened = expectScreen ? page.waitForResponse(r => r.url().endsWith('/api/screen')) : null;
  await page.locator('#interpretBtn').click();
  const intentResponse = await interpreted; assert.equal(intentResponse.status(), 200);
  const intent = await intentResponse.json();
  if (!expectScreen) {
    await page.waitForFunction(() => !document.querySelector('#interpretBtn').disabled);
    return { intent };
  }
  const resultResponse = await screened;
  const result = await resultResponse.json(); assert.equal(resultResponse.status(), 200, JSON.stringify(result));
  await page.locator('#resultsContent').waitFor({ state: 'visible' });
  return { intent, result };
}
async function screenshot(page, name) {
  const out = process.env.PICODE_ARTIFACT_DIR || path.resolve('artifacts');
  await mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, name), fullPage: true });
}

test('明确条件一次提交自动取数筛选，不要求选源或加载且无假错误横幅', async t => {
  const page = await pageFor(t);
  assert.equal(await page.locator('#dataMode').count(), 0);
  assert.equal(await page.locator('#loadDataBtn').count(), 0);
  assert.equal(await page.locator('#errorBox').isVisible(), false);
  assert.equal(await page.locator('#retryBtn').isVisible(), false);
  const { intent, result } = await submit(page, '市盈率小于20');
  assert.equal(intent.needsConfirmation, false);
  assert.ok(result.counts.pass > 0);
  assert.equal(result.counts.total, 12);
  assert.equal(await page.locator('#messageList input[type=checkbox]').count(), 0);
  assert.equal(await page.locator('#errorBox').isVisible(), false);
  assert.equal(await page.locator('#retryBtn').isVisible(), false);
  assert.match(await page.locator('#universeStrip').textContent(), /非全市场/);
  await screenshot(page, 'stock-lens-v3-desktop.png');
});

test('模糊意图只确认一次年度假设，无勾选，无提前执行', async t => {
  const page = await pageFor(t); let screens = 0;
  page.on('request', r => { if (r.url().endsWith('/api/screen')) screens++; });
  const { intent } = await submit(page, '经营改善、估值合理、走势相对稳定', false);
  assert.equal(intent.needsConfirmation, true);
  assert.equal(await page.locator('#conditionsList input[type=number]').count(), 5);
  assert.equal(screens, 0);
  assert.equal(await page.locator('#messageList input[type=checkbox]').count(), 0);
  assert.match(await page.locator('#messageList').textContent(), /年度/);
  const done = page.waitForResponse(r => r.url().endsWith('/api/screen'));
  await page.locator('#confirmBtn').click();
  assert.equal((await done).status(), 200); assert.equal(screens, 1);
  await page.locator('#resultsContent').waitFor({ state: 'visible' });
  await screenshot(page, 'stock-lens-v3-fuzzy-result.png');
});

test('修改阈值复用同一快照，旧结果不可保存导出，焦点保持', async t => {
  const page = await pageFor(t); let snapshots = 0;
  page.on('request', r => { if (r.url().endsWith('/api/snapshot')) snapshots++; });
  const { result: first } = await submit(page, '市盈率小于20');
  const input = page.locator('#conditionsList input[type=number]').first();
  await input.fill('30');
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#saveBtn').isDisabled(), true);
  assert.equal(await page.locator('#exportBtn').isDisabled(), true);
  const done = page.waitForResponse(r => r.url().endsWith('/api/screen'));
  await page.locator('#confirmBtn').click();
  const result = await (await done).json();
  assert.equal(result.snapshotId, first.snapshotId); assert.equal(snapshots, 1);
  assert.ok(result.diff.added.length > 0); assert.equal(result.diff.removed.length, 0);
  await page.locator('#diffBox').waitFor({ state: 'visible' });
});

test('证据查看、当前导出、保存与历史只读恢复', async t => {
  const page = await pageFor(t); await submit(page, '市盈率小于20');
  await page.locator('#overviewTab tbody tr').first().click();
  await page.locator('#evidenceDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#dialogBody').textContent(), /来源|原始字段/);
  await page.locator('#closeDialog').click();
  const download = page.waitForEvent('download'); await page.locator('#exportBtn').click();
  const stream = await (await download).createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(JSON.stringify(exported).includes('pe_ttm'));
  await page.locator('#saveBtn').click();
  await page.locator('#restoreBtn').click();
  // A single record restores directly; multiple records open a chooser.
  assert.match(await page.locator('#resultsSub').textContent(), /历史/);
  assert.match(await page.locator('#snapshotTag').textContent(), /历史/);
  assert.match(await page.locator('#confirmBtn').textContent(), /重新查询/);
});

test('冲突、未知条件和合规阻断不会静默执行，恢复成功清除错误', async t => {
  const page = await pageFor(t);
  await page.locator('#intentInput').fill('市盈率小于10且市盈率大于30');
  await page.locator('#interpretBtn').click();
  await page.locator('#errorBox').waitFor({ state: 'visible' });
  assert.match(await page.locator('#errorBox').textContent(), /冲突/);
  await submit(page, '市盈率小于20');
  assert.equal(await page.locator('#errorBox').isVisible(), false);
  let count = 0; page.on('request', r => { if (r.url().endsWith('/api/screen')) count++; });
  await submit(page, '市盈率小于20且股息率大于5%', false);
  assert.equal(count, 0); assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
  assert.match(await page.locator('#messageList').textContent(), /股息|分红|不支持|无法/);
  await submit(page, '告诉我明天必涨的股票直接买入', false);
  assert.equal(count, 0); assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
});

test('来源请求失败明确提示且不自动回退演示数据', async t => {
  const page = await pageFor(t); const modes = [];
  await page.route('**/api/snapshot', async route => {
    modes.push(route.request().postDataJSON().mode);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DATA_UNAVAILABLE', message: '真实数据暂时不可用' } }) });
  });
  await page.locator('#intentInput').fill('市盈率小于20'); await page.locator('#interpretBtn').click();
  await page.locator('#errorBox').waitFor({ state: 'visible' });
  assert.deepEqual(modes, ['auto']);
  assert.equal(await page.locator('#resultsContent').isVisible(), false);
  assert.equal(await page.locator('#retryBtn').isVisible(), true);
});

test('在飞解析期间输入变化不把旧草稿当新请求执行', async t => {
  const page = await pageFor(t); let screens = 0;
  page.on('request', r => { if (r.url().endsWith('/api/screen')) screens++; });
  await page.route('**/api/interpret', async route => {
    await new Promise(r => setTimeout(r, 200));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode:'rules',summary:'旧草稿',conditions:[{id:'c1',metric:'pe_ttm',op:'lt',value:20,origin:'旧请求'}],clarifications:[],warnings:[],unsupported:[],blocked:false,needsConfirmation:false }) });
  });
  await page.locator('#intentInput').fill('市盈率小于20'); await page.locator('#interpretBtn').click();
  await page.locator('#intentInput').fill('市净率小于3');
  await page.waitForTimeout(400);
  assert.equal(screens, 0); assert.equal(await page.locator('#resultsContent').isVisible(), false);
});

test('手机深色无横向溢出，数据来源说明不要求用户选择供应商', async t => {
  const page = await pageFor(t, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await submit(page, '市盈率小于20');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(page, 'stock-lens-v3-mobile-dark.png');
  await page.locator('#dataInfoBtn').click();
  await page.locator('#dataDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#dataBody').textContent(), /数据|来源|口径/);
});
