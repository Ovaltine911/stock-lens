import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ifindCapabilities, loadIfindSnapshot, __testing as api } from '../lib/ifind.mjs';
import { METRICS } from '../lib/catalog.mjs';

// Every numerical fixture below is synthetic. No downloaded financial values.
const codes = ['600519.SH', '000858.SZ'];
const financialRequest = api.requestsFor(codes)[0];
const valuationRequest = api.requestsFor(codes)[1];
const pe = '市盈率(PE,TTM)';
const pb = '市净率（PB，MRQ）';
const roe = '净资产收益率ROE(加权,公布值)（单位：%）';
function tool(answer, parameters, overrides = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ code: 1, msg: 'success', data: { answer, indicators_params: parameters }, ...overrides }) }] };
}
function table(headers, rows) { return `|${headers.join('|')}|\n|${headers.map(() => '---').join('|')}|${rows.length ? '\n' : ''}${rows.map(row => `|${row.join('|')}|`).join('\n')}`; }
function valuation({ values = ['17.25', '2.50'], rowDate, parameterDate = '20261106', headers = [pe, pb], code = codes[0] } = {}) {
  return tool(table(['证券代码', '证券简称', ...(rowDate === undefined ? [] : ['日期']), ...headers], [[code, '合成测试名称', ...(rowDate === undefined ? [] : [rowDate]), ...values]]), { [pe]: { 交易日期: parameterDate, TTM基准日: '报表公告日期' }, [pb]: { 交易日期: parameterDate } });
}
function financial({ date = '20260930', value = '12.30', field = roe, parameter = '最新一期(MRQ)' } = {}) {
  return tool(table(['证券代码', '日期', field], [[codes[0], date, value]]), { '净资产收益率ROE(加权,公布值)': { 报告期: parameter } });
}
function evidence(result, id = 'pe_ttm', code = codes[0]) { return api.mappedEvidence(api.parseTool(result, codes), code, id, id === 'roe' ? financialRequest : valuationRequest); }
const json = (payload, headers = {}) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
function server(handler = null) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    if (handler) { const result = await handler(body, options, calls.length); if (result) return result; }
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { 'mcp-session-id': 'synthetic-session' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: body.id, result: valuation() });
  };
  return { calls, fetchImpl };
}
function client(fetchImpl, extra = {}) { return api.createClient({ apiKey: 'synthetic-test-key', fetchImpl, gate: action => action(), ...extra }); }

