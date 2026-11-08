import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { METRICS, UNIVERSE, getMetric } from './catalog.mjs';
import { RESEARCH_POOL } from './data.mjs';

const BASE = 'https://fuyao.aicubes.cn';
const SOURCE = '同花顺扶摇金融数据 API';
const DOC = `${BASE}/docs/api-reference/`;
const DAY = 86400000;
const safeErrors = new WeakSet();
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const configured = (env, prefix) => ['API_KEY', 'CONFIG_PATH'].some(suffix => typeof env[`${prefix}_${suffix}`] === 'string' && env[`${prefix}_${suffix}`].trim());
function failure(code, message, status = 502) {
  const error = Object.assign(new Error(message), { code, status });
  safeErrors.add(error);
  return error;
}
const schema = () => failure('FUYAO_SCHEMA', '扶摇返回结构无法核验，未将响应视为有效数据');
const safeError = error => safeErrors.has(error) ? error : failure('DATA_UNAVAILABLE', '自动数据读取失败，未生成有效快照', 503);
export function autoDataCapabilities(env = process.env) { return { autoAvailable: configured(env, 'FUYAO') || configured(env, 'IFIND') }; }

async function credentials(env) {
  let key = env.FUYAO_API_KEY;
  if (!(typeof key === 'string' && key.trim()) && typeof env.FUYAO_CONFIG_PATH === 'string' && env.FUYAO_CONFIG_PATH.trim()) {
    try { key = JSON.parse((await readFile(env.FUYAO_CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, '')).FUYAO_API_KEY; }
    catch { throw failure('FUYAO_CONFIG', '扶摇显式配置文件无法读取或格式错误，请检查服务端配置', 503); }
  }
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw failure('FUYAO_CONFIG', '扶摇未配置有效凭证，请检查服务端环境或显式配置', 503);
  return key.trim();
}

// Shared semaphore, including response bodies; server owns cache/singleflight.
function createGate(limit = 2) {
  let active = 0; const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const { action, resolve, reject } = queue.shift(); active++;
      Promise.resolve().then(action).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return action => new Promise((resolve, reject) => { queue.push({ action, resolve, reject }); pump(); });
}
const requestGate = createGate();
let ifindRequestGate;
function createClient({ apiKey, fetchImpl, timeoutMs = 12000, gate = requestGate }) {
  return (path, params = {}) => gate(async () => {
    const url = new URL(`/api/a-share/${path}`, BASE); url.search = new URLSearchParams(params);
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('FUYAO_TIMEOUT', '扶摇数据请求超时，请稍后重试', 504)); }, timeoutMs); });
    try {
      return await Promise.race([timeout, (async () => {
        let response;
        try { response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { 'X-api-key': apiKey, Accept: 'application/json' } }); }
        catch { throw failure('FUYAO_NETWORK', '扶摇网络请求失败，请稍后重试', 503); }
        if (!response?.ok) {
          const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 && !String(response.status).includes(apiKey) ? response.status : null;
          throw failure('FUYAO_HTTP', `扶摇数据请求失败${status ? `（状态码 ${status}）` : ''}，请检查服务权益或稍后重试；不会自动升级付费`, status === 429 ? 503 : 502);
        }
        let body;
        try {
          const text = await response.text();
          if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw schema();
          body = JSON.parse(text);
        } catch { throw schema(); }
        if (!isObject(body) || !Number.isInteger(body.code)) throw schema();
        if (body.code !== 0) {
          const code = body.code >= 0 && body.code <= 99999 && !String(body.code).includes(apiKey) ? body.code : null;
          throw failure('FUYAO_BUSINESS', `扶摇业务查询失败${code !== null ? `（业务码 ${code}）` : ''}，请检查服务权益或稍后重试；不会自动升级付费`);
        }
        if (!isObject(body.data)) throw schema();
        // Reflected credentials are never usable source values, including numeric
        // strings. Scrub at the trust boundary before any whitelist mapping.
        const secrets = [apiKey, encodeURIComponent(apiKey)];
        const scrub = value => {
          if ((typeof value === 'string' || typeof value === 'number') && secrets.some(secret => String(value).includes(secret))) return null;
          if (Array.isArray(value)) return value.map(scrub);
          if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !secrets.some(secret => key.includes(secret))).map(([key, item]) => [key, scrub(item)]));
          return value;
        };
        return scrub(body.data);
      })()]);
    } catch (error) { throw safeErrors.has(error) ? error : schema(); }
    finally { clearTimeout(timer); }
  });
}

