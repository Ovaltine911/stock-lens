import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { METRICS, UNIVERSE } from './catalog.mjs';
import { RESEARCH_POOL } from './data.mjs';

const ENDPOINT = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-stock-mcp';
const SOURCE = '同花顺 iFinD MCP（授权查询，固定日期观察快照）';
const SOURCE_URL = 'https://mcp.51ifind.com/';
const REPORT_DATE = '2026-09-30';
const TRADE_DATE = '2026-11-06';
const MAX_BODY = 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeErrors = new WeakSet();
const failure = (code, message, status = 502) => {
  const error = Object.assign(new Error(message), { code, status });
  safeErrors.add(error);
  return error;
};
const schemaError = () => failure('IFIND_SCHEMA', 'iFinD 返回结构无法核验，未将响应视为有效数据');

export function ifindCapabilities(env = process.env) {
  return { ifindConfigured: Boolean(typeof env.IFIND_API_KEY === 'string' && env.IFIND_API_KEY.trim() || typeof env.IFIND_CONFIG_PATH === 'string' && env.IFIND_CONFIG_PATH.trim()) };
}
async function credentials(env) {
  let key = env.IFIND_API_KEY;
  if (!(typeof key === 'string' && key.trim()) && typeof env.IFIND_CONFIG_PATH === 'string' && env.IFIND_CONFIG_PATH.trim()) {
    try {
      const config = JSON.parse((await readFile(env.IFIND_CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, ''));
      key = config.auth_token;
    } catch { throw failure('IFIND_CONFIG', 'iFinD 显式配置文件无法读取或格式错误，请检查服务端配置', 503); }
  }
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) {
    throw failure('IFIND_CONFIG', 'iFinD 未配置有效凭证；请设置 IFIND_API_KEY 或显式 IFIND_CONFIG_PATH', 503);
  }
  return key.trim();
}

// Module-wide FIFO covers simultaneous snapshot loads as well as MCP handshake.
// At most one HTTP request in flight; start times are at least 600ms apart.
function createGate(interval = 600) {
  let queue = Promise.resolve();
  let startedAt = 0;
  return action => {
    const pending = queue.then(async () => {
      await sleep(Math.max(0, startedAt + interval - Date.now()));
      startedAt = Date.now();
      return action();
    });
    queue = pending.catch(() => {});
    return pending;
  };
}
const requestGate = createGate();

function decodeJson(text) {
  try { return JSON.parse(text); } catch { throw schemaError(); }
}
function checkedRpc(message, id) {
  if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id) throw schemaError();
  if (own(message, 'error')) throw failure('IFIND_RPC', 'iFinD MCP 返回调用错误，请检查服务权益或稍后重试');
  if (!object(message.result)) throw schemaError();
  return message.result;
}
async function readRpc(response, id) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw schemaError();
    return decodeJson(text);
  }
  if (!response.body?.getReader) throw schemaError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > MAX_BODY) throw schemaError();
      buffer = (buffer + decoder.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, '\n');
      if (done && buffer.trim()) buffer += '\n\n';
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const message = decodeJson(data);
        if (message.id === id) return message;
      }
      if (done) throw schemaError();
    }
  } finally { void reader.cancel().catch(() => {}); }
}

function createClient({ apiKey, fetchImpl, gate = requestGate, timeoutMs = 30000 }) {
  let session = null; let id = 0;
  async function post(method, params, notification = false) {
    const requestId = notification ? undefined : ++id;
    return gate(async () => {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(failure('IFIND_TIMEOUT', 'iFinD 请求超时，未返回可用快照，请稍后重试', 504)); }, timeoutMs);
      });
      try {
        return await Promise.race([timeout, (async () => {
          let response;
          try {
            response = await fetchImpl(ENDPOINT, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: apiKey, 'User-Agent': 'stock-lens/0.1.0', ...(session ? { 'Mcp-Session-Id': session } : {}) },
              body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, ...(params ? { params } : {}) }),
            });
          } catch { throw failure('IFIND_NETWORK', 'iFinD 网络请求失败，请稍后重试', 503); }
          if (!response?.ok) {
            const status = response?.status;
            if (status === 401 || status === 403) throw failure('IFIND_AUTH', 'iFinD 认证或权益不足；请检查服务端凭证，不会自动升级付费', 503);
            if (status === 402 || status === 429) throw failure('IFIND_QUOTA', 'iFinD 额度或频率受限；已停止请求，不会自动升级付费', 503);
            throw failure('IFIND_HTTP', 'iFinD HTTP 请求失败，请稍后重试');
          }
          if (notification) { if (response.body?.cancel) void response.body.cancel().catch(() => {}); return null; }
          const result = checkedRpc(await readRpc(response, requestId), requestId);
          if (method === 'initialize') {
            const returned = response.headers?.get?.('mcp-session-id');
            if (typeof returned !== 'string' || !returned || returned.length > 2048 || /[\r\n]/.test(returned)) throw schemaError();
            session = returned;
          }
          return result;
        })()]);
      } catch (error) {
        // Never expose upstream error messages, response bodies, config paths or headers.
        if (safeErrors.has(error)) throw error;
        throw schemaError();
      } finally { clearTimeout(timer); }
    });
  }
  return {
    async initialize() {
      await post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stock-lens', version: '0.1.0' } });
      await post('notifications/initialized', null, true);
    },
    async call(tool, query) {
      if (!['get_stock_financials', 'get_stock_performance'].includes(tool)) throw schemaError();
      return post('tools/call', { name: tool, arguments: { query } });
    },
  };
}