test('configuration is explicit; capability never reads private files', async () => {
  assert.deepEqual(ifindCapabilities({}), { ifindConfigured: false });
  assert.deepEqual(ifindCapabilities({ IFIND_API_KEY: '  ' }), { ifindConfigured: false });
  assert.deepEqual(ifindCapabilities({ IFIND_CONFIG_PATH: '/not-read-by-capability' }), { ifindConfigured: true });
  await assert.rejects(loadIfindSnapshot({ env: {}, fetchImpl: () => { throw Error('must not fetch'); } }), { code: 'IFIND_CONFIG' });
});
test('bad configuration and newline headers fail without leaking key or path', async () => {
  for (const env of [{ IFIND_CONFIG_PATH: '/private/sensitive-config-no-exist' }, { IFIND_API_KEY: 'secret\nheader' }]) {
    await assert.rejects(loadIfindSnapshot({ env }), error => error.code === 'IFIND_CONFIG' && !error.message.includes('sensitive') && !error.message.includes('secret'));
  }
});
test('official success is nested JSON text with code 1; schema and business errors rejected', () => {
  assert.equal(api.parseTool(valuation(), codes).rows.size, 1);
  const bad = [null, { isError: true, content: [] }, { content: [{ type: 'text', text: 'not json' }] }, tool('not a table', {}), tool('|证券代码|\n|---|', {}, { code: 0 }), tool('|证券代码|\n|---|', {}, { msg: 'failure secret' }), { content: [{ type: 'image', text: '{}' }] }];
  for (const value of bad) assert.throws(() => api.parseTool(value, codes), error => /^IFIND_/.test(error.code) && !error.message.includes('secret'));
});
test('parse exact PE TTM and PB MRQ with source parameter date', () => {
  const e = evidence(valuation());
  assert.equal(e.value, 17.25); assert.equal(e.status, 'ok'); assert.equal(e.asOf, '2026-11-06'); assert.equal(e.period, 'TTM'); assert.equal(e.unit, '倍');
  assert.equal(evidence(valuation(), 'pb_mrq').value, 2.5);
  assert.equal(e.raw.parameterValue, '20261106');
  assert.match(e.note, /get_stock_performance/); assert.match(e.note, /query/);
});
test('source date may come from rows when metadata says latest, never from query', () => {
  assert.equal(evidence(valuation({ parameterDate: '最新', rowDate: '20261106' })).status, 'ok');
  for (const input of [{ parameterDate: '最新' }, { parameterDate: null }, { parameterDate: '2026-11-07' }, { parameterDate: '20261106', rowDate: '20261105' }, { parameterDate: '20261106', rowDate: '--' }, { parameterDate: '20261301' }]) {
    const e = evidence(valuation(input)); assert.equal(e.status, 'missing'); assert.equal(e.value, null); assert.equal(e.asOf, null);
  }
});
test('ROE exact weighted reported field, percent points and catalog period retained', () => {
  const e = evidence(financial(), 'roe');
  assert.equal(e.value, 12.3); assert.equal(e.asOf, '2026-09-30'); assert.equal(e.unit, '%'); assert.equal(e.period, METRICS.find(m => m.id === 'roe').period); assert.match(e.note, /不是公告日期/);
  assert.equal(evidence(financial({ value: '0.123' }), 'roe').value, 0.123);
  assert.equal(evidence(financial({ value: '12.3%' }), 'roe').value, 12.3);
});
test('wrong ROE method, missing units, conflicting periods stay unknown', () => {
  for (const input of [{ field: '净资产收益率ROE(摊薄,公布值)（单位：%）' }, { field: '净资产收益率ROE(加权,公布值)' }, { field: '净资产收益率ROE(加权,公布值)（单位：元）' }, { date: '20260630' }, { parameter: '20260630' }, { parameter: '单季度' }]) assert.equal(evidence(financial(input), 'roe').status, 'missing');
});
test('dynamic PE or generic PB never relabeled, unit mismatches rejected', () => {
  assert.equal(evidence(valuation({ headers: ['动态市盈率', pb] })).status, 'missing');
  assert.equal(evidence(valuation({ headers: [pe, '市净率'] }), 'pb_mrq').status, 'missing');
  assert.equal(evidence(valuation({ headers: [`${pe}（单位：%）`, pb] })).status, 'missing');
  assert.equal(evidence(valuation({ values: ['12%', '2'] })).status, 'missing');
});
test('null markers and malformed numbers do not become zero; finite negative PE survives', () => {
  for (const value of ['', '--', '-', 'null', 'NaN', 'Infinity', '12万元', '1,23', '<script>', '0x10', '1e999']) assert.equal(evidence(valuation({ values: [value, '2'] })).value, null);
  assert.equal(evidence(valuation({ values: ['-11.25', '2'] })).value, -11.25);
  assert.equal(evidence(valuation({ values: ['0', '2'] })).value, 0);
});
test('unknown stock, duplicate stock, mismatched cells and duplicate headers rejected', () => {
  assert.throws(() => api.parseTool(valuation({ code: '999999.SH' }), codes), { code: 'IFIND_SCHEMA' });
  for (const answer of [table(['证券代码', pe], [[codes[0], '1'], [codes[0], '2']]), table(['证券代码', pe, pe], [[codes[0], '1', '2']]), '|证券代码|指标|\n|---|---|\n|600519.SH|']) assert.throws(() => api.parseTool(tool(answer, {}), codes), { code: 'IFIND_SCHEMA' });
  assert.equal(evidence(valuation(), 'pe_ttm', codes[1]).status, 'missing');
});
test('evidence raw is one safe scalar cell, not full payload or malicious metadata', () => {
  const data = valuation({ parameterDate: 'authorization=do-not-display-secret' });
  const e = evidence(data);
  assert.equal(e.value, null); assert.ok(!JSON.stringify(e).includes('do-not-display-secret'));
  assert.deepEqual(Object.keys(e.raw).sort(), ['cell', 'code', 'date', 'field', 'parameter', 'parameterValue'].sort());
});
test('calendar dates validated rather than Date.parse rollover', () => {
  assert.equal(api.date('20260229'), null); assert.equal(api.date('20260230'), null); assert.equal(api.date('20261106'), '2026-11-06');
});
test('MCP initializes, notifies then calls with session and raw Authorization token', async () => {
  const mock = server(); const c = client(mock.fetchImpl); await c.initialize(); await c.call('get_stock_performance', valuationRequest.query);
  assert.deepEqual(mock.calls.map(c => c.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(mock.calls[0].options.headers.Authorization, 'synthetic-test-key');
  assert.equal(mock.calls[2].options.headers['Mcp-Session-Id'], 'synthetic-session');
  assert.equal(mock.calls[2].options.redirect, 'error');
  await assert.rejects(c.call('search_stocks', 'anything'), { code: 'IFIND_SCHEMA' });
});
test('supports SSE response including separate notification event and chunked result', async () => {
  const mock = server(body => {
    if (body.method !== 'tools/call') return null;
    const payload = `: keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: valuation() })}\n\n`;
    return new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(payload); controller.enqueue(bytes.slice(0, 57)); controller.enqueue(bytes.slice(57)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const c = client(mock.fetchImpl); await c.initialize(); assert.equal(evidence(await c.call('get_stock_performance', valuationRequest.query)).status, 'ok');
});
test('HTTP auth, quota, RPC, bad response IDs and missing session are explicit safe failures', async () => {
  for (const [status, code] of [[401, 'IFIND_AUTH'], [403, 'IFIND_AUTH'], [402, 'IFIND_QUOTA'], [429, 'IFIND_QUOTA'], [500, 'IFIND_HTTP']]) {
    await assert.rejects(client(async () => new Response('secret upstream', { status })).initialize(), error => error.code === code && !error.message.includes('secret'));
  }
  for (const payload of [{ jsonrpc: '2.0', id: 1, error: { message: 'secret' } }, { jsonrpc: '2.0', id: 100, result: {} }, { jsonrpc: '2.0', id: 1, result: {} }]) await assert.rejects(client(async () => json(payload)).initialize(), error => /^IFIND_/.test(error.code) && !error.message.includes('secret'));
});
test('network and body exceptions never reflect credential-looking upstream errors', async () => {
  await assert.rejects(client(async () => { throw Error('Authorization=secret'); }).initialize(), error => error.code === 'IFIND_NETWORK' && !error.message.includes('secret'));
  await assert.rejects(client(async () => ({ ok: true, headers: new Headers(), text: () => { throw Object.assign(Error('body-secret'), { code: 'IFIND_FAKE' }); } })).initialize(), error => error.code === 'IFIND_SCHEMA' && !error.message.includes('secret'));
});
test('timeout covers both fetch and stalled response body even when mock ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ ok: true, headers: new Headers(), text: () => new Promise(() => {}) })]) await assert.rejects(client(fetchImpl, { timeoutMs: 15 }).initialize(), { code: 'IFIND_TIMEOUT' });
});
test('rate gate is FIFO, serial and bounded even when a prior action rejects', async () => {
  const gate = api.createGate(30); let active = 0; let max = 0; const starts = [];
  await Promise.allSettled([0, 1, 2].map(i => gate(async () => { starts.push(Date.now()); active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; if (i === 0) throw Error('synthetic'); })));
  assert.equal(max, 1); assert.ok(starts[1] - starts[0] >= 25); assert.ok(starts[2] - starts[1] >= 25);
});
test('oversized bodies rejected instead of parsed', async () => {
  await assert.rejects(client(async () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })).initialize(), { code: 'IFIND_SCHEMA' });
});
test('quota failure stops snapshot before subsequent groups and does not retry', async () => {
  const mock = server(body => body.method === 'tools/call' ? new Response('restricted-secret', { status: 429 }) : null);
  await assert.rejects(loadIfindSnapshot({ env: { IFIND_API_KEY: 'synthetic-key' }, fetchImpl: mock.fetchImpl }), { code: 'IFIND_QUOTA' });
  assert.equal(mock.calls.length, 3);
});
test('all empty tables fail rather than a successful empty snapshot', async () => {
  const mock = server(body => body.method === 'tools/call' ? json({ jsonrpc: '2.0', id: body.id, result: tool(table(['证券代码', pe], []), {}) }) : null);
  await assert.rejects(loadIfindSnapshot({ env: { IFIND_API_KEY: 'synthetic-key' }, fetchImpl: mock.fetchImpl }), { code: 'IFIND_DATA_UNAVAILABLE' });
  assert.equal(mock.calls.length, 8);
});
test('snapshot uses runtime explicit file, 3x4 groups, only 3 verified metrics; synthetic integration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifind-test-'));
  try {
    const config = join(directory, 'config.json'); await writeFile(config, '\uFEFF' + JSON.stringify({ auth_token: 'synthetic-file-key' }), { mode: 0o600 });
    const mock = server(body => {
      if (body.method !== 'tools/call') return null;
      const group = [...body.params.arguments.query.matchAll(/\d{6}\.(?:SH|SZ)/g)].map(m => m[0]);
      assert.equal(group.length, 4);
      const fin = body.params.name === 'get_stock_financials';
      const result = fin ? tool(table(['证券代码', '日期', roe, '营业收入(同比增长率)（单位：%）'], group.map(code => [code, '20260930', '12.30', '8.5'])), { '净资产收益率ROE(加权,公布值)': { 报告期: '最新一期(MRQ)' } }) : tool(table(['证券代码', pe, pb], group.map(code => [code, '17.25', '2.50'])), { [pe]: { 交易日期: '20261106' }, [pb]: { 交易日期: '20261106' } });
      return json({ jsonrpc: '2.0', id: body.id, result });
    });
    const snapshot = await loadIfindSnapshot({ env: { IFIND_CONFIG_PATH: config }, fetchImpl: mock.fetchImpl });
    assert.equal(snapshot.mode, 'ifind'); assert.equal(snapshot.stocks.length, 12); assert.equal(snapshot.asOf, '2026-11-06');
    assert.equal(mock.calls.length, 8); assert.equal(mock.calls[0].options.headers.Authorization, 'synthetic-file-key');
    for (const stock of snapshot.stocks) {
      assert.equal(stock.metrics.roe.status, 'ok'); assert.equal(stock.metrics.pe_ttm.status, 'ok'); assert.equal(stock.metrics.pb_mrq.status, 'ok');
      for (const id of ['revenue_yoy', 'profit_yoy', 'market_cap', 'return_20d', 'volatility_20d']) assert.equal(stock.metrics[id].status, 'missing');
    }
    assert.ok(!JSON.stringify(snapshot).includes('synthetic-file-key'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
