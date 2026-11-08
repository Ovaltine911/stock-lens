import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoDataCapabilities, loadAutoSnapshot, __testing as api } from '../lib/auto-data.mjs';
import { RESEARCH_POOL } from '../lib/data.mjs';
import { METRICS, getMetric } from '../lib/catalog.mjs';

// All fixture values below are invented. No authorized market observations.
const NOW = Date.parse('2026-11-08T12:00:00+08:00');
const ASOF = '2026-11-06';
const CODE = RESEARCH_POOL[0].code;
const ENV = { FUYAO_API_KEY: 'synthetic-test-credential' };
const ms = day => Date.parse(`${day}T00:00:00+08:00`);
const days = Array.from({ length: 40 }, (_, i) => api.dateMs(ms('2026-09-28') + i * 86400000));
const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() });
const success = data => json({ code: 0, data });
const income = code => ({ thscode: code, item: [2025, 2024].map((year, i) => ({ thscode: code, ticker: code.slice(0, 6), period: 'annual', fiscal_year: year, fiscal_period: 'FY', period_end_ms: ms(`${year}-12-31`), report_date_ms: ms('2026-04-20'), currency: 'CNY', operating_income: i ? 1000 : 1200, parent_holder_net_profit: i ? 100 : 130 })) });
const prices = code => ({ thscode: code, timestamp: ms(ASOF), item: days.map((day, i) => ({ date_ms: ms(day), close_price: 100 * Math.exp(i * 0.001 + (i % 2) * 0.002) })) });
const indicator = (code = CODE, report = '2026-3', value = '12.345600') => ({ thscode: code, report, abilities: [{ ability: 'profitability', indicators: [{ index_id: 'index_weighted_avg_roe', value }] }] });
function fixture({ modify, fail, ifind = false, delay = 0 } = {}) {
  const calls = []; let active = 0; let peak = 0;
  const fetchImpl = async (url, options) => {
    const u = new URL(url); const path = u.pathname.split('/').at(-1); const codes = (u.searchParams.get('thscodes') || '').split(',').filter(Boolean);
    calls.push({ path, codes, options, url: u });
    if (options.method === 'POST') {
      assert.equal(ifind, true, 'must not invoke iFinD when primary is sufficient');
      const request = JSON.parse(options.body);
      if (request.method === 'initialize') return { ...json({ jsonrpc: '2.0', id: request.id, result: {} }), headers: new Headers({ 'mcp-session-id': 'synthetic-session', 'content-type': 'application/json' }) };
      if (request.method === 'notifications/initialized') return json({});
      const query = request.params.arguments.query; const stocks = [...query.matchAll(/\d{6}\.(?:SH|SZ)/g)].map(m => m[0]);
      const roe = request.params.name === 'get_stock_financials';
      const headers = roe ? ['证券代码', '日期', '净资产收益率ROE(加权,公布值)(单位:%)'] : ['证券代码', '日期', '市盈率(PE,TTM)', '市净率(PB,MRQ)'];
      const answer = [headers, headers.map(() => '---'), ...stocks.map(code => roe ? [code, '2026-09-30', '9.1'] : [code, ASOF, '15', '2'])].map(row => `|${row.join('|')}|`).join('\n');
      const indicators_params = roe ? { '净资产收益率ROE(加权,公布值)': { 报告期: '2026-09-30' } } : { '市盈率(PE,TTM)': { 交易日期: ASOF }, '市净率(PB,MRQ)': { 交易日期: ASOF } };
      return json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 1, msg: 'success', data: { answer, indicators_params } }) }] } });
    }
    active++; peak = Math.max(peak, active);
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (fail) { const failure = fail(path, codes); if (failure) return failure; }
      let data;
      if (path === 'trading-days') data = { timestamp: ms(ASOF), item: days.map(day => ({ date: day.replaceAll('-', ''), date_ms: ms(day) })) };
      else if (path === 'snapshot') data = { timestamp: NOW - 1000, total: codes.length, item: codes.map(code => ({ thscode: code, pe_ttm: 15.123, pb_mrq: 2.1 })) };
      else if (path === 'historical-batch') data = { interval: '1d', adjust: 'forward', item: codes.map(prices) };
      else if (path === 'income-statements-batch') data = { item: codes.map(income) };
      else if (path === 'indicators') data = indicator(u.searchParams.get('thscode'), u.searchParams.get('report'));
      else throw new Error('unrecognized fixture route');
      if (modify) modify(path, data, codes);
      return success(data);
    } finally { active--; }
  };
  return { fetchImpl, calls, peak: () => peak };
}
const load = (f, env = ENV) => loadAutoSnapshot({ env, fetchImpl: f.fetchImpl, now: () => NOW });