const shanghai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function dateMs(value) {
  if (finite(value) === null || value < 0 || value > 8640000000000000) return null;
  try { return shanghai.format(new Date(value)); } catch { return null; }
}
function date(value) {
  if (typeof value !== 'string') return null;
  const s = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? s : null;
}
const midnight = day => Date.parse(`${day}T00:00:00+08:00`);
function calendar(data, start, end) {
  if (!Array.isArray(data.item) || !data.item.length) throw failure('FUYAO_CALENDAR', '扶摇交易日历为空，无法确认最近交易日，未伪造日期', 503);
  const days = data.item.map(row => {
    const d = date(row?.date);
    if (!d || dateMs(row.date_ms) !== d || d < start || d > end) throw schema();
    return d;
  });
  if (new Set(days).size !== days.length || days.some((d, i) => i > 0 && d <= days[i - 1])) throw schema();
  return days;
}
function grouped(data, codes) {
  if (!Array.isArray(data.item)) throw schema();
  const map = new Map();
  for (const row of data.item) {
    if (!isObject(row) || !codes.includes(row.thscode) || map.has(row.thscode)) throw schema();
    map.set(row.thscode, row);
  }
  return map;
}
function ev(id, value = null, fields = {}) {
  const spec = getMetric(id);
  if (!spec) throw failure('DATA_CATALOG', '指标目录未配置自动数据所需字段', 503);
  return { value, source: SOURCE, sourceUrl: DOC, field: id, asOf: null, period: spec.period, unit: spec.unit, status: value === null ? 'missing' : 'ok', ...fields };
}
function initialStocks() {
  return RESEARCH_POOL.map(({ code, name, industry }) => ({ code, name, industry, metrics: Object.fromEntries(METRICS.map(({ id }) => [id, ev(id, null, { note: ['revenue_yoy', 'profit_yoy'].includes(id) ? '源同比字段的累计或单季度语义未核验；年度增长不冒充季度或报告期累计同比。' : id === 'market_cap' ? '已接入端点未提供有明确单位的总市值，不推测或补零。' : '该证券的可核验源数据尚未返回。' })])) }));
}
function annualEvidence(group, code, id, asOf, observedAt = asOf) {
  const field = id === 'revenue_yoy_annual' ? 'operating_income' : 'parent_holder_net_profit';
  const base = { sourceUrl: `${DOC}financials/`, field, note: '需要相邻两年同币种原币元的完整年度合并报表；年度同比不等同经营拐点。' };
  if (!Array.isArray(group?.item) || group.item.length !== 2) return ev(id, null, base);
  const records = group.item.map(r => ({
    thscode: r.thscode === code ? code : null, period: r.period === 'annual' ? 'annual' : null,
    fiscal_year: Number.isInteger(r.fiscal_year) && r.fiscal_year >= 1900 && r.fiscal_year <= 2200 ? r.fiscal_year : null,
    fiscal_period: ['FY', 'Q4'].includes(r.fiscal_period) ? r.fiscal_period : null,
    period_end_ms: dateMs(r.period_end_ms) ? r.period_end_ms : null,
    report_date_ms: dateMs(r.report_date_ms) ? r.report_date_ms : null,
    currency: r.currency === 'CNY' ? 'CNY' : null,
    operating_income: finite(r.operating_income), parent_holder_net_profit: finite(r.parent_holder_net_profit),
  })).sort((a, b) => (b.fiscal_year || 0) - (a.fiscal_year || 0));
  const [current, previous] = records;
  const raw = { records, amountUnit: '原币元', currentYear: current.fiscal_year, baseYear: previous.fiscal_year, numerator: current[field], denominator: previous[field], formula: '(current / base - 1) * 100' };
  const common = { ...base, raw };
  const valid = records.every(r => r.thscode === code && r.period === 'annual' && r.fiscal_year && r.fiscal_period && r.currency === 'CNY' && dateMs(r.period_end_ms) === `${r.fiscal_year}-12-31` && dateMs(r.period_end_ms) <= asOf && r.report_date_ms !== null && dateMs(r.report_date_ms) >= dateMs(r.period_end_ms) && dateMs(r.report_date_ms) <= observedAt) && current.fiscal_year === previous.fiscal_year + 1;
  // Optional unit metadata must not contradict the documented original-currency yuan.
  const unitsValid = group.item.every(r => ['unit', 'amount_unit'].every(k => r[k] == null || ['元', '原币元'].includes(r[k])));
  if (!valid || !unitsValid) return ev(id, null, { ...common, note: `${base.note} 年份、币种、金额单位、证券身份或报告元数据不一致，保持未知。` });
  if (current[field] === null || previous[field] === null || previous[field] <= 0) return ev(id, null, { ...common, asOf: dateMs(current.period_end_ms), note: `${base.note} 金额缺失或基年分母非正；亏损或扭亏不能使用常规同比增速替代。` });
  const value = (current[field] / previous[field] - 1) * 100;
  if (!Number.isFinite(value)) return ev(id, null, common);
  return ev(id, value, { ...common, asOf: dateMs(current.period_end_ms), note: '同一扶摇年度合并利润表的相邻两年原值计算，未对金额四舍五入。年度同比仅表示年度增长，不等同最近季度经营拐点。证据日期为报告期末；披露日可能是修订日，不代表首次公告或历史时点可得性，不用于回测。' });
}
function klineEvidence(group, code, data, days) {
  const ids = ['volatility_20d', 'return_20d'];
  const base = { sourceUrl: `${DOC}prices/`, field: 'close_price', note: '需要与交易日历末端完全对齐的21个不重复日期及有限正收盘价，且为前复权日线。' };
  const unknown = () => Object.fromEntries(ids.map(id => [id, ev(id, null, base)]));
  if (data.interval !== '1d' || data.adjust !== 'forward' || !Array.isArray(group?.item) || group.item.length < 21 || days.length < 21) return unknown();
  const rows = group.item.map(r => ({ date: dateMs(r.date_ms), date_ms: finite(r.date_ms), close_price: finite(r.close_price) }));
  if (rows.some((r, i) => !r.date || !days.includes(r.date) || r.close_price === null || r.close_price <= 0 || (i > 0 && r.date <= rows[i - 1].date))) return unknown();
  const selected = rows.slice(-21); const expected = days.slice(-21);
  if (selected.some((r, i) => r.date !== expected[i])) return unknown();
  const returns = selected.slice(1).map((r, i) => Math.log(r.close_price) - Math.log(selected[i].close_price));
  const mean = returns.reduce((a, b) => a + b, 0) / 20;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / 19;
  const values = [Math.sqrt(variance) * Math.sqrt(252) * 100, (selected.at(-1).close_price / selected[0].close_price - 1) * 100];
  return Object.fromEntries(ids.map((id, i) => [id, ev(id, finite(values[i]), { ...base, asOf: expected.at(-1), raw: { thscode: code, interval: '1d', adjust: 'forward', rows: selected }, note: i === 0 ? '最近21个日历对齐的前复权收盘价，20个对数收益率的样本标准差（分母19）×√252×100；日期按上海时区。' : '最近21个日历对齐的前复权收盘价，末价除以首价减一再乘100；不构成收益承诺。' })]));
}
function reportFor(asOf) {
  const year = Number(asOf.slice(0, 4)); const q = Math.ceil(Number(asOf.slice(5, 7)) / 3) - 1;
  return q === 0 ? `${year - 1}-4` : `${year}-${q}`;
}
function reportDate(report) {
  return /^\d{4}-[1-4]$/.test(report || '') ? `${report.slice(0, 4)}-${{ 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }[report.at(-1)]}` : null;
}
function roeEvidence(data, code, report, asOf) {
  const field = 'index_weighted_avg_roe';
  const base = { sourceUrl: `${DOC}financial-indicators/`, field, note: '加权净资产收益率需匹配证券、报告期与明确百分数值单位；未用摊薄、扣非或年化值替代。' };
  if (data.thscode !== code || data.report !== report || !Array.isArray(data.abilities) || !reportDate(report) || reportDate(report) > asOf) return ev('roe', null, base);
  const rows = data.abilities.flatMap(a => a.ability === 'profitability' && Array.isArray(a.indicators) ? a.indicators.filter(x => x.index_id === field) : []);
  if (rows.length !== 1) return ev('roe', null, base);
  const row = rows[0]; const text = typeof row.value === 'string' && row.value.length <= 80 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.value.trim()) ? row.value.trim() : null;
  const value = text === null ? null : finite(Number(text));
  // Official field contract, verified 2026-11-08: yield/percentage values are
  // percentage points (89.12 means 89.12%), NOT fractions. Never infer by size.
  const unitValid = [row.unit, data.unit].every(x => x == null || ['%', '百分比', '百分数值', 'percentage'].includes(x));
  if (value === null || !unitValid) return ev('roe', null, { ...base, note: `${base.note} 源值或单位无法核验，保持未知。` });
  return ev('roe', value, { ...base, asOf: reportDate(report), raw: { thscode: code, report, index_id: field, value: text, sourceUnit: '百分数值', scale: 1 }, note: '官方财务指标文档明确收益率按百分数值表达，原值直接作为百分比，不乘100；仅使用加权字段。日期来自响应报告期，不是公告日或可获得日期；最近完整季度未披露时保持未知，不自动猜测前期值。' });
}

