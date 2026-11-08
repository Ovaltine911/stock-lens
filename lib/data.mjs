import { UNIVERSE, METRICS, getMetric } from './catalog.mjs';

const FUYAO_BASE = 'https://fuyao.aicubes.cn';
const EASTMONEY_QUOTE_BASE = 'https://push2.eastmoney.com/api/qt/stock/get';
const EASTMONEY_KLINE_BASE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const SOURCE_DOC = 'https://fuyao.aicubes.cn/docs/api-reference/valuations/';
const PUBLIC_QUOTE_DOC = 'https://quote.eastmoney.com/';
const PUBLIC_STALE_AFTER_MS = 7 * 86400000;

const DEMO_UNIVERSE = Object.freeze({
  id: 'research-12',
  label: '12 家虚构公司观察样本',
  description: '用于产品研究的有限合成观察样本；名称与代码均为虚构，不代表 A 股公司、真实行情或投资推荐。',
});

/** Deliberate, finite real-world research pool. This is not a recommendation. */
export const RESEARCH_POOL = Object.freeze([
  ['600519.SH', '贵州茅台', '食品饮料', 'SH'], ['000858.SZ', '五粮液', '食品饮料', 'SZ'],
  ['600036.SH', '招商银行', '银行', 'SH'], ['601318.SH', '中国平安', '非银金融', 'SH'],
  ['000333.SZ', '美的集团', '家用电器', 'SZ'], ['600276.SH', '恒瑞医药', '医药生物', 'SH'],
  ['300750.SZ', '宁德时代', '电力设备', 'SZ'], ['002594.SZ', '比亚迪', '汽车', 'SZ'],
  ['600900.SH', '长江电力', '公用事业', 'SH'], ['601012.SH', '隆基绿能', '电力设备', 'SH'],
  ['000001.SZ', '平安银行', '银行', 'SZ'], ['600030.SH', '中信证券', '非银金融', 'SH'],
].map(([code, name, industry, exchange]) => Object.freeze({ code, name, industry, exchange })));

const DEMO_STOCKS = [
  ['XIN0001.D', '霁岚材料', '新材料', { pe_ttm: 12.4, pb_mrq: 1.8, revenue_yoy: 18.2, profit_yoy: 21.4, roe: 13.1, volatility_20d: 18.6, return_20d: 6.8, market_cap: 428.2 }],
  ['XIN0002.D', '澄海智造', '高端制造', { pe_ttm: 28.1, pb_mrq: 3.7, revenue_yoy: 9.3, profit_yoy: 4.8, roe: 11.2, volatility_20d: 25.4, return_20d: -2.7, market_cap: 816.5 }],
  ['XIN0003.D', '远洲医研', '医药研发', { pe_ttm: null, pb_mrq: 2.9, revenue_yoy: 31.0, profit_yoy: null, roe: 7.4, volatility_20d: 34.2, return_20d: 12.2, market_cap: 267.9 }],
  ['XIN0004.D', '青禾消费', '消费', { pe_ttm: 19.6, pb_mrq: 2.1, revenue_yoy: -3.6, profit_yoy: -8.9, roe: 10.4, volatility_20d: 16.7, return_20d: -4.1, market_cap: 392.8 }],
  ['XIN0005.D', '曜石云算', '软件服务', { pe_ttm: -14.3, pb_mrq: 4.6, revenue_yoy: 42.5, profit_yoy: -18.0, roe: -6.2, volatility_20d: 45.1, return_20d: 8.6, market_cap: 188.4 }],
  ['XIN0006.D', '临川能源', '清洁能源', { pe_ttm: 8.7, pb_mrq: 1.2, revenue_yoy: 14.1, profit_yoy: 16.7, roe: 15.9, volatility_20d: 20.8, return_20d: 3.9, market_cap: 1032.6 }],
  ['XIN0007.D', '北辰装备', '机械设备', { pe_ttm: 34.5, pb_mrq: 5.1, revenue_yoy: 6.2, profit_yoy: 10.0, roe: 9.8, volatility_20d: 28.6, return_20d: 1.2, market_cap: 351.7 }],
  ['XIN0008.D', '禾木食品', '食品饮料', { pe_ttm: 16.2, pb_mrq: 2.0, revenue_yoy: 11.7, profit_yoy: 13.8, roe: 14.0, volatility_20d: null, return_20d: null, market_cap: 299.3 }],
  ['XIN0009.D', '星河医疗', '医疗服务', { pe_ttm: 41.8, pb_mrq: null, revenue_yoy: 20.1, profit_yoy: 5.3, roe: 8.1, volatility_20d: 39.4, return_20d: -7.8, market_cap: null }],
  ['XIN0010.D', '松岳物流', '交通运输', { pe_ttm: 10.9, pb_mrq: 1.5, revenue_yoy: 3.6, profit_yoy: 2.1, roe: 12.0, volatility_20d: 15.9, return_20d: 2.3, market_cap: 462.0 }],
  ['XIN0011.D', '沧澜电子', '电子', { pe_ttm: 22.7, pb_mrq: 3.2, revenue_yoy: 25.8, profit_yoy: 33.1, roe: 16.4, volatility_20d: 31.2, return_20d: 10.1, market_cap: 577.6 }],
  ['XIN0012.D', '白榆环保', '环保', { pe_ttm: 7.4, pb_mrq: 1.0, revenue_yoy: -1.2, profit_yoy: -4.3, roe: 6.8, volatility_20d: 22.0, return_20d: -1.6, market_cap: 146.8 }],
].map(([code, name, industry, values]) => Object.freeze({ code, name, industry, values: Object.freeze(values) }));