test('capabilities require explicit source; no configuration never falls back to demo', async () => {
  assert.deepEqual(autoDataCapabilities({}), { autoAvailable: false });
  for (const env of [ENV, { FUYAO_CONFIG_PATH: '/explicit/file' }, { IFIND_API_KEY: 'configured' }]) assert.equal(autoDataCapabilities(env).autoAvailable, true);
  assert.equal(autoDataCapabilities({ FUYAO_API_KEY: '   ' }).autoAvailable, false);
  await assert.rejects(load(fixture(), {}), e => e.code === 'DATA_UNAVAILABLE' && /不会退回演示/.test(e.message));
});

test('date_ms is Shanghai date, invalid dates are rejected, report calculation has year rollover', () => {
  assert.equal(new Date(ms(ASOF)).toISOString().slice(0, 10), '2026-11-05');
  assert.equal(api.dateMs(ms(ASOF)), ASOF);
  for (const value of [null, undefined, '1793894400000', NaN, Infinity, -1]) assert.equal(api.dateMs(value), null);
  assert.equal(api.date('20260230'), null);
  assert.equal(api.reportFor(ASOF), '2026-3');
  assert.equal(api.reportFor('2027-01-08'), '2026-4');
});

test('full 12-stock automatic snapshot uses 19 bounded requests, and never duplicates iFinD', async () => {
  const f = fixture({ delay: 2 }); const snapshot = await load(f, { ...ENV, IFIND_API_KEY: 'unused-secret' });
  assert.equal(snapshot.mode, 'auto'); assert.equal(snapshot.asOf, ASOF); assert.equal(snapshot.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(snapshot.stocks.map(s => s.code), RESEARCH_POOL.map(s => s.code));
  assert.equal(f.calls.length, 19); assert.equal(f.peak(), 2);
  for (const path of ['snapshot', 'historical-batch', 'income-statements-batch']) assert.deepEqual(f.calls.filter(x => x.path === path).map(x => x.codes.length), [10, 2]);
  assert.equal(f.calls.filter(x => x.path === 'indicators').length, 12);
  for (const s of snapshot.stocks) {
    for (const id of ['pe_ttm', 'pb_mrq', 'roe', 'volatility_20d', 'return_20d', 'revenue_yoy_annual', 'profit_yoy_annual']) { assert.equal(s.metrics[id].status, 'ok'); assert.equal(s.metrics[id].unit, getMetric(id).unit); assert.equal(s.metrics[id].period, getMetric(id).period); }
    for (const id of ['revenue_yoy', 'profit_yoy', 'market_cap']) assert.equal(s.metrics[id].value, null);
  }
  assert.equal(snapshot.supportedMetrics.length, 7);
  assert.equal(snapshot.stocks[0].metrics.pe_ttm.asOf, '2026-11-08');
  assert.match(snapshot.stocks[0].metrics.pe_ttm.note, /不是逐字段交易日期/);
  assert.equal(f.calls[0].url.searchParams.get('end_date'), '20261108');
});

test('calendar network failure is fatal and does not fabricate a weekday or call other modules', async () => {
  let count = 0;
  await assert.rejects(loadAutoSnapshot({ env: ENV, now: () => NOW, fetchImpl: async () => { count++; throw new Error(ENV.FUYAO_API_KEY); } }), e => e.code === 'FUYAO_NETWORK' && !e.message.includes(ENV.FUYAO_API_KEY));
  assert.equal(count, 1);
});

test('calendar rejects empty, duplicated, conflicting or out-of-window dates', async () => {
  for (const mutate of [d => { d.item = []; }, d => { d.item.push(d.item.at(-1)); }, d => { d.item[0].date = '20260101'; }, d => { d.item[0].date_ms = ms('2026-09-29'); }]) {
    const f = fixture({ modify: (path, data) => { if (path === 'trading-days') mutate(data); } });
    await assert.rejects(load(f)); assert.equal(f.calls.length, 1);
  }
});

test('HTTP 200 business error is checked, and remote text/code cannot reflect secrets', async () => {
  for (const body of [{ code: 2001, message: ENV.FUYAO_API_KEY }, { code: ENV.FUYAO_API_KEY, data: {} }]) {
    await assert.rejects(loadAutoSnapshot({ env: ENV, now: () => NOW, fetchImpl: async () => json(body) }), e => !e.message.includes(ENV.FUYAO_API_KEY) && /^FUYAO_/.test(e.code));
  }
  await assert.rejects(api.createClient({ apiKey: ENV.FUYAO_API_KEY, fetchImpl: async () => ({ ok: false, status: 429 }) })('calendar/trading-days'), e => /状态码 429/.test(e.message));
});

test('timeout includes stalled response body even if fetch already returned', async () => {
  const request = api.createClient({ apiKey: 'test-key', timeoutMs: 15, fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) }) });
  await assert.rejects(request('calendar/trading-days'), e => e.code === 'FUYAO_TIMEOUT' && e.status === 504);
});