async function primary({ env, fetchImpl, nowMs }) {
  const key = await credentials(env); const request = createClient({ apiKey: key, fetchImpl });
  const today = dateMs(nowMs); const start = dateMs(nowMs - 99 * DAY);
  const days = calendar(await request('calendar/trading-days', { start_date: start.replaceAll('-', ''), end_date: today.replaceAll('-', '') }), start, today);
  const asOf = days.at(-1); const stocks = initialStocks();
  const warnings = [
    '12家A股有限观察样本，非全市场；仅按用户授权权益使用数据，不承诺再分发许可。',
    '快照日期固定为交易日历最近交易日；逐字段日期可能不同。估值响应时间是上游指标元数据最大时间，可能晚于最近交易日，不表示所有估值字段同时更新。',
    '年度同比不等同最近季度经营拐点；报告期、披露或修订日与首次可获得日期不能混同，不用于无前视偏差回测。',
    '累计或单季度财务同比、总市值未核验，保持未知，不使用年度指标或估计单位替代。',
  ];
  const successes = { valuation: 0, prices: 0, annual: 0 };
  const moduleErrors = {};
  for (const kind of ['valuation', 'prices', 'annual']) {
    await Promise.all([stocks.slice(0, 10), stocks.slice(10)].map(async group => {
      const codes = group.map(s => s.code); const path = { valuation: 'valuations/snapshot', prices: 'prices/historical-batch', annual: 'financials/income-statements-batch' }[kind];
      const params = { thscodes: codes.join(','), ...(kind === 'prices' ? { interval: '1d', adjust: 'forward', start: midnight(start), end: midnight(asOf) + DAY - 1 } : kind === 'annual' ? { period: 'annual', limit: 2 } : {}) };
      const metricIds = { valuation: ['pe_ttm', 'pb_mrq'], prices: ['volatility_20d', 'return_20d'], annual: ['revenue_yoy_annual', 'profit_yoy_annual'] }[kind];
      try {
        const data = await request(path, params); const map = grouped(data, codes); successes[kind]++;
        for (const stock of group) {
          const row = map.get(stock.code);
          if (kind === 'prices') Object.assign(stock.metrics, klineEvidence(row, stock.code, data, days));
          else if (kind === 'annual') for (const id of metricIds) stock.metrics[id] = annualEvidence(row, stock.code, id, asOf, today);
          else {
            const stamp = dateMs(data.timestamp);
            const validDate = stamp && data.timestamp <= nowMs && stamp >= asOf;
            for (const id of metricIds) stock.metrics[id] = ev(id, validDate ? finite(row?.[id]) : null, { sourceUrl: `${DOC}valuations/`, field: id, asOf: stamp, raw: { thscode: stock.code, value: finite(row?.[id]), timestamp: dateMs(data.timestamp) ? data.timestamp : null }, note: validDate ? '源估值比率单位为倍。证据日期是本响应上游元数据最大时间，不是逐字段交易日期，不保证各字段同步。' : '估值元数据日期缺失、落后于最近交易日或位于未来，保持未知；未以请求时刻补日期。' });
          }
        }
      } catch (error) {
        const e = safeError(error); moduleErrors[kind] = e; warnings.push(`扶摇${{ valuation: '估值', prices: '日线', annual: '年度报表' }[kind]}批次失败（${e.code}）：${e.message}`);
        for (const stock of group) for (const id of metricIds) stock.metrics[id] = ev(id, null, { status: 'error', note: e.message });
      }
    }));
    if (!successes[kind]) {
      const error = failure('FUYAO_REQUIRED', `扶摇${{ valuation: '估值', prices: '日线', annual: '年度报表' }[kind]}必要模块全部请求失败，未生成完整自动快照。${moduleErrors[kind].message}`, 503);
      error.calendarAsOf = asOf;
      throw error;
    }
  }
  const report = reportFor(asOf);
  // Endpoint is single-stock only; do not invent an undocumented batch route.
  let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < stocks.length) {
      const stock = stocks[cursor++];
      try { stock.metrics.roe = roeEvidence(await request('financials/indicators', { thscode: stock.code, report }), stock.code, report, asOf); }
      catch (error) { const e = safeError(error); stock.metrics.roe = ev('roe', null, { status: 'error', note: e.message }); warnings.push(`${stock.code} 加权净资产收益率读取失败（${e.code}）：${e.message}`); }
    }
  }));
  if (!stocks.some(s => Object.values(s.metrics).some(e => e.status === 'ok'))) {
    const error = failure('FUYAO_DATA_UNAVAILABLE', '扶摇全部证券均无可核验字段，未生成空成功快照', 503);
    error.calendarAsOf = asOf;
    throw error;
  }
  const unknownCount = stocks.filter(s => ['pe_ttm', 'pb_mrq', 'volatility_20d', 'return_20d', 'revenue_yoy_annual', 'profit_yoy_annual', 'roe'].some(id => s.metrics[id].status !== 'ok')).length;
  if (unknownCount) warnings.push(`${unknownCount}家证券至少一项主源指标数据不足或读取失败，请逐字段查看证据；未用零值或其他证券补齐。`);
  return { stocks, asOf, warnings };
}