// Read metric metadata from the catalog so data and engine cannot drift.
function metricMeta(metric) {
  const spec = getMetric(metric);
  if (!spec) throw new Error(`未知指标：${metric}`);
  return [spec.unit, spec.period];
}
function iso(ms) {
  const value = Number(ms);
  return ms !== null && ms !== undefined && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}
function evidence(value, { source, sourceUrl, field, asOf = null, period, unit, status = value == null ? 'missing' : 'ok', note, raw } = {}) {
  const out = { value: typeof value === 'number' && Number.isFinite(value) ? value : null, source, sourceUrl, field, asOf, period, unit, status };
  if (note) out.note = note;
  if (raw !== undefined) out.raw = raw;
  return out;
}
function demoEvidence(metric, value) {
  const [unit, period] = metricMeta(metric);
  return evidence(value, { source: '合成演示数据（虚构，不是真实行情）', sourceUrl: 'about:blank#synthetic-demo', field: metric, asOf: '2024-12-31T00:00:00.000Z', period, unit, status: value == null ? 'missing' : 'ok', note: '固定历史演示值；公司名和代码均为虚构，不代表真实公司或报价。' });
}
function publicEvidence(metric, value, asOf, field, raw, status = value == null ? 'missing' : 'ok', note, sourceUrl) {
  const [unit, period] = metricMeta(metric);
  return evidence(value, { source: '东方财富公开行情接口', sourceUrl: sourceUrl || (metric === 'volatility_20d' || metric === 'return_20d' ? PUBLIC_QUOTE_DOC : `${EASTMONEY_QUOTE_BASE}?fields=${field}`), field, asOf, period, unit, raw, status, note });
}
function temporalStatus(asOf, now = Date.now(), maxAgeMs = PUBLIC_STALE_AFTER_MS) {
  if (!asOf) return 'missing';
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp)) return 'error';
  if (timestamp > now + 86400000) return 'error';
  if (now - timestamp > maxAgeMs) return 'stale';
  return 'ok';
}
function errorEvidence(metric, source, sourceUrl, note) {
  const [unit, period] = metricMeta(metric);
  return evidence(null, { source, sourceUrl, field: metric, period, unit, status: 'error', note });
}
function missingEvidence(metric, source, sourceUrl, note, asOf = null) {
  const [unit, period] = metricMeta(metric);
  return evidence(null, { source, sourceUrl, field: metric, period, unit, asOf, status: 'missing', note });
}
function stockWithMetrics(base, metrics) { return { code: base.code, name: base.name, industry: base.industry, metrics }; }
function safeMessage(error, fallback = '数据请求失败，请稍后重试') {
  if (error?.code === 'DATA_HTTP') return '数据源 HTTP 请求失败，请稍后重试';
  if (error?.code === 'DATA_SCHEMA') return '数据源响应格式无效，请稍后重试';
  if (error?.code === 'DATA_NETWORK') return '数据源暂时不可用，请稍后重试';
  return fallback;
}