test('null, malformed, oversized JSON and invalid envelopes are never usable responses', async () => {
  for (const text of ['invalid', 'null', JSON.stringify({ code: 0, data: [] }), ' '.repeat(2 * 1024 * 1024 + 1)]) {
    const request = api.createClient({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, text: async () => text }) });
    await assert.rejects(request('calendar/trading-days'), e => e.code === 'FUYAO_SCHEMA');
  }
});

test('annual original values calculate percent without rounding and preserve only a raw whitelist', () => {
  const group = income(CODE); group.item[0].remote_secret = ENV.FUYAO_API_KEY;
  const e = api.annualEvidence(group, CODE, 'revenue_yoy_annual', ASOF);
  assert.ok(Math.abs(e.value - 20) < 1e-10); assert.equal(e.asOf, '2025-12-31');
  assert.equal(e.raw.numerator, 1200); assert.equal(e.raw.denominator, 1000); assert.equal(e.raw.records.length, 2);
  assert.equal(e.raw.records[0].report_date_ms, e.raw.records[1].report_date_ms);
  assert.equal(JSON.stringify(e).includes(ENV.FUYAO_API_KEY), false);
  assert.match(e.note, /不代表首次公告/);
});

test('annual nonadjacent years, missing money, currency/unit mismatch, future disclosure or identity mismatch stay missing', () => {
  const changes = [
    g => { g.item[1].fiscal_year = 2023; g.item[1].period_end_ms = ms('2023-12-31'); },
    g => { g.item[0].operating_income = null; }, g => { g.item[0].operating_income = '1200'; },
    g => { g.item[1].currency = 'USD'; }, g => { g.item[1].unit = '万元'; },
    g => { g.item[0].report_date_ms = ms('2027-04-01'); },
    g => { g.item[0].period = 'quarterly'; }, g => { g.item[0].thscode = RESEARCH_POOL[1].code; },
    g => { g.item[0].period_end_ms = ms('2025-09-30'); }, g => { g.item[0].report_date_ms = null; },
  ];
  for (const change of changes) { const g = income(CODE); change(g); assert.equal(api.annualEvidence(g, CODE, 'revenue_yoy_annual', ASOF).status, 'missing'); }
});

test('nonpositive annual base cannot label turnaround as conventional profit growth', () => {
  for (const value of [0, -100, null, Infinity]) { const g = income(CODE); g.item[1].parent_holder_net_profit = value; const e = api.annualEvidence(g, CODE, 'profit_yoy_annual', ASOF); assert.equal(e.value, null); assert.match(e.note, /扭亏/); }
  const g = income(CODE); g.item[0].parent_holder_net_profit = -30;
  assert.equal(api.annualEvidence(g, CODE, 'profit_yoy_annual', ASOF).value, -130);
});

