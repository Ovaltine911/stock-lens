import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoSnapshot, dataCapabilities, loadSnapshot, parseEastmoneyQuote } from '../lib/data.mjs';
import { screenSnapshot } from '../lib/engine.mjs';

const ok = (body) => ({ ok: true, status: 200, async json() { return body; } });

test('public parser preserves null-like quote values instead of coercing to zero', () => {
  const parsed = parseEastmoneyQuote({ rc: 0, data: { f57: '600519', f116: null, f162: '-', f167: ' ', f124: 0 } }, '600519.SH');
  assert.equal(parsed.marketCap, null);
  assert.equal(parsed.dynamicPe, null);
  assert.equal(parsed.pb, null);
  assert.equal(parsed.quoteTimestamp, null);
});

test('demo is explicit synthetic 12-stock pool with mixed evidence', async () => {
  const snapshot = await loadSnapshot('demo', { env: {} });
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.stocks.length, 12);
  assert.match(snapshot.source, /合成|虚构/);
  assert.match(snapshot.warnings.join(' '), /虚构/);
  assert.equal(snapshot.stocks[4].metrics.pe_ttm.value, -14.3);
  assert.equal(snapshot.stocks[2].metrics.pe_ttm.status, 'missing');
  assert.equal(snapshot.stocks[8].metrics.pb_mrq.status, 'missing');
  assert.match(snapshot.stocks[0].metrics.pe_ttm.source, /合成/);
  assert.equal(snapshot.stocks[0].metrics.pe_ttm.asOf, '2024-12-31T00:00:00.000Z');
});

test('Fuyao mode never silently falls back without key', async () => {
  assert.deepEqual(dataCapabilities({}), { fuyaoConfigured: false, publicAvailable: false });
  assert.equal(dataCapabilities({ PUBLIC_DATA_ENABLED: 'true' }).publicAvailable, true);
  await assert.rejects(() => loadSnapshot('fuyao', { env: {} }), (error) => error.code === 'DATA_UNAVAILABLE' && error.status === 503);
});

test('Fuyao HTTP 200 business error is rejected', async () => {
  const fetchImpl = async () => ok({ code: 2001, message: 'missing api key', data: null });
  await assert.rejects(() => loadSnapshot('fuyao', { env: { FUYAO_API_KEY: 'test-only-key' }, fetchImpl }), (error) => error.code === 'FUYAO_2001' && error.status === 502 && error.message === '数据服务返回业务错误，请稍后重试');
});

test('public adapter validates envelope and calculates annualized volatility/return', async () => {
  const closes = Array.from({ length: 25 }, (_, i) => String((100 + i).toFixed(2)));
  const fetchImpl = async (url) => {
    if (url.includes('push2his')) {
      return ok({ rc: 0, data: { klines: closes.map((close, i) => `2025-01-${String(i + 1).padStart(2, '0')},${close}`) } });
    }
    return ok({ rc: 0, data: { f57: '600519', f58: '测试名称', f116: 1234567890000, f124: Date.now(), f162: 2113, f167: 715, f43: 145300 } });
  };
  const snapshot = await loadSnapshot('public', { env: { PUBLIC_DATA_ENABLED: 'true' }, fetchImpl });
  assert.equal(snapshot.stocks.length, 12);
  const stock = snapshot.stocks[0];
  assert.equal(stock.metrics.pe_ttm.value, null);
  assert.equal(stock.metrics.pe_ttm.status, 'missing');
  assert.match(stock.metrics.pe_ttm.note, /动态 PE/);
  assert.equal(stock.metrics.pb_mrq.value, 7.15);
  assert.equal(stock.metrics.market_cap.value, 12345.6789);
  assert.equal(stock.metrics.revenue_yoy.value, null);
  assert.equal(stock.metrics.revenue_yoy.status, 'missing');
  assert.equal(stock.metrics.return_20d.status, 'stale');
  assert.equal(stock.metrics.pb_mrq.status, 'ok');
  assert.match(stock.metrics.pb_mrq.sourceUrl, /secid=1\.600519/);
  assert.ok(stock.metrics.volatility_20d.value > 0);
  assert.ok(stock.metrics.return_20d.value > 0);
});

test('public mode is disabled unless explicitly enabled', async () => {
  await assert.rejects(() => loadSnapshot('public', { env: {} }), (error) => error.code === 'DATA_UNAVAILABLE' && error.status === 503 && error.message.includes('未启用'));
});

test('public adapter throws when every source request fails', async () => {
  const fetchImpl = async () => ok({ rc: 1, data: null });
  await assert.rejects(() => loadSnapshot('public', { fetchImpl, env: { PUBLIC_DATA_ENABLED: 'true' } }), (error) => error.code === 'DATA_UNAVAILABLE' && error.status === 503);
});

test('public adapter rejects future K-line dates instead of treating them as current', async () => {
  const futureRows = Array.from({ length: 21 }, (_, i) => `2099-01-${String(i + 1).padStart(2, '0')},${100 + i}`);
  const fetchImpl = async (url) => url.includes('push2his')
    ? ok({ rc: 0, data: { klines: futureRows } })
    : ok({ rc: 0, data: { f57: '600519', f58: '未来测试', f116: 100000000, f162: 100, f167: 100 } });
  const snapshot = await loadSnapshot('public', { fetchImpl, env: { PUBLIC_DATA_ENABLED: 'true' } });
  assert.equal(snapshot.stocks[0].metrics.return_20d.status, 'error');
  assert.equal(snapshot.stocks[0].metrics.return_20d.value, null);
  assert.match(snapshot.stocks[0].metrics.return_20d.note, /未来/);
});

test('demo snapshot screens volatility with catalog-matched period metadata', async () => {
  const snapshot = await loadSnapshot('demo');
  const result = screenSnapshot(snapshot, [{ id: 'vol-30', metric: 'volatility_20d', op: 'lte', value: 30, origin: 'manual' }]);
  assert.deepEqual(result.counts, { pass: 7, fail: 4, unknown: 1, total: 12 });
  assert.equal(result.rows.find((row) => row.code === 'XIN0001.D').status, 'pass');
  assert.equal(result.rows.find((row) => row.code === 'XIN0008.D').status, 'unknown');
});

test('demo factory creates a fresh serializable snapshot', () => {
  const snapshot = createDemoSnapshot();
  assert.deepEqual(Object.keys(snapshot), ['id', 'mode', 'source', 'asOf', 'fetchedAt', 'universe', 'warnings', 'stocks']);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).stocks.length, 12);
});