export function dataCapabilities(env = process.env) {
  const fuyaoConfigured = Boolean(env.FUYAO_API_KEY);
  // PUBLIC_DATA_ENABLED is the deployment capability switch. Keep public data
  // opt-in by configuration and never infer availability from a successful past probe.
  const publicAvailable = env.PUBLIC_DATA_ENABLED === 'true';
  return { fuyaoConfigured, publicAvailable };
}

function timeoutFetch(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve().then(async () => {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response?.json) return response;
    const originalJson = response.json.bind(response);
    response.json = () => {
      let timerId;
      const timeout = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(Object.assign(new Error('body timeout'), { name: 'AbortError' })), timeoutMs);
      });
      return Promise.race([originalJson(), timeout]).finally(() => clearTimeout(timerId));
    };
    return response;
  }).finally(() => clearTimeout(timer));
}
async function requestJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await timeoutFetch(fetchImpl, url, options); } catch (error) {
    const e = new Error(error?.name === 'AbortError' ? '数据请求超时，请稍后重试' : '数据请求失败，请稍后重试'); e.code = 'DATA_NETWORK'; e.status = 503; throw e;
  }
  if (!response || !response.ok) { const e = new Error('数据请求失败，请稍后重试'); e.code = 'DATA_HTTP'; e.status = 502; throw e; }
  let body;
  try { body = await response.json(); } catch { const e = new Error('数据请求失败，响应格式无效'); e.code = 'DATA_SCHEMA'; e.status = 502; throw e; }
  // Fuyao documents HTTP 200 business failures in the envelope.
  if (body && body.code !== undefined && body.code !== 0) { const e = new Error('数据服务返回业务错误，请稍后重试'); e.code = `FUYAO_${body.code}`; e.status = 502; e.upstreamCode = body.code; throw e; }
  return body;
}