test('21 aligned close prices use sample log-return volatility with denominator 19', () => {
  const g = prices(CODE); const e = api.klineEvidence(g, CODE, { interval: '1d', adjust: 'forward' }, days);
  const selected = g.item.slice(-21).map(x => x.close_price); const logs = selected.slice(1).map((x, i) => Math.log(x / selected[i]));
  const mean = logs.reduce((a, b) => a + b) / 20;
  const expected = Math.sqrt(logs.reduce((a, x) => a + (x - mean) ** 2, 0) / 19) * Math.sqrt(252) * 100;
  assert.ok(Math.abs(e.volatility_20d.value - expected) < 1e-9);
  assert.ok(Math.abs(e.return_20d.value - (selected.at(-1) / selected[0] - 1) * 100) < 1e-9);
  assert.equal(e.volatility_20d.raw.rows.length, 21); assert.equal(e.volatility_20d.asOf, ASOF);
});

test('K-lines reject short, zero, NaN, duplicate, disordered, stale and calendar-misaligned sequences', () => {
  for (const change of [g => { g.item = g.item.slice(-20); }, g => { g.item.at(-1).close_price = 0; }, g => { g.item.at(-1).close_price = NaN; }, g => { g.item.at(-1).date_ms = g.item.at(-2).date_ms; }, g => { g.item.reverse(); }, g => { g.item.pop(); }, g => { g.item.at(-2).date_ms += 2 * 86400000; }]) {
    const g = prices(CODE); change(g); assert.equal(api.klineEvidence(g, CODE, { interval: '1d', adjust: 'forward' }, days).volatility_20d.value, null);
  }
  assert.equal(api.klineEvidence(prices(CODE), CODE, { interval: '1d', adjust: 'none' }, days).volatility_20d.value, null);
});

test('ROE uses explicitly documented percent points regardless of magnitude, not a guessed scale', () => {
  for (const value of ['12.345600', '0.125', '-1.2', '0']) {
    const e = api.roeEvidence(indicator(CODE, '2026-3', value), CODE, '2026-3', ASOF);
    assert.equal(e.value, Number(value)); assert.equal(e.raw.value, value); assert.equal(e.raw.scale, 1); assert.equal(e.asOf, '2026-09-30');
  }
});

test('ROE rejects wrong units, wrong report, duplicate index and unverified scalar formats', () => {
  for (const mutate of [d => { d.report = '2026-2'; }, d => { d.thscode = '000000.SH'; }, d => { d.abilities[0].indicators[0].unit = 'ratio'; }, d => { d.abilities[0].indicators.push(d.abilities[0].indicators[0]); }, d => { d.abilities[0].indicators[0].value = '12%'; }, d => { d.abilities[0].indicators[0].index_id = 'index_deduct_weighted_avg_roe'; }]) {
    const d = indicator(); mutate(d); assert.equal(api.roeEvidence(d, CODE, '2026-3', ASOF).status, 'missing');
  }
});

test('optional ROE module error adds warnings and leaves other primary fields usable', async () => {
  const f = fixture({ fail: path => path === 'indicators' ? json({ code: 5003, data: null, message: ENV.FUYAO_API_KEY }) : null });
  const snapshot = await load(f);
  assert.equal(snapshot.stocks[0].metrics.roe.status, 'error'); assert.equal(snapshot.stocks[0].metrics.pe_ttm.status, 'ok');
  assert.ok(snapshot.warnings.some(w => /加权净资产收益率读取失败/.test(w)));
  assert.equal(JSON.stringify(snapshot).includes(ENV.FUYAO_API_KEY), false);
});

test('a whole required price module failing is an error, not a partial success', async () => {
  const f = fixture({ fail: path => path === 'historical-batch' ? { ok: false, status: 503 } : null });
  await assert.rejects(load(f), e => e.code === 'FUYAO_REQUIRED');
  assert.equal(f.calls.some(c => c.path === 'indicators'), false);
});

test('one required batch can fail with explicit errors while remaining stocks remain usable', async () => {
  const f = fixture({ fail: (path, codes) => path === 'historical-batch' && codes.length === 2 ? { ok: false, status: 503 } : null });
  const s = await load(f); assert.equal(s.stocks.at(-1).metrics.volatility_20d.status, 'error');
  assert.equal(s.stocks[0].metrics.volatility_20d.status, 'ok'); assert.ok(s.warnings.some(x => /日线批次失败/.test(x)));
});