function date(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const formatted = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(formatted)) return null;
  const parsed = new Date(`${formatted}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === formatted ? formatted : null;
}
function normalize(text) { return text.replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[，]/g, ',').replace(/[：]/g, ':').replace(/\s/g, ''); }
function number(text, unit) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value) || (value.endsWith('%') && unit !== '%')) return null;
  const parsed = Number(value.replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function parseTool(result, expectedCodes) {
  if (!object(result) || result.isError === true || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') throw schemaError();
  const envelope = decodeJson(result.content[0].text);
  // Live official probes returned code=1 and msg=success. Do not use another API's code=0 convention.
  if (!object(envelope) || envelope.code !== 1 || envelope.msg !== 'success' || (envelope.subCode != null && envelope.subCode !== 0)) throw failure('IFIND_BUSINESS', 'iFinD 业务查询未成功；请检查数据权益或稍后重试');
  const data = envelope.data;
  if (!object(data) || typeof data.answer !== 'string' || !object(data.indicators_params)) throw schemaError();
  const lines = data.answer.trim().split(/\r?\n/).map(line => line.trim());
  if (lines.length < 2 || lines.length > 10 || lines.some(line => !line.startsWith('|') || !line.endsWith('|'))) throw schemaError();
  const split = line => line.slice(1, -1).split('|').map(cell => cell.trim());
  const headers = split(lines[0]);
  if (headers.length < 2 || headers.length > 20 || new Set(headers.map(normalize)).size !== headers.length || split(lines[1]).length !== headers.length || split(lines[1]).some(cell => !/^:?-{3,}:?$/.test(cell))) throw schemaError();
  const codeIndex = headers.indexOf('证券代码'); const dateIndex = headers.indexOf('日期');
  if (codeIndex < 0) throw schemaError();
  const rows = new Map();
  for (const line of lines.slice(2)) {
    const cells = split(line); const code = cells[codeIndex];
    if (cells.length !== headers.length || !expectedCodes.includes(code) || rows.has(code)) throw schemaError();
    rows.set(code, { cells, rowDate: dateIndex >= 0 ? date(cells[dateIndex]) : null, datePresent: dateIndex >= 0 });
  }
  return { headers, rows, parameters: data.indicators_params };
}
const MATCHES = {
  roe: { field: '净资产收益率ROE(加权,公布值)', suffix: '(单位:%)', unit: '%', expectedDate: REPORT_DATE, parameter: '报告期', period: '报告期' },
  pe_ttm: { field: '市盈率(PE,TTM)', suffix: '', unit: '倍', expectedDate: TRADE_DATE, parameter: '交易日期', period: 'TTM' },
  pb_mrq: { field: '市净率(PB,MRQ)', suffix: '', unit: '倍', expectedDate: TRADE_DATE, parameter: '交易日期', period: 'MRQ' },
};
function missing(metric, note = '当前适配未核验该指标，保持未知。') {
  return { value: null, source: SOURCE, sourceUrl: SOURCE_URL, field: metric.id, asOf: null, period: metric.period, unit: metric.unit, status: 'missing', note };
}
function mappedEvidence(table, code, metricId, request) {
  const spec = MATCHES[metricId];
  const base = missing(METRICS.find(metric => metric.id === metricId));
  const requestNote = `工具 ${request.tool}；参数 ${JSON.stringify({ query: request.query })}。`;
  const index = table.headers.findIndex(header => {
    const name = normalize(header);
    return name === `${spec.field}${spec.suffix}` || (spec.unit === '倍' && name === `${spec.field}(单位:倍)`);
  });
  if (index < 0) return { ...base, note: `${requestNote} 未找到口径与单位完全匹配的源字段。` };
  const field = table.headers[index];
  const paramKey = Object.keys(table.parameters).find(key => normalize(key) === spec.field);
  const params = paramKey ? table.parameters[paramKey] : null;
  const row = table.rows.get(code);
  if (!row) return { ...base, field, note: `${requestNote} 该证券未返回，未使用其他证券补值。` };
  const paramValue = object(params) ? params[spec.parameter] : null;
  const paramDate = date(paramValue);
  const asOf = row.rowDate || paramDate;
  const invalidRowDate = row.datePresent && !row.rowDate;
  const explicitBadParameter = paramValue != null && !paramDate && !['最新', '最新一期(MRQ)'].includes(paramValue);
  const temporalValid = !invalidRowDate && !explicitBadParameter && asOf === spec.expectedDate && (!paramDate || paramDate === spec.expectedDate) && (!row.rowDate || !paramDate || row.rowDate === paramDate);
  const value = number(row.cells[index], spec.unit);
  // Only recognized metadata and one scalar source cell leave this module, never remote free text.
  const raw = { code, field, cell: value === null ? null : row.cells[index], date: row.rowDate, parameter: spec.parameter, parameterValue: paramDate ? paramValue : (['最新', '最新一期(MRQ)'].includes(paramValue) ? paramValue : null) };
  if (!temporalValid) return { ...base, field, raw, note: `${requestNote} 源日期缺失、无效或不等于指定${spec.parameter} ${spec.expectedDate}；没有把请求日期当作返回日期。` };
  if (value === null) return { ...base, field, asOf, raw, period: spec.period, note: `${requestNote} 源值缺失或不是该单位的有限数值。` };
  return { ...base, value, field, asOf, period: spec.period, status: 'ok', raw, note: `${requestNote} ${metricId === 'roe' ? 'asOf 为源报告期末日，不是公告日期或可获得日期；只采用加权公布值，不采用摊薄/年化ROE。' : 'asOf 来自源行日期或该指标交易日期参数；PE/PB为无量纲比率，展示单位为倍。'}${!paramDate ? ' 参数为最新时，仅在源行日期与指定日期一致时接纳。' : ''}` };
}
function requestsFor(codes) {
  const stocks = codes.join('、');
  return [
    { tool: 'get_stock_financials', metrics: ['roe'], query: `${stocks}，报告期2026年三季报（2026-09-30）：年初至报告期末累计营业收入同比增长率、年初至报告期末累计归属母公司股东净利润同比增长率、该报告期加权平均净资产收益率（非年化）。` },
    { tool: 'get_stock_performance', metrics: ['pe_ttm', 'pb_mrq'], query: `${stocks}，交易日期2026年11月6日：市盈率(PE,TTM)、市净率(PB,MRQ)。` },
  ];
}

export async function loadIfindSnapshot({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = await credentials(env);
  const client = createClient({ apiKey, fetchImpl });
  await client.initialize();
  const stocks = RESEARCH_POOL.map(stock => ({ code: stock.code, name: stock.name, industry: stock.industry, metrics: Object.fromEntries(METRICS.map(metric => [metric.id, missing(metric, ['revenue_yoy', 'profit_yoy'].includes(metric.id) ? '上游普通同比字段未明确累计/单季度口径；即使问句指定累计，也不据此冒充累计同比。' : undefined)])) }));
  for (let start = 0; start < stocks.length; start += 4) {
    const group = stocks.slice(start, start + 4); const codes = group.map(stock => stock.code);
    for (const request of requestsFor(codes)) {
      const table = parseTool(await client.call(request.tool, request.query), codes);
      for (const stock of group) for (const metric of request.metrics) stock.metrics[metric] = mappedEvidence(table, stock.code, metric, request);
    }
  }
  const usable = stocks.flatMap(stock => Object.values(stock.metrics)).filter(item => item.status === 'ok');
  if (!usable.length) throw failure('IFIND_DATA_UNAVAILABLE', 'iFinD 已响应，但没有日期、单位与口径均可核验的字段；未生成空成功快照', 503);
  return {
    id: `ifind-${randomUUID()}`, mode: 'ifind', source: SOURCE, asOf: usable.map(item => item.asOf).sort().at(-1), fetchedAt: new Date().toISOString(), universe: UNIVERSE, stocks,
    warnings: [
      `固定日期观察快照：财务报告期 ${REPORT_DATE}；估值交易日 ${TRADE_DATE}。不是实时行情，也不声称回测当时可获得。`,
      '快照 asOf 是已核验字段日期的最大值，不表示所有字段同步；逐字段日期与报告期以证据为准。',
      '营收/归母利润同比的累计口径尚未核验，保持未知；20日波动率、20日收益率、总市值未接入。',
      '12家有限样本分3组，每组4只；每次快照6次工具查询，HTTP串行且间隔至少600ms；可能消耗授权额度。',
      'iFinD 授权数据仅按用户权益使用；未确认再分发许可，不应将快照发布为公共下载或写入源码仓库。',
    ],
  };
}

// Pure parsers and dependency-injected client for synthetic regression tests; no credentials included.
export const __testing = Object.freeze({ createClient, createGate, parseTool, mappedEvidence, requestsFor, date, number });