function parseEastmoneyQuote(body, code) {
  if (!body || body.rc !== 0 || !body.data) throw Object.assign(new Error('quote schema'), { code: 'DATA_SCHEMA' });
  const d = body.data;
  if (String(d.f57 ?? '') !== code.slice(0, 6)) throw Object.assign(new Error('quote code'), { code: 'DATA_SCHEMA' });
  const n = (v, divisor = 1) => {
    if (v === null || v === undefined || (typeof v === 'string' && (!v.trim() || ['-', '--', 'null'].includes(v.trim().toLowerCase())))) return null;
    const number = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(number) ? number / divisor : null;
  };
  // Eastmoney f162 is commonly documented/observed as dynamic PE. Without a
  // stable upstream statement that it is TTM, never relabel it as pe_ttm.
  const quoteTimestamp = n(d.f124, 1);
  return { dynamicPe: n(d.f162, 100), pb: n(d.f167, 100), marketCap: n(d.f116, 1e8), quoteTimestamp: quoteTimestamp && quoteTimestamp > 0 ? quoteTimestamp : null, name: typeof d.f58 === 'string' ? d.f58 : null };
}
function parseKlines(body) {
  if (!body || body.rc !== 0 || !body.data || !Array.isArray(body.data.klines)) throw Object.assign(new Error('kline schema'), { code: 'DATA_SCHEMA' });
  const rows = body.data.klines.map((row) => { const [date, close] = String(row).split(','); return { date, close: Number(close), raw: String(row) }; }).filter((r) => /^\d{4}-\d\d-\d\d$/.test(r.date) && Number.isFinite(r.close) && r.close > 0);
  if (rows.length < 21) throw new Error('公开 K 线不足 21 个交易日，无法计算 20 日指标');
  return rows.slice(-21);
}
function calcKline(input) {
  if (!Array.isArray(input) || input.length < 21) throw Object.assign(new Error('至少需要21个交易日收盘价'), { code: 'DATA_SCHEMA' });
  const rows = input.slice(-21);
  if (rows.some((r, index) => !Number.isFinite(r.close) || r.close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(Date.parse(r.date)) || (index > 0 && r.date <= rows[index - 1].date))) throw Object.assign(new Error('价格序列包含无效值或日期顺序异常'), { code: 'DATA_SCHEMA' });
  const returns = rows.slice(1).map((r, i) => Math.log(r.close / rows[i].close));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + ((b - mean) ** 2), 0) / (returns.length - 1);
  return {
    volatility: Math.sqrt(variance) * Math.sqrt(252) * 100,
    return20d: (rows.at(-1).close / rows[0].close - 1) * 100,
    asOf: `${rows.at(-1).date}T00:00:00.000Z`,
    raw: rows.map(({ date, close, raw }) => ({ date, close, raw: raw ?? `${date},${close}` })),
  };
}
function eastmoneyUrl(code) {
  const market = code.endsWith('.SH') ? '1' : '0';
  return `${EASTMONEY_QUOTE_BASE}?secid=${market}.${code.slice(0, 6)}&fields=f57,f58,f116,f124,f162,f167`;
}
function eastmoneyKlineUrl(code) {
  const market = code.endsWith('.SH') ? '1' : '0';
  const end = new Date();
  const start = new Date(end.getTime() - 100 * 86400000);
  const stamp = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');
  return `${EASTMONEY_KLINE_BASE}?secid=${market}.${code.slice(0, 6)}&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&beg=${stamp(start)}&end=${stamp(end)}`;
}