async function fallback({ env, fetchImpl, stocks, asOf, today, warnings }) {
  // Reuse the strict existing iFinD parser/client; load only after primary gaps.
  // Filter requests by field AND securities, instead of fetching another full snapshot.
  const { __testing: api } = await import('./ifind.mjs');
  let key = env.IFIND_API_KEY;
  if (!(typeof key === 'string' && key.trim()) && typeof env.IFIND_CONFIG_PATH === 'string' && env.IFIND_CONFIG_PATH.trim()) {
    try { key = JSON.parse((await readFile(env.IFIND_CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, '')).auth_token; }
    catch { throw failure('IFIND_CONFIG', '同花顺备用数据显式配置无法读取或格式错误', 503); }
  }
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw failure('IFIND_CONFIG', '同花顺备用数据凭证无效，请检查服务端配置', 503);
  ifindRequestGate ||= api.createGate();
  const client = api.createClient({ apiKey: key.trim(), fetchImpl, gate: action => requestGate(() => ifindRequestGate(action)) });
  let added = 0;
  try {
    await client.initialize();
    for (const type of [['pe_ttm', 'pb_mrq'], ['roe']]) {
      const pending = stocks.filter(s => type.some(id => s.metrics[id].status !== 'ok'));
      for (let i = 0; i < pending.length; i += 4) {
        const group = pending.slice(i, i + 4); const codes = group.map(s => s.code);
        const baseRequest = api.requestsFor(codes).find(r => r.metrics.some(id => type.includes(id)));
        const metrics = baseRequest.metrics.filter(id => group.some(s => s.metrics[id].status !== 'ok'));
        const query = metrics.includes('roe')
          ? `${codes.join('、')}，报告期2026年三季报（2026-09-30）：仅查询该报告期加权平均净资产收益率（非年化、公布值）。`
          : `${codes.join('、')}，交易日期2026年11月6日：${metrics.map(id => id === 'pe_ttm' ? '市盈率(PE,TTM)' : '市净率(PB,MRQ)').join('、')}。`;
        const request = { ...baseRequest, metrics, query };
        const table = api.parseTool(await client.call(request.tool, request.query), codes);
        for (const stock of group) for (const id of request.metrics) {
          if (stock.metrics[id].status === 'ok') continue;
          const e = api.mappedEvidence(table, stock.code, id, request);
          if (e.status === 'ok' && ![key.trim(), encodeURIComponent(key.trim())].some(secret => JSON.stringify(e).includes(secret)) && e.asOf <= today && (!asOf || id === 'roe' || e.asOf === asOf)) {
            stock.metrics[id] = { ...e, period: getMetric(id).period, unit: getMetric(id).unit, note: `${e.note} 扶摇对应字段不可用，明确采用固定日期备用来源；不代表最新自动覆盖。` }; added++;
          }
        }
      }
    }
  } catch { throw failure('IFIND_FALLBACK', '同花顺备用数据查询失败，未将未核验数据补入快照', 503); }
  finally { warnings.push(`已尝试同花顺备用来源，仅补充扶摇缺失的估值或加权净资产收益率字段，本次补入${added}项。备用估值固定交易日2026-11-06，财务固定报告期2026-09-30；不是全量成功或实时更新。`); }
}

export async function loadAutoSnapshot({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs) || !dateMs(nowMs)) throw failure('DATA_TIME', '服务端时间无效，无法创建自动快照', 503);
  if (!autoDataCapabilities(env).autoAvailable) throw failure('DATA_UNAVAILABLE', '自动数据未配置授权来源，不会退回演示数据', 503);
  let loaded; let primaryError;
  if (configured(env, 'FUYAO')) {
    try { loaded = await primary({ env, fetchImpl, nowMs }); }
    catch (error) { primaryError = safeError(error); }
  } else primaryError = failure('FUYAO_CONFIG', '扶摇主数据源未配置', 503);
  if (!loaded) {
    if (!configured(env, 'IFIND')) throw primaryError;
    loaded = { stocks: initialStocks(), asOf: primaryError.calendarAsOf || null, warnings: [`主数据源不可用（${primaryError.code}）：${primaryError.message}。仅尝试固定日期的有限备用覆盖；${primaryError.calendarAsOf ? '保留已核验交易日历日期，未假装主源全部成功。' : '无法确认最近交易日，不伪造最新日期。'}`] };
  }
  if (configured(env, 'IFIND') && loaded.stocks.some(s => ['pe_ttm', 'pb_mrq', 'roe'].some(id => s.metrics[id].status !== 'ok'))) {
    try { await fallback({ env, fetchImpl, ...loaded, today: dateMs(nowMs) }); }
    catch (error) {
      const e = safeError(error); loaded.warnings.push(`备用数据不可用（${e.code}）：${e.message}`);
      if (primaryError) throw e;
    }
  }
  const usable = loaded.stocks.flatMap(s => Object.values(s.metrics)).filter(e => e.status === 'ok');
  if (!usable.length) throw failure('DATA_UNAVAILABLE', '全部证券均无日期、单位和口径可核验的数据，未生成空成功快照', 503);
  const providers = [...new Set(usable.map(e => e.source))];
  const supportedMetrics = METRICS.map(m => m.id).filter(id => loaded.stocks.some(s => s.metrics[id]?.status === 'ok'));
  if (primaryError) loaded.warnings.push(`${loaded.asOf ? '此快照日期保留已核验的主源交易日历日期；备用字段仍保留各自固定日期。' : '此快照日期仅为已核验备用字段的最大日期，不表示已确认最近交易日。'}年度同比和价格波动等主源能力缺失，请查看逐字段证据。`);
  return { id: `auto-${randomUUID()}`, mode: 'auto', source: providers.join('；'), fetchedAt: new Date(nowMs).toISOString(), universe: UNIVERSE, ...loaded, asOf: loaded.asOf || usable.map(e => e.asOf).sort().at(-1), supportedMetrics, providerSummary: providers };
}

export const __testing = Object.freeze({ createClient, createGate, dateMs, date, calendar, grouped, annualEvidence, klineEvidence, roeEvidence, reportFor, reportDate });