test('all stock data empty is not success even when HTTP and business envelopes succeeded', async () => {
  const f = fixture({ modify: (path, data) => { if (path === 'indicators') data.abilities = []; else if (path !== 'trading-days') data.item = []; } });
  await assert.rejects(load(f), e => e.code === 'FUYAO_DATA_UNAVAILABLE');
});

test('reflected credential in valid-looking field and remote names is scrubbed before evidence', async () => {
  const env = { FUYAO_API_KEY: '12.345600' };
  const f = fixture({ modify: (path, data) => { if (path === 'snapshot') data.item.forEach(x => { x.name = env.FUYAO_API_KEY; x.pe_ttm = env.FUYAO_API_KEY; }); } });
  const s = await load(f, env);
  assert.equal(s.stocks[0].metrics.roe.value, null); assert.equal(s.stocks[0].metrics.pe_ttm.value, null);
  assert.equal(JSON.stringify(s).includes(env.FUYAO_API_KEY), false);
});

test('explicit credential file can load at runtime and environment key takes priority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-data-test-')); const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ FUYAO_API_KEY: 'file-test-key' }));
    const f = fixture(); await load(f, { FUYAO_CONFIG_PATH: path }); assert.equal(f.calls[0].options.headers['X-api-key'], 'file-test-key');
    const priority = fixture(); await load(priority, { ...ENV, FUYAO_CONFIG_PATH: '/never-read-private-file' }); assert.equal(priority.calls[0].options.headers['X-api-key'], ENV.FUYAO_API_KEY);
    await assert.rejects(load(fixture(), { FUYAO_CONFIG_PATH: join(dir, 'absent') }), e => e.code === 'FUYAO_CONFIG' && !e.message.includes(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('future and stale valuation metadata never uses fetchedAt or calendar date as its field date', async () => {
  for (const stamp of [null, NOW + 1000, ms('2026-11-05')]) {
    const f = fixture({ modify: (path, data) => { if (path === 'snapshot') data.timestamp = stamp; } });
    const s = await load(f); assert.equal(s.asOf, ASOF); assert.equal(s.stocks[0].metrics.pe_ttm.status, 'missing');
  }
});

test('only missing one-stock ROE invokes one fallback tool, not full duplicate source loading', async () => {
  const f = fixture({ ifind: true, modify: (path, data) => { if (path === 'indicators' && data.thscode === CODE) data.abilities = []; } });
  const s = await load(f, { ...ENV, IFIND_API_KEY: 'synthetic-fallback-key' });
  const tools = f.calls.filter(x => x.options.method === 'POST').map(x => JSON.parse(x.options.body)).filter(x => x.method === 'tools/call');
  assert.equal(tools.length, 1); assert.equal(tools[0].params.name, 'get_stock_financials');
  assert.equal((tools[0].params.arguments.query.match(/\d{6}\.(?:SH|SZ)/g) || []).length, 1);
  assert.match(s.stocks[0].metrics.roe.source, /iFinD/); assert.equal(s.stocks[0].metrics.roe.asOf, '2026-09-30');
  assert.match(s.stocks[1].metrics.roe.source, /扶摇/); assert.ok(s.warnings.some(x => /本次补入1项/.test(x)));
});

test('primary calendar failure permits only explicit fixed-date fallback with no claim of latest trading day', async () => {
  const f = fixture({ ifind: true, fail: path => path === 'trading-days' ? { ok: false, status: 503 } : null });
  const s = await load(f, { ...ENV, IFIND_API_KEY: 'synthetic-fallback-key' });
  assert.equal(s.mode, 'auto'); assert.equal(s.asOf, ASOF); assert.equal(s.stocks[0].metrics.revenue_yoy_annual.value, null);
  assert.ok(s.warnings.some(x => /无法确认最近交易日/.test(x))); assert.deepEqual(s.supportedMetrics.sort(), ['pe_ttm', 'pb_mrq', 'roe'].sort());
});

test('module owns no snapshot cache; callers control deduplication', async () => {
  const f = fixture(); const first = await load(f); const second = await load(f);
  assert.notEqual(first.id, second.id); assert.equal(f.calls.length, 38);
  assert.equal(first.stocks[0].metrics.revenue_yoy.period, METRICS.find(x => x.id === 'revenue_yoy').period);
});