async function loadPublic({ fetchImpl }) {
  const stocks = [];
  let successfulStocks = 0;
  const warnings = ['公开行情接口仅覆盖估值快照与价格序列；财务同比/ROE 未从未经核验来源补值。', '不同公开接口的时间元数据不保证逐字段同步；估值字段 asOf 仅在上游提供时记录。'];
  // At most four in-flight requests; each stock has quote then K-line to keep failure attribution explicit.
  let cursor = 0;
  async function worker() {
    while (cursor < RESEARCH_POOL.length) {
      const item = RESEARCH_POOL[cursor++];
      try {
        const quote = parseEastmoneyQuote(await requestJson(fetchImpl, eastmoneyUrl(item.code)), item.code);
        let kline;
        try { kline = calcKline(parseKlines(await requestJson(fetchImpl, eastmoneyKlineUrl(item.code)))); } catch (error) { kline = { error }; }
        const asOf = kline?.asOf ?? null;
        const quoteAsOf = iso(quote.quoteTimestamp == null ? null : quote.quoteTimestamp < 1e12 ? quote.quoteTimestamp * 1000 : quote.quoteTimestamp);
        const klineUrl = eastmoneyKlineUrl(item.code);
        const quoteStatus = temporalStatus(quoteAsOf);
        const quoteUrl = eastmoneyUrl(item.code);
        const metrics = {
          pe_ttm: missingEvidence('pe_ttm', '东方财富公开行情接口', quoteUrl, 'f162 仅核验为动态 PE，无法确认 TTM，故保持未知。', quoteAsOf),
          pb_mrq: publicEvidence('pb_mrq', quoteStatus === 'error' || quoteStatus === 'missing' ? null : quote.pb, quoteAsOf, 'f167', quote.pb, quoteStatus, quoteStatus === 'stale' ? '行情更新时间超过7个自然日，标记过期。' : quoteStatus === 'error' ? '行情更新时间无效或位于未来。' : quoteStatus === 'missing' ? '行情更新时间缺失，不能确认数据新鲜度。' : undefined, quoteUrl),
          market_cap: publicEvidence('market_cap', quoteStatus === 'error' || quoteStatus === 'missing' ? null : quote.marketCap, quoteAsOf, 'f116', quote.marketCap, quoteStatus, quoteStatus === 'stale' ? '行情更新时间超过7个自然日，标记过期。' : quoteStatus === 'error' ? '行情更新时间无效或位于未来。' : quoteStatus === 'missing' ? '行情更新时间缺失，不能确认数据新鲜度。' : undefined, quoteUrl),
          volatility_20d: kline.error ? errorEvidence('volatility_20d', '东方财富公开 K 线接口', klineUrl, safeMessage(kline.error)) : publicEvidence('volatility_20d', temporalStatus(asOf) === 'error' ? null : kline.volatility, asOf, 'klines.close', kline.raw, temporalStatus(asOf), temporalStatus(asOf) === 'error' ? 'K线末日位于未来，拒绝作为有效当前数据。' : temporalStatus(asOf) === 'stale' ? 'K线末日超过7个自然日，标记过期；节假日可能误伤。' : undefined, klineUrl),
          return_20d: kline.error ? errorEvidence('return_20d', '东方财富公开 K 线接口', klineUrl, safeMessage(kline.error)) : publicEvidence('return_20d', temporalStatus(asOf) === 'error' ? null : kline.return20d, asOf, 'klines.close', kline.raw, temporalStatus(asOf), temporalStatus(asOf) === 'error' ? 'K线末日位于未来，拒绝作为有效当前数据。' : temporalStatus(asOf) === 'stale' ? 'K线末日超过7个自然日，标记过期；节假日可能误伤。' : undefined, klineUrl),
        };
        for (const metric of ['revenue_yoy', 'profit_yoy', 'roe']) metrics[metric] = missingEvidence(metric, '未接入可核验公开财务源', PUBLIC_QUOTE_DOC, '未使用行情接口推导财务指标，保持未知。');
        successfulStocks += 1;
        stocks.push(stockWithMetrics({ ...item, name: quote.name || item.name }, metrics));
      } catch (error) {
        const message = safeMessage(error);
        const metrics = Object.fromEntries(METRICS.map(({ id: metric }) => [metric, errorEvidence(metric, '东方财富公开行情接口', eastmoneyUrl(item.code), message)]));
        stocks.push(stockWithMetrics(item, metrics));
        warnings.push(`${item.code} 公开数据失败：${message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  if (successfulStocks === 0) {
    const error = new Error('公开数据源全部请求失败，请稍后重试');
    error.code = 'DATA_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  stocks.sort((a, b) => RESEARCH_POOL.findIndex((x) => x.code === a.code) - RESEARCH_POOL.findIndex((x) => x.code === b.code));
  return { stocks, warnings, asOf: stocks.flatMap((s) => Object.values(s.metrics).filter((e) => e.status !== 'error').map((e) => e.asOf).filter(Boolean)).sort().at(-1) ?? null };
}

async function loadFuyao({ fetchImpl, apiKey }) {
  const codes = RESEARCH_POOL.map((x) => x.code).join(',');
  const headers = { 'X-api-key': apiKey };
  const valuationUrl = `${FUYAO_BASE}/api/a-share/valuations/snapshot?thscodes=${codes}`;
  const valuationBody = await requestJson(fetchImpl, valuationUrl, { headers });
  if (!valuationBody.data || !Array.isArray(valuationBody.data.item)) throw Object.assign(new Error('同花顺估值响应缺少 data.item'), { code: 'DATA_SCHEMA' });
  const byCode = new Map(valuationBody.data.item.map((x) => [x.thscode, x]));
  const warnings = ['同花顺估值 timestamp 是本次响应上游指标元数据最大有效时间，不表示所有字段逐项同步。', '同花顺财务指标未配置接入，财务同比/ROE 保持未知。'];
  const snapshots = [];
  for (let i = 0; i < RESEARCH_POOL.length; i += 10) {
    const group = RESEARCH_POOL.slice(i, i + 10).map((x) => x.code).join(',');
    const start = Date.now() - 90 * 86400000;
    const end = Date.now();
    const url = `${FUYAO_BASE}/api/a-share/prices/historical-batch?thscodes=${group}&interval=1d&start=${start}&end=${end}&adjust=forward`;
    try { snapshots.push((await requestJson(fetchImpl, url, { headers })).data); } catch (error) { warnings.push(`K线批次失败：${safeMessage(error)}`); snapshots.push(null); }
  }
  const bars = new Map();
  for (const batch of snapshots) for (const item of (batch?.item ?? [])) {
    try {
      const rows = item.item.map((x) => ({ date: new Date(x.date_ms).toISOString().slice(0, 10), close: Number(x.close_price), raw: { date_ms: x.date_ms, close_price: x.close_price } })).filter((x) => Number.isFinite(x.close));
      bars.set(item.thscode, calcKline(rows));
    } catch { /* missing is represented below */ }
  }
  const valuationTimestamp = iso(valuationBody.data.timestamp);
  const valuationStatus = temporalStatus(valuationTimestamp);
  const stocks = RESEARCH_POOL.map((item) => {
    const v = byCode.get(item.code); const k = bars.get(item.code);
    const valuationNote = valuationStatus === 'stale' ? '响应 timestamp 超过7个自然日，标记过期；该 timestamp 是上游最大有效时间，不代表所有字段逐项同步。' : valuationStatus === 'error' ? '响应 timestamp 无效或位于未来，拒绝作为当前有效估值。' : valuationStatus === 'missing' ? '响应 timestamp 缺失，不能确认估值新鲜度。' : '响应 timestamp 是上游最大有效时间，不代表该字段逐项同步。';
    const valuationValueStatus = v && v.pe_ttm != null ? valuationStatus : 'missing';
    const pbValueStatus = v && v.pb_mrq != null ? valuationStatus : 'missing';
    const klineStatus = temporalStatus(k?.asOf);
    const klineNote = klineStatus === 'stale' ? 'K线末日超过7个自然日，标记过期；节假日可能误伤。' : klineStatus === 'error' ? 'K线末日无效或位于未来，拒绝作为当前有效数据。' : klineStatus === 'missing' ? 'K线时点缺失，不能确认新鲜度。' : '由最近21根前复权日线收盘价计算。';
    const klineUrl = `${FUYAO_BASE}/api/a-share/prices/historical-batch?thscodes=${encodeURIComponent(item.code)}&interval=1d&adjust=forward`;
    const metrics = {
      pe_ttm: evidence(v?.pe_ttm ?? null, { source: '同花顺金融数据 API', sourceUrl: valuationUrl, field: 'pe_ttm', asOf: valuationTimestamp, period: 'TTM', unit: '倍', status: valuationValueStatus, note: valuationNote, raw: v?.pe_ttm }),
      pb_mrq: evidence(v?.pb_mrq ?? null, { source: '同花顺金融数据 API', sourceUrl: valuationUrl, field: 'pb_mrq', asOf: valuationTimestamp, period: 'MRQ', unit: '倍', status: pbValueStatus, note: valuationNote, raw: v?.pb_mrq }),
      volatility_20d: k ? evidence(klineStatus === 'ok' ? k.volatility : null, { source: '同花顺金融数据 API', sourceUrl: klineUrl, field: 'close_price', asOf: k.asOf, period: metricMeta('volatility_20d')[1], unit: metricMeta('volatility_20d')[0], status: klineStatus, note: `${klineNote} 年化因子√252。`, raw: k.raw }) : missingEvidence('volatility_20d', '同花顺金融数据 API', klineUrl, 'K线不足或未返回。'),
      return_20d: k ? evidence(klineStatus === 'ok' ? k.return20d : null, { source: '同花顺金融数据 API', sourceUrl: klineUrl, field: 'close_price', asOf: k.asOf, period: '20D', unit: '%', status: klineStatus, note: `${klineNote} 由首尾收盘价计算。`, raw: k.raw }) : missingEvidence('return_20d', '同花顺金融数据 API', klineUrl, 'K线不足或未返回。'),
    };
    for (const metric of ['revenue_yoy', 'profit_yoy', 'roe', 'market_cap']) metrics[metric] = missingEvidence(metric, '同花顺金融数据 API（当前适配未接入）', SOURCE_DOC, metric === 'market_cap' ? '估值端点未提供总市值，保持未知。' : '财务指标端点未接入，保持未知。');
    return stockWithMetrics({ ...item, name: v?.name || item.name }, metrics);
  });
  const asOf = [valuationTimestamp, ...stocks.flatMap((s) => Object.values(s.metrics).map((e) => e.asOf))].filter(Boolean).sort().at(-1) ?? null;
  return { stocks, warnings, asOf };
}

export function createDemoSnapshot() {
  const fetchedAt = new Date().toISOString();
  return {
    id: `demo-${Date.now()}`, mode: 'demo', source: '合成演示数据（虚构样本）', asOf: '2024-12-31T00:00:00.000Z', fetchedAt,
    universe: DEMO_UNIVERSE, warnings: ['这是固定合成演示数据：12 家公司名称与代码均为虚构，不代表 A 股公司、行情或投资推荐。'],
    stocks: DEMO_STOCKS.map((s) => {
      const annualValues = { revenue_yoy_annual: s.values.revenue_yoy, profit_yoy_annual: s.values.profit_yoy };
      return stockWithMetrics(s, Object.fromEntries(Object.entries({ ...s.values, ...annualValues }).map(([metric, value]) => [metric, demoEvidence(metric, value)])));
    }),
  };
}

export async function loadSnapshot(mode, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (mode === 'demo') return createDemoSnapshot();
  if (mode === 'auto') {
    const { loadAutoSnapshot } = await import('./auto-data.mjs');
    return loadAutoSnapshot({ env, fetchImpl });
  }
  if (mode === 'ifind') {
    const { loadIfindSnapshot } = await import('./ifind.mjs');
    return loadIfindSnapshot({ env, fetchImpl });
  }
  if (mode === 'public') {
    if (!dataCapabilities(env).publicAvailable) { const e = new Error('公开数据源未启用，无法加载公开快照'); e.code = 'DATA_UNAVAILABLE'; e.status = 503; throw e; }
    const loaded = await loadPublic({ fetchImpl });
    return { id: `public-${Date.now()}`, mode, source: '东方财富公开行情接口', asOf: loaded.asOf, fetchedAt: new Date().toISOString(), universe: UNIVERSE, warnings: loaded.warnings, stocks: loaded.stocks };
  }
  if (mode === 'fuyao') {
    const apiKey = env.FUYAO_API_KEY;
    if (!apiKey) { const e = new Error('同花顺数据源未配置 API Key，无法加载快照'); e.code = 'DATA_UNAVAILABLE'; e.status = 503; throw e; }
    const loaded = await loadFuyao({ fetchImpl, apiKey });
    return { id: `fuyao-${Date.now()}`, mode, source: '同花顺金融数据 API', asOf: loaded.asOf, fetchedAt: new Date().toISOString(), universe: UNIVERSE, warnings: loaded.warnings, stocks: loaded.stocks };
  }
  const e = new Error('不支持的数据模式'); e.code = 'DATA_MODE'; e.status = 400; throw e;
}

export { calcKline, parseKlines, parseEastmoneyQuote };
