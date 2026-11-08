import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createApp } from '../server.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

let browser, server, base;
test.before(async () => {
  server = createApp({ env: {}, rateLimit: 300 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], '浏览器不应出现未捕获错误'));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#healthText').textContent.includes('正常'));
  return page;
}
async function interpret(page, text) {
  await page.locator('#intentInput').fill(text);
  const parsed = page.waitForResponse(r => r.url().endsWith('/api/interpret') && r.request().method() === 'POST');
  await page.locator('#interpretBtn').click();
  await parsed;
  await page.waitForFunction(() => !document.querySelector('#interpretBtn').disabled);
}
async function loadDemo(page) {
  const data = page.waitForResponse(r => r.url().endsWith('/api/snapshot'));
  await page.locator('#loadDataBtn').click();
  await data;
  await page.waitForFunction(() => document.querySelector('#dataStatus').textContent.includes('已加载'));
}
async function screen(page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/screen'));
  await page.locator('#confirmBtn').click();
  const res = await response;
  const body = await res.json();
  assert.equal(res.status(), 200, JSON.stringify(body));
  await page.locator('#resultsContent').waitFor({ state: 'visible' });
  return body;
}

test('无错误时隐藏横幅和重试，真实错误出现后能显示并在恢复后清除', async t => {
  const page = await pageFor(t);
  for (const selector of ['#errorBox', '#retryBtn']) {
    assert.equal(await page.locator(selector).evaluate(el => el.hidden), true);
    assert.equal(await page.locator(selector).isVisible(), false, `${selector} 的 hidden 不能被布局样式覆盖`);
    assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).display), 'none');
  }
  await loadDemo(page);
  await interpret(page, '市盈率小于20');
  await screen(page);
  assert.equal(await page.locator('#errorBox').isVisible(), false);
  assert.equal(await page.locator('#retryBtn').isVisible(), false);
  await interpret(page, '市盈率小于10且市盈率大于30');
  const failed = page.waitForResponse(r => r.url().endsWith('/api/screen'));
  await page.locator('#confirmBtn').click();
  assert.equal((await failed).status(), 422);
  await page.locator('#errorBox').waitFor({ state: 'visible' });
  assert.match(await page.locator('#errorTitle').textContent(), /冲突/);
  assert.equal(await page.locator('#retryBtn').isVisible(), true);
  await interpret(page, '市盈率小于20');
  await screen(page);
  assert.equal(await page.locator('#errorBox').isVisible(), false);
  assert.equal(await page.locator('#retryBtn').isVisible(), false);
});

test('桌面主流程、证据、条件编辑、同快照对比和当前导出', async t => {
  const page = await pageFor(t);
  assert.equal(await page.locator('#resultsContent').isVisible(), false);
  await loadDemo(page);
  await interpret(page, '市盈率小于20');
  const first = await screen(page);
  assert.ok(first.counts.pass > 0);
  await page.locator('#overviewTab tbody tr').first().click();
  await page.locator('#evidenceDialog').waitFor({ state: 'visible' });
  const evidence = await page.locator('#dialogBody').textContent();
  assert.match(evidence, /pe_ttm/);
  assert.match(evidence, /2024/);
  assert.match(evidence, /合成/);
  await page.locator('#closeDialog').click();
  await page.locator('#saveBtn').click();
  const savedBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('stock-lens:last')));
  assert.equal(savedBefore.conditions[0].value, 20);
  const input = page.locator('#conditionsList input[type=number]').first();
  await input.fill('30');
  await input.press('Tab');
  assert.equal(await page.locator('#resultsContent').isVisible(), false, '编辑后旧结论必须立即隐藏');
  const second = await screen(page);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.ok(second.diff.added.length > 0);
  await page.locator('[data-tab=compare]').click();
  assert.match(await page.locator('#compareTab').textContent(), /新增/);
  const savedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('stock-lens:last')));
  assert.equal(savedAfter.conditions[0].value, 20, '编辑当前条件不能篡改已保存快照');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(exported.conditions[0].value, 30, '导出应是当前结果，不是旧保存');
  await page.locator('#restoreBtn').click();
  assert.match(await page.locator('#resultsSub').textContent(), /历史/);
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true, '恢复历史不能冒充当前服务器快照');
});

test('模糊意图先澄清再执行，保留可编辑的五条草稿', async t => {
  const page = await pageFor(t);
  await loadDemo(page);
  await interpret(page, '经营改善、估值合理、走势稳定');
  assert.equal(await page.locator('#conditionsList .condition-row').count(), 5);
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
  await page.locator('#messageList input[type=checkbox]').check();
  const result = await screen(page);
  assert.ok(result.counts.pass > 0);
  const out = process.env.PICODE_ARTIFACT_DIR || path.resolve('artifacts');
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'stock-lens-desktop.png'), fullPage: true });
});

test('冲突与合规提示不被错误成功覆盖', async t => {
  const page = await pageFor(t);
  await loadDemo(page);
  await interpret(page, '市盈率小于10且市盈率大于30');
  const failed = page.waitForResponse(r => r.url().endsWith('/api/screen'));
  await page.locator('#confirmBtn').click();
  assert.equal((await failed).status(), 422);
  await page.locator('#errorBox').waitFor({ state: 'visible' });
  assert.match(await page.locator('#errorTitle').textContent(), /冲突/);
  await interpret(page, '明天必涨的股票直接买入');
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
  assert.match(await page.locator('#messageList').textContent(), /不能|不提供|边界/);
});

test('切换数据源后不能用旧快照，解析文字改变后不能用旧条件', async t => {
  const page = await pageFor(t);
  await loadDemo(page);
  await interpret(page, '市盈率小于20');
  await screen(page);
  await page.locator('#intentInput').fill('市净率小于3');
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
  assert.equal(await page.locator('#resultsContent').isVisible(), false);
  await interpret(page, '市净率小于3');
  await page.locator('#dataMode').selectOption('fuyao');
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
  assert.equal(await page.locator('#resultsContent').isVisible(), false);
  const failed = page.waitForResponse(r => r.url().endsWith('/api/snapshot'));
  await page.locator('#loadDataBtn').click();
  assert.equal((await failed).status(), 503);
  await page.locator('#errorBox').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#confirmBtn').isDisabled(), true);
});

test('移动窄屏无横向溢出，系统深色生效，损坏存储不崩溃', async t => {
  const page = await pageFor(t, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => localStorage.setItem('stock-lens:last', '{bad json'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#healthText').textContent.includes('正常'));
  await loadDemo(page);
  await interpret(page, '市盈率小于20');
  await screen(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const out = process.env.PICODE_ARTIFACT_DIR || path.resolve('artifacts');
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'stock-lens-mobile-dark.png'), fullPage: true });
});
