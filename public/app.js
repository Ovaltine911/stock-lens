/* 选股有据 v3 · 一句话选股前端
   一个输入框 + 开始筛选：明确意图自动取数并核验；含糊意图先给可编辑条件和解释，由用户点一次确认。
   所有动态文本都用 textContent 写入，外链经 safeUrl 过滤协议。 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORE_KEY = 'stock-lens:records:v3';
const SCHEMA = 3;
const MAX_RECORDS = 5;
const DEFAULT_TTL_MINUTES = 15;

const METRIC_FALLBACK = [
  { id: 'pe_ttm', label: '市盈率（TTM）', unit: '倍', period: 'TTM', defaultOp: 'lt', defaultValue: 20 },
  { id: 'pb_mrq', label: '市净率（MRQ）', unit: '倍', period: 'MRQ', defaultOp: 'lt', defaultValue: 3 },
  { id: 'roe', label: 'ROE', unit: '%', period: '报告期', defaultOp: 'gt', defaultValue: 10 },
  { id: 'volatility_20d', label: '20日波动率', unit: '%', period: '20D年化', defaultOp: 'lte', defaultValue: 30 },
];

const OP_LABEL = { gt: '大于', gte: '不低于', lt: '小于', lte: '不高于', eq: '等于' };
const OP_SIGN = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };
const STATUS_LABEL = { pass: '通过', fail: '未通过', unknown: '数据不足' };

const state = {
  catalog: null,
  universe: null,
  ttlMinutes: DEFAULT_TTL_MINUTES,
  snapshot: null,
  snapshotMode: 'auto',
  snapshotLocalAt: 0,
  historical: false,
  intent: null,
  parsedText: '',
  draftValid: false,
  needsConfirmation: false,
  conditions: [],
  baseline: null,
  conflictIds: [],
  result: null,
  resultConditions: null,
  stale: false,
  filter: 'pass',
  compareCodes: [],
  records: [],
  retry: null,
  run: 0,
  busy: false,
  requestedMode: 'auto',
  theme: 'system',
};

/* ---------- 基础工具 ---------- */

const metrics = () => (state.catalog?.metrics?.length ? state.catalog.metrics : METRIC_FALLBACK);

function metric(id) {
  return metrics().find(item => item.id === id)
    || METRIC_FALLBACK.find(item => item.id === id)
    || { id: String(id || ''), label: String(id || '未知指标'), unit: '', period: '' };
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value == null ? '' : String(value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
}

function safeUrl(value) {
  try {
    const url = new URL(String(value), window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function numberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function dateText(value) {
  if (typeof value !== 'string' || !value.trim()) return '未知';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value.slice(0, 24);
}

function stampText(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function ruleText(condition) {
  const item = metric(condition.metric);
  const value = Number.isFinite(condition.value) ? numberText(condition.value) : '未填写';
  return `${item.label} ${OP_LABEL[condition.op] || condition.op || '未设置'} ${value}${item.unit || ''}`;
}

function conditionsComplete() {
  return state.conditions.length > 0 && state.conditions.every(item => Number.isFinite(item.value));
}

function ttlMs() {
  const minutes = Number(state.ttlMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60_000;
}

function snapshotExpired() {
  if (!state.snapshot || state.historical) return true;
  return Date.now() - state.snapshotLocalAt > ttlMs();
}

/* ---------- 请求 ---------- */

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch {
    throw Object.assign(new Error('暂时无法连接服务，请确认网络或服务状态后重试。'), { kind: 'network' });
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string' && body.error.message.length <= 200
      ? body.error.message
      : '服务暂时不可用，没有生成结论。';
    throw Object.assign(new Error(message), { status: response.status, payload: body });
  }
  if (!body || typeof body !== 'object') throw new Error('服务返回了无法读取的内容。');
  return body;
}

function current(run) {
  return state.run === run;
}

/* ---------- 阶段条 ---------- */

function setStage(name, stateName, text) {
  const node = $(`#stage-${name}`);
  if (node) node.dataset.state = stateName;
  const map = { understand: '#stageUnderstandText', data: '#stageDataText', verify: '#stageVerifyText' };
  if (text != null) setText(map[name], text);
}

function resetStages(text = '等待输入') {
  setStage('understand', 'idle', text);
  setStage('data', 'idle', '自动获取，无需选择来源');
  setStage('verify', 'idle', '每个条件都给出数值与来源');
}

/* ---------- 错误 ---------- */

const ERROR_TITLE = { model: '没能理解这句话', data: '数据没有取到', screen: '筛选没有完成', input: '还缺一点信息' };

function showError(kind, message, retry = null, options = {}) {
  state.retry = typeof retry === 'function' ? retry : null;
  setText('#errorTitle', ERROR_TITLE[kind] || '暂时无法完成');
  setText('#errorMessage', message);
  $('#retryBtn').hidden = !state.retry;
  $('#errorDemoBtn').hidden = !options.offerDemo;
  $('#errorBox').hidden = false;
}

function clearError() {
  state.retry = null;
  $('#errorBox').hidden = true;
  $('#retryBtn').hidden = true;
  $('#errorDemoBtn').hidden = true;
}

/* ---------- 顶部观察范围 ---------- */

function renderUniverse() {
  const universe = state.snapshot?.universe || state.universe || null;
  setText('#universeLabel', universe?.label || '12 家 A 股观察样本');

  const snapshot = state.snapshot;
  setText('#dataDate', snapshot?.asOf ? dateText(snapshot.asOf) : '尚未取数');
  setText('#dataSource', snapshot?.source || (state.snapshotMode === 'demo' ? '合成演示数据' : '首次筛选时自动获取'));
  const cached = Boolean(snapshot?.cached);
  $('#cacheInfoWrap').hidden = !snapshot;
  if (snapshot) {
    const fetched = snapshot.fetchedAt ? stampText(new Date(snapshot.fetchedAt)) : '未知';
    setText('#cacheInfo', cached ? `${fetched}（服务端缓存）` : fetched);
  }

  const list = $('#sampleList');
  list.replaceChildren();
  const stocks = Array.isArray(snapshot?.stocks) ? snapshot.stocks : [];
  if (!stocks.length) {
    const item = el('li', 'sample-empty', '名单在首次取数后按数据源原样显示');
    list.append(item);
    return;
  }
  const passing = new Set((state.result && !state.stale ? state.result.rows || [] : [])
    .filter(row => row.status === 'pass').map(row => row.code));
  stocks.forEach(stock => {
    const item = el('li');
    if (passing.has(stock.code)) item.classList.add('is-pass');
    item.append(el('span', null, stock.name || '未命名'));
    item.title = `${stock.code || '无代码'}${passing.has(stock.code) ? ' · 本次筛选通过' : ''}`;
    list.append(item);
  });
}

/* ---------- 条件 ---------- */

function normalizeCondition(raw, index = 0) {
  let value = raw?.value;
  if (typeof value === 'string') value = value.trim() === '' ? NaN : Number(value);
  else if (value == null) value = NaN;
  else value = Number(value);
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : `c${index + 1}-${Date.now().toString(36)}`;
  const known = metrics().some(item => item.id === raw?.metric);
  return {
    id,
    metric: known ? raw.metric : metrics()[0]?.id || 'pe_ttm',
    op: OP_LABEL[raw?.op] ? raw.op : 'lt',
    value,
    origin: typeof raw?.origin === 'string' ? raw.origin.slice(0, 400) : '用户设置',
    edited: Boolean(raw?.edited),
  };
}

function conditionRow(condition, index) {
  const row = el('div', 'cond');
  row.dataset.id = condition.id;
  if (condition.edited) row.classList.add('is-edited');
  if (state.conflictIds.includes(condition.id)) row.classList.add('is-conflict');
  const supported = Array.isArray(state.snapshot?.supportedMetrics) && !state.historical ? state.snapshot.supportedMetrics : null;

  const line = el('div', 'cond-line');
  line.append(el('span', 'cond-idx', String(index + 1)));

  const metricSelect = el('select', 'metric-select');
  metricSelect.setAttribute('aria-label', `第 ${index + 1} 条指标`);
  metrics().forEach(item => {
    const option = el('option', null, item.label);
    option.value = item.id;
    option.selected = item.id === condition.metric;
    metricSelect.append(option);
  });

  const opSelect = el('select', 'op-select');
  opSelect.setAttribute('aria-label', `第 ${index + 1} 条比较方式`);
  Object.entries(OP_LABEL).forEach(([key, label]) => {
    const option = el('option', null, label);
    option.value = key;
    option.selected = key === condition.op;
    opSelect.append(option);
  });

  const input = el('input', 'value-input');
  input.type = 'number';
  input.step = 'any';
  input.value = Number.isFinite(condition.value) ? String(condition.value) : '';
  input.setAttribute('aria-label', `第 ${index + 1} 条阈值`);
  if (!Number.isFinite(condition.value)) input.classList.add('is-invalid');

  const unit = el('span', 'cond-unit', metric(condition.metric).unit || '');
  const period = el('span', 'cond-period', metric(condition.metric).period ? `口径 ${metric(condition.metric).period}` : '口径未标注');

  const remove = el('button', 'remove-btn', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `删除第 ${index + 1} 条条件`);

  const commit = (fromInput = false) => {
    const target = state.conditions.find(item => item.id === condition.id);
    if (!target) return;
    target.metric = metricSelect.value;
    target.op = opSelect.value;
    target.value = input.value.trim() === '' ? NaN : Number(input.value);
    target.edited = true;
    unit.textContent = metric(target.metric).unit || '';
    period.textContent = metric(target.metric).period ? `口径 ${metric(target.metric).period}` : '口径未标注';
    input.classList.toggle('is-invalid', !Number.isFinite(target.value));
    row.classList.add('is-edited');
    state.conflictIds = [];
    row.classList.remove('is-conflict');
    onConditionsChanged(fromInput);
  };

  metricSelect.addEventListener('change', () => commit());
  opSelect.addEventListener('change', () => commit());
  input.addEventListener('input', () => commit(true));
  input.addEventListener('change', () => commit());
  remove.addEventListener('click', () => {
    state.conditions = state.conditions.filter(item => item.id !== condition.id);
    state.conflictIds = [];
    onConditionsChanged();
    renderConditions();
  });

  line.append(metricSelect, remove);
  const rule = el('div', 'cond-line cond-rule');
  rule.append(opSelect, input, unit, period);
  row.append(line, rule);

  if (condition.origin) {
    const origin = el('div', 'cond-origin');
    const manual = /手动/.test(condition.origin);
    origin.append(el('span', condition.edited ? 'mini mini-ink' : manual ? 'mini' : 'mini mini-brand', condition.edited ? '已修改' : manual ? '手动' : '来自描述'));
    origin.append(el('span', null, condition.origin));
    row.append(origin);
  }
  if (supported && !supported.includes(condition.metric)) {
    const note = el('div', 'cond-origin');
    note.append(el('span', 'mini mini-warn', '未取到'));
    note.append(el('span', null, '本次数据快照不含此字段，核验会显示数据不足；不会为它悄悄换数据。'));
    row.append(note);
  }
  return row;
}

function renderConditions() {
  const list = $('#conditionsList');
  list.replaceChildren();
  state.conditions.forEach((condition, index) => list.append(conditionRow(condition, index)));
  updateActions();
}

/** 条件被编辑：旧结果立即标成待更新，必须重新筛选才能保存或导出；在飞的取数或核验作废。 */
function onConditionsChanged(fromInput = false) {
  state.run += 1;
  if (state.busy) {
    state.busy = false;
    $('#resultsSkeleton').hidden = true;
    if (!state.result) $('#emptyResults').hidden = false;
    setStage('verify', 'idle', '条件已修改，等你点筛选');
  }
  if (state.historical) {
    updateActions();
    return;
  }
  if (state.result) {
    state.stale = true;
    markResultStale(fromInput ? '条件正在修改，下面仍是上一次的结果。' : '条件已修改，下面仍是上一次的结果，点按这些条件筛选可在同一份数据上更新。');
  }
  updateActions();
}

function markResultStale(text) {
  $('#resultsContent').classList.add('is-stale');
  setText('#staleText', text);
  $('#refetchBtn').hidden = !snapshotExpired();
  $('#staleBanner').hidden = false;
  setText('#snapshotTag', '结果待更新');
  $('#snapshotTag').className = 'tag tag-warn';
  renderUniverse();
}

function clearStaleBanner() {
  $('#staleBanner').hidden = true;
  $('#refetchBtn').hidden = true;
  $('#resultsContent').classList.remove('is-stale');
}

function updateActions() {
  const blocked = Boolean(state.intent?.blocked);
  const complete = conditionsComplete();
  const upToDate = Boolean(state.result) && !state.stale && !state.historical;
  const canScreen = !state.busy && !blocked && complete && state.draftValid && !upToDate;
  $('#confirmBtn').disabled = !canScreen;
  const editingResult = Boolean(state.result) && state.resultMatchesIntent && !state.historical;
  $('#confirmBtn').textContent = state.historical ? '用这些条件重新查询'
    : editingResult ? '更新结果' : '按这些条件筛选';
  const unsupportedCount = (state.intent?.unsupported || []).length;

  const exportable = Boolean(state.result) && !state.stale;
  $('#saveBtn').disabled = !exportable || state.historical;
  $('#exportBtn').disabled = !exportable;
  $('#manualBtn').hidden = !(state.intent && (blocked || (state.intent.unsupported || []).length || state.conditions.length));

  if (state.busy) setText('#confirmHint', '正在处理，请稍候');
  else if (blocked) setText('#confirmHint', '这条请求不能执行，请改写描述或改为手动条件');
  else if (!state.conditions.length) setText('#confirmHint', state.intent ? '没有可执行的条件，请手动添加' : '等待输入');
  else if (!complete) setText('#confirmHint', '有条件缺少数值，补齐后才能筛选');
  else if (!state.draftValid) setText('#confirmHint', '输入已修改，请点开始筛选重新理解');
  else if (!editingResult && !state.historical && unsupportedCount) setText('#confirmHint', `只核验左侧条件，${unsupportedCount} 项暂不支持的要求不会执行`);
  else if (!editingResult && !state.historical && state.needsConfirmation) setText('#confirmHint', '核对上面的解释和阈值，确认后自动取数核验');
  else if (state.historical) setText('#confirmHint', '历史结果仅供查看；重新查询会获取最新数据，不复用历史快照');
  else if (editingResult && state.stale && snapshotExpired()) setText('#confirmHint', '数据快照已过期，请先重新获取数据');
  else if (editingResult && state.stale) setText('#confirmHint', `在同一份数据（${dateText(state.snapshot?.asOf)}）上重新核验，增减会逐条说明`);
  else if (editingResult) setText('#confirmHint', '结果已是最新；修改任一条件后可更新');
  else setText('#confirmHint', `共 ${state.conditions.length} 条条件，同时满足才通过`);
}

/* ---------- 解析结果与提示 ---------- */

function renderMessages(intent) {
  const list = $('#messageList');
  list.replaceChildren();
  if (!intent) return;

  const modeText = intent.mode === 'llm' ? '大模型解析，条件可直接修改'
    : intent.mode === 'manual' ? '手动条件，由你定义'
    : '规则解析模式，未调用大模型';
  list.append(el('p', 'msg msg-mode', modeText));

  if (intent.blocked) {
    const box = el('p', 'msg msg-danger');
    box.append(el('b', null, '这条请求不能执行：'));
    box.append(document.createTextNode(intent.blockReason || '请改为可核验的指标条件。'));
    list.append(box);
  }

  const unsupported = (intent.unsupported || []).filter(item => typeof item === 'string' && item.trim());
  if (unsupported.length) {
    const box = el('div', 'msg msg-danger');
    box.append(el('b', null, '以下要求当前无法表达，不会悄悄丢掉：'));
    const items = el('ul', 'msg-list');
    unsupported.forEach(text => items.append(el('li', null, text)));
    box.append(items);
    box.append(el('span', null, '当前不会执行筛选。请改写描述，或明确改为手动条件后重新定义。'));
    list.append(box);
  }

  const clarifications = (intent.clarifications || []).filter(item => item && (item.question || item.explanation)).slice(0, 3);
  if (clarifications.length) {
    const box = el('div', 'clar-list');
    box.append(el('div', 'clar-head', '这句话里有需要你拍板的地方，条件已按下面的理解填好，可直接改：'));
    clarifications.forEach((item, index) => {
      const row = el('div', 'clar-item');
      row.append(el('span', 'clar-idx', String(index + 1)));
      const copy = el('div');
      copy.append(el('strong', null, item.question || '请确认这一条的口径'));
      if (item.explanation) copy.append(el('span', null, item.explanation));
      row.append(copy);
      box.append(row);
    });
    if (!state.needsConfirmation && state.resultMatchesIntent) {
      const details = el('details', 'confirmed-assumptions');
      details.append(el('summary', null, '已确认的条件含义与口径'));
      details.append(box);
      list.append(details);
    } else list.append(box);
  }

  const warnings = (intent.warnings || []).filter(text => typeof text === 'string' && text.trim()).slice(0, 4);
  if (warnings.length) {
    const notes = el('ul', 'note-list');
    warnings.forEach(text => notes.append(el('li', null, text)));
    list.append(notes);
  }
}

function renderIntent(intent, text) {
  state.intent = intent;
  state.parsedText = text;
  state.draftValid = true;
  state.resultMatchesIntent = false;
  state.conditions = (intent.conditions || []).map((item, index) => normalizeCondition(item, index));
  state.conflictIds = [];
  const needs = intent.needsConfirmation === true
    || Boolean(intent.blocked)
    || (intent.unsupported || []).length > 0
    || (intent.clarifications || []).length > 0;
  state.needsConfirmation = needs;
  setText('#parseSummary', intent.summary || (state.conditions.length ? '已生成可编辑条件' : '没有识别出可执行条件'));
  if (state.result) {
    state.stale = true;
    state.historical = false;
    markResultStale('已理解新的描述，下面仍是上一次的结果。');
  }
  const mode = $('#parserMode');
  mode.textContent = intent.mode === 'llm' ? '大模型解析' : intent.mode === 'manual' ? '手动条件' : '规则解析';
  mode.className = needs ? 'tag tag-warn' : 'tag';
  renderMessages(intent);
  renderConditions();
}

/* ---------- 结果渲染 ---------- */

function valueCell(check) {
  const evidence = check?.evidence || {};
  const cell = el('td', `col-metric cell-${check?.result || 'unknown'}`);
  const item = metric(check?.condition?.metric);
  cell.dataset.label = `${item.label} ${OP_SIGN[check?.condition?.op] || ''} ${numberText(check?.condition?.value)}${item.unit || ''}`;
  const wrap = el('span', 'val');
  const known = typeof evidence.value === 'number' && Number.isFinite(evidence.value) && check?.result !== 'unknown';
  wrap.append(el('span', 'val-num', known ? numberText(evidence.value) : '未知'));
  if (known && (evidence.unit || item.unit)) wrap.append(el('span', 'val-unit', evidence.unit || item.unit));
  wrap.append(el('span', 'val-mark', check?.result === 'pass' ? '✓' : check?.result === 'fail' ? '×' : '?'));
  cell.append(wrap);
  const years = String(check?.condition?.metric || '').endsWith('_yoy_annual') ? annualYearShort(evidence) : '';
  const sub = years || evidence.period || item.period || '口径未标注';
  const unknownReason = { missing: '缺值', stale: '数据过期', error: '读取错误' }[evidence.status] || '口径信息不全';
  cell.append(el('span', 'val-sub', known ? `${sub} · ${dateText(evidence.asOf)}` : unknownReason));
  return cell;
}

function renderTable(rows) {
  const conditions = state.resultConditions || [];
  const scroll = el('div', 'table-scroll');
  const table = el('table', 'result-table');

  const headRow = el('tr');
  headRow.append(el('th', 'col-pick', '对比'), el('th', null, '标的'), el('th', 'col-industry', '行业'));
  conditions.forEach(condition => {
    const item = metric(condition.metric);
    const th = el('th', 'col-metric');
    th.append(el('span', 'th-metric', item.label));
    th.append(el('span', 'th-rule', `${OP_SIGN[condition.op] || condition.op} ${numberText(condition.value)}${item.unit || ''}`));
    headRow.append(th);
  });
  headRow.append(el('th', null, '结论'), el('th', 'col-act', '证据'));
  const head = el('thead');
  head.append(headRow);

  const body = el('tbody');
  rows.forEach(row => {
    const tr = el('tr');
    tr.tabIndex = 0;
    if (state.compareCodes.includes(row.code)) tr.classList.add('is-picked');

    const pick = el('td', 'col-pick');
    const pickBtn = el('button', 'pick-btn', state.compareCodes.includes(row.code) ? '已选' : '选取');
    pickBtn.type = 'button';
    pickBtn.setAttribute('aria-pressed', String(state.compareCodes.includes(row.code)));
    pickBtn.disabled = !state.compareCodes.includes(row.code) && state.compareCodes.length >= 3;
    pickBtn.addEventListener('click', event => {
      event.stopPropagation();
      togglePick(row.code);
    });
    pick.append(pickBtn);

    const stock = el('td', 'col-stock');
    const cell = el('div', 'stock-cell');
    cell.append(el('span', 'stock-name', row.name || '未命名'), el('span', 'stock-code', row.code || '无代码'));
    stock.append(cell);

    const industry = el('td', 'col-industry', row.industry || '未分类');

    tr.append(pick, stock, industry);
    conditions.forEach(condition => {
      const check = (row.checks || []).find(item => item.condition?.id === condition.id)
        || (row.checks || []).find(item => item.condition?.metric === condition.metric);
      tr.append(valueCell(check));
    });

    const status = el('td', 'col-status');
    status.append(el('span', `status-pill status-${row.status}`, STATUS_LABEL[row.status] || '未知'));
    tr.append(status);

    const act = el('td', 'col-act');
    const link = el('button', 'evidence-link', '查看');
    link.type = 'button';
    link.addEventListener('click', event => {
      event.stopPropagation();
      openEvidence(row);
    });
    act.append(link);
    tr.append(act);

    tr.addEventListener('click', () => openEvidence(row));
    tr.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openEvidence(row);
      }
    });
    body.append(tr);
  });

  table.append(head, body);
  scroll.append(table);
  return scroll;
}

const EMPTY_COPY = {
  pass: ['没有标的同时满足全部条件', '可以放宽某一条阈值后再筛选，或到未通过分组里看差在哪一条。'],
  fail: ['没有被排除的标的', '当前条件下所有样本都通过或数据不足。'],
  unknown: ['没有数据不足的标的', '本次每条条件都取到了可核验的数值。'],
};

function renderRows() {
  const root = $('#overviewTab');
  root.replaceChildren();
  const rows = (state.result?.rows || []).filter(row => row.status === state.filter);
  if (!rows.length) {
    let [title, copy] = EMPTY_COPY[state.filter] || EMPTY_COPY.pass;
    if (state.filter === 'pass' && (state.result?.rows || []).length) {
      const tightest = (state.resultConditions || []).map(condition => ({
        condition,
        matched: state.result.rows.filter(row => (row.checks || []).some(check => check.condition?.id === condition.id && check.result === 'pass')).length,
      })).sort((a, b) => a.matched - b.matched)[0];
      if (tightest) copy = `最紧的一条是 ${shortRule(tightest.condition)}，只有 ${tightest.matched} 家满足。可在左侧放宽后点更新结果，或到未通过分组看差在哪一条。`;
    }
    const box = el('div', 'tab-empty');
    box.append(el('strong', null, title), el('span', null, copy));
    root.append(box);
    return;
  }
  root.append(renderTable(rows));
}

function renderFunnel(result) {
  const list = $('#funnel');
  list.replaceChildren();
  const total = result.counts?.total ?? (result.rows || []).length;
  (state.resultConditions || []).forEach(condition => {
    const item = metric(condition.metric);
    const matched = (result.rows || []).filter(row => (row.checks || [])
      .some(check => check.condition?.id === condition.id && check.result === 'pass')).length;
    const node = el('li');
    if (matched <= Math.max(1, Math.round(total * 0.25))) node.classList.add('is-tight');
    node.append(el('span', null, `${item.label} ${OP_SIGN[condition.op] || ''} ${numberText(condition.value)}${item.unit || ''}`));
    node.append(el('b', null, `${matched}/${total}`));
    list.append(node);
  });
}

function passes(value, condition) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  switch (condition.op) {
    case 'gt': return value > condition.value;
    case 'gte': return value >= condition.value;
    case 'lt': return value < condition.value;
    case 'lte': return value <= condition.value;
    case 'eq': return value === condition.value;
    default: return null;
  }
}

function shortRule(condition) {
  const item = metric(condition.metric);
  return `${item.label} ${OP_SIGN[condition.op] || condition.op} ${numberText(condition.value)}${item.unit || ''}`;
}

/** 条件层面的变化：按条件 id 对齐，说清哪条阈值从多少改到多少。 */
function conditionChanges(previous, next) {
  const before = new Map(previous.map(item => [item.id, item]));
  const after = new Map(next.map(item => [item.id, item]));
  const changes = [];
  next.forEach(item => {
    const old = before.get(item.id);
    if (!old) changes.push(`新增 ${shortRule(item)}`);
    else if (old.metric !== item.metric || old.op !== item.op || old.value !== item.value) changes.push(`${shortRule(old)} 改为 ${shortRule(item)}`);
  });
  previous.forEach(item => {
    if (!after.has(item.id)) changes.push(`删除 ${shortRule(item)}`);
  });
  return changes;
}

/** 单只标的为什么进出：用本次证据值分别对照新旧阈值。 */
function stockReason(row, previous, kind) {
  const before = new Map(previous.map(item => [item.id, item]));
  const reasons = [];
  (row?.checks || []).forEach(check => {
    const condition = check.condition || {};
    const value = check.evidence?.value;
    const old = before.get(condition.id);
    const label = `${metric(condition.metric).label} ${numberText(value)}${metric(condition.metric).unit || ''}`;
    if (kind === 'removed' && check.result !== 'pass') {
      if (check.result === 'unknown') reasons.push(`${metric(condition.metric).label} 数据不足`);
      else if (!old) reasons.push(`${label} 不满足新增条件 ${OP_SIGN[condition.op]} ${numberText(condition.value)}`);
      else if (passes(value, old) === true) reasons.push(`${label} 原先满足，不满足新阈值 ${OP_SIGN[condition.op]} ${numberText(condition.value)}`);
      else reasons.push(`${label} 不满足 ${OP_SIGN[condition.op]} ${numberText(condition.value)}`);
    }
    if (kind === 'added' && check.result === 'pass' && old && old.metric === condition.metric && passes(value, old) === false) {
      reasons.push(`${label} 原先不满足 ${OP_SIGN[old.op]} ${numberText(old.value)}，现满足 ${OP_SIGN[condition.op]} ${numberText(condition.value)}`);
    }
  });
  if (kind === 'added' && !reasons.length) {
    const dropped = previous.filter(item => !(row?.checks || []).some(check => check.condition?.id === item.id));
    if (dropped.length) reasons.push(`删除了条件 ${dropped.map(shortRule).join('、')}`);
  }
  return reasons.slice(0, 2).join('；');
}

function renderDiff(result, previous) {
  const box = $('#diffBox');
  box.replaceChildren();
  const diff = result.diff;
  if (!diff || !Array.isArray(previous)) {
    box.hidden = true;
    return;
  }
  const current = state.resultConditions || [];
  const changes = conditionChanges(previous, current);
  const head = el('div', 'diff-head');
  head.append(el('strong', null, '与上一次条件对比'));
  head.append(el('span', 'tag tag-brand diff-count', `通过 ${diff.baselineCount} 家 → ${diff.currentCount} 家`));
  head.append(el('span', 'hint', `同一份数据 · ${dateText(state.snapshot?.asOf)}，变化只来自条件`));
  box.append(head);

  const list = el('ul', 'diff-list');
  const line = (tagClass, tag, strong, detail) => {
    const item = el('li');
    item.append(el('span', tagClass, tag));
    const copy = el('span');
    if (strong) copy.append(el('b', null, strong));
    if (detail) copy.append(document.createTextNode(strong ? `：${detail}` : detail));
    item.append(copy);
    list.append(item);
  };
  line('mini', '条件', '', changes.length ? changes.join('；') : '条件没有变化');
  const rowOf = code => (result.rows || []).find(row => row.code === code);
  (Array.isArray(diff.added) ? diff.added : []).forEach(code => {
    const row = rowOf(code);
    line('mini mini-ink', '新进', row?.name || code, stockReason(row, previous, 'added'));
  });
  (Array.isArray(diff.removed) ? diff.removed : []).forEach(code => {
    const row = rowOf(code);
    line('mini mini-brand', '移出', row?.name || code, stockReason(row, previous, 'removed'));
  });
  const kept = Array.isArray(diff.unchanged) ? diff.unchanged : [];
  if (kept.length) line('mini', '保持', '', kept.map(code => rowOf(code)?.name || code).join('、'));
  box.append(list);
  box.hidden = false;
}

function renderResult(result, { historical = false, previous = null } = {}) {
  state.result = result;
  state.resultMatchesIntent = true;
  state.resultConditions = (result.conditions || []).map((item, index) => normalizeCondition(item, index));
  state.stale = false;
  state.historical = historical;
  state.compareCodes = [];
  state.filter = 'pass';
  $('#compareTab').hidden = true;

  clearStaleBanner();
  $('#resultsSkeleton').hidden = true;
  $('#emptyResults').hidden = true;
  $('#resultsContent').hidden = false;

  const counts = result.counts || {};
  setText('#heroCount', counts.pass ?? 0);
  setText('#heroText', `家通过全部 ${state.resultConditions.length} 条条件，共核验 ${counts.total ?? 0} 家样本`);

  const tag = $('#snapshotTag');
  tag.textContent = historical ? '历史记录' : `数据日期 ${dateText(state.snapshot?.asOf)}`;
  tag.className = historical ? 'tag tag-warn' : 'tag tag-brand';
  setText('#resultsSub', historical
    ? '这是本浏览器保存的历史结果，不代表当前行情；要按现在的数据筛选请点按这些条件筛选。'
    : `按 ${state.resultConditions.length} 条条件逐项核验：${state.snapshot?.source || '数据来源见证据'} · 数据日期 ${dateText(state.snapshot?.asOf)}`);

  ['pass', 'fail', 'unknown'].forEach(name => {
    const button = $(`#tab${name === 'pass' ? 'Pass' : name === 'fail' ? 'Fail' : 'Unknown'}`);
    button.querySelector('b').textContent = String(counts[name] ?? 0);
    button.setAttribute('aria-selected', String(state.filter === name));
  });
  setText('#tabNote', '未通过优先于数据不足，单项结论仍逐条保留');

  if (!historical && state.intent) {
    renderMessages(state.intent);
    setText('#parseSummary', `已按 ${result.conditions?.length || state.conditions.length} 条条件完成筛选，可直接修改阈值。`);
    setText('#queryHint', '筛选完成。修改条件后可基于同一快照查看变化。');
    $('#parserMode').className = 'tag';
  }
  renderFunnel(result);
  renderDiff(result, historical ? null : previous);
  renderRows();
  renderCompare();

  const warnings = (result.warnings || []).filter(text => typeof text === 'string').slice(0, 3);
  setText('#resultFoot', [
    historical ? '历史记录，不可当作当前数据使用' : '数值、口径、日期与来源逐项可查，缺值显示未知且不会通过',
    ...warnings,
  ].join(' · '));

  $('#compareTray').hidden = (counts.pass ?? 0) < 2 && (result.rows || []).length < 2;
  renderUniverse();
  updateActions();
}

/* ---------- 候选对比 ---------- */

function togglePick(code) {
  if (!code) return;
  if (state.compareCodes.includes(code)) state.compareCodes = state.compareCodes.filter(item => item !== code);
  else if (state.compareCodes.length < 3) state.compareCodes.push(code);
  renderRows();
  renderCompare();
}

function renderCompare() {
  const tray = $('#compareTray');
  setText('#compareCount', state.compareCodes.length);
  const rows = (state.result?.rows || []).filter(row => state.compareCodes.includes(row.code));
  setText('#compareNames', rows.length ? rows.map(row => row.name || row.code).join('、') : '从表格里选 2 到 3 只做横向对比');
  $('#compareBtn').disabled = rows.length < 2;
  if (tray.hidden) $('#compareTab').hidden = true;

  const view = $('#compareTab');
  if (!rows.length) {
    view.replaceChildren();
    view.hidden = true;
    return;
  }
  if (view.hidden) return;
  view.replaceChildren();

  const head = el('div', 'compare-head');
  head.append(el('strong', null, '候选横向对比'));
  head.append(el('span', 'hint', '同一份数据快照内的逐项数值，不含推荐或收益判断'));
  view.append(head);

  const table = el('table', 'compare-table');
  const headRow = el('tr');
  headRow.append(el('th', null, '对比项'));
  rows.forEach(row => headRow.append(el('th', null, row.name || row.code || '未命名')));
  const thead = el('thead');
  thead.append(headRow);

  const body = el('tbody');
  const codeRow = el('tr');
  codeRow.append(el('td', null, '代码'));
  rows.forEach(row => codeRow.append(el('td', null, row.code || '无代码')));
  body.append(codeRow);

  const industryRow = el('tr');
  industryRow.append(el('td', null, '行业'));
  rows.forEach(row => industryRow.append(el('td', null, row.industry || '未分类')));
  body.append(industryRow);

  (state.resultConditions || []).forEach(condition => {
    const item = metric(condition.metric);
    const tr = el('tr');
    tr.append(el('td', null, `${item.label}（${item.unit || '无单位'} · ${item.period || '口径未标注'}）`));
    rows.forEach(row => {
      const check = (row.checks || []).find(entry => entry.condition?.id === condition.id)
        || (row.checks || []).find(entry => entry.condition?.metric === condition.metric);
      const evidence = check?.evidence || {};
      const known = typeof evidence.value === 'number' && Number.isFinite(evidence.value) && check?.result !== 'unknown';
      const td = el('td');
      td.append(el('span', `val ${known ? '' : 'val-unknown'}`.trim(), known ? `${numberText(evidence.value)}${evidence.unit || item.unit || ''}` : '未知'));
      td.append(el('span', 'val-sub', STATUS_LABEL[check?.result] || '数据不足'));
      tr.append(td);
    });
    body.append(tr);
  });

  const statusRow = el('tr');
  statusRow.append(el('td', null, '本次结论'));
  rows.forEach(row => {
    const td = el('td');
    td.append(el('span', `status-pill status-${row.status}`, STATUS_LABEL[row.status] || '未知'));
    statusRow.append(td);
  });
  body.append(statusRow);

  table.append(thead, body);
  view.append(table);
  view.hidden = false;
}

/* ---------- 证据 ---------- */

/** 年度同比的起止年：只读取证据里带年份语义的字段，读不到就如实说没有。 */
function annualYears(evidence) {
  const years = { base: '', current: '' };
  const visit = (object, depth, hint) => {
    if (!object || typeof object !== 'object' || depth > 2) return;
    for (const [key, value] of Object.entries(object)) {
      const label = `${hint} ${key}`;
      if (value && typeof value === 'object') {
        visit(value, depth + 1, label);
        continue;
      }
      // Only explicit years/date strings count; never infer a year from timestamp digits.
      const normalized = typeof value === 'number' && value >= 1900 && value <= 2099 && Number.isInteger(value) ? String(value) : typeof value === 'string' && /^((?:19|20)\d{2})(?:$|[-/])/.test(value) ? value : '';
      const match = normalized.match(/^(?:19|20)\d{2}/);
      if (!match || !/year|period|date|end|年/i.test(key)) continue;
      if (/base|prev|previous|last|first|start|denominator|上年|基/i.test(label)) years.base = years.base || match[0];
      else years.current = years.current || match[0];
    }
  };
  visit(evidence?.raw, 0, '');
  if (!years.base && years.current && /^\d{4}$/.test(years.current)) {
    years.base = '';
  }
  return years;
}

function annualYearText(evidence) {
  const { base, current } = annualYears(evidence);
  if (base && current) return `${base} 年度 → ${current} 年度（相邻两个完整年度）`;
  if (current) return `报告年度 ${current}，基准年度数据源未标注`;
  return '';
}

function annualYearShort(evidence) {
  const { base, current } = annualYears(evidence);
  return base && current ? `${base}→${current} 年度` : '';
}

function evidenceRow(grid, label, value, strong = false) {
  grid.append(el('dt', null, label));
  grid.append(el('dd', strong ? 'ev-strong' : null, value));
}

function openEvidence(row) {
  setText('#dialogKicker', `${STATUS_LABEL[row.status] || '未知'} · 逐项证据`);
  setText('#dialogTitle', `${row.name || '标的'}（${row.code || '无代码'}）`);
  const body = $('#dialogBody');
  body.replaceChildren();

  const meta = el('div', 'ev-meta');
  meta.append(el('span', 'tag', row.industry || '未分类'));
  meta.append(el('span', 'tag', `数据日期 ${dateText(state.snapshot?.asOf)}`));
  meta.append(el('span', 'tag', state.historical ? '历史记录' : state.snapshotMode === 'demo' ? '合成演示数据' : '自动取数'));
  body.append(meta);

  (row.checks || []).forEach(check => {
    const condition = check.condition || {};
    const evidence = check.evidence || {};
    const item = metric(condition.metric);
    const block = el('div', 'ev-check');

    const title = el('div', 'ev-title');
    title.append(el('strong', null, item.label));
    title.append(el('span', 'mini', `要求 ${OP_LABEL[condition.op] || condition.op || '未设置'} ${numberText(condition.value)}${item.unit || ''}`));
    title.append(el('span', `status-pill status-${check.result}`, STATUS_LABEL[check.result] || '未知'));
    block.append(title);

    const grid = el('dl', 'ev-grid');
    const known = typeof evidence.value === 'number' && Number.isFinite(evidence.value) && check.result !== 'unknown';
    evidenceRow(grid, '实际值', known ? `${numberText(evidence.value)}${evidence.unit || item.unit || ''}` : '未知', true);
    evidenceRow(grid, '阈值', `${numberText(condition.value)}${item.unit || ''}`);
    evidenceRow(grid, '单位', evidence.unit || item.unit || '无单位');
    evidenceRow(grid, '口径', evidence.period || item.period || '未标注');
    if (String(condition.metric || '').endsWith('_yoy_annual')) {
      evidenceRow(grid, '起止年度', annualYearText(evidence) || '数据源未提供起止年度，见下方原始值');
    }
    evidenceRow(grid, '数据日期', dateText(evidence.asOf));
    evidenceRow(grid, '来源', evidence.source || '未提供');
    evidenceRow(grid, '字段', evidence.field || '未提供');
    evidenceRow(grid, '单项原因', check.reason || evidence.note || '未提供');
    if (evidence.note) evidenceRow(grid, '来源备注', evidence.note);
    if (condition.origin) evidenceRow(grid, '条件来历', condition.origin);

    const url = safeUrl(evidence.sourceUrl);
    if (url) {
      grid.append(el('dt', null, '来源链接'));
      const dd = el('dd');
      const link = el('a', null, url);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      dd.append(link);
      grid.append(dd);
    }
    if (evidence.raw !== undefined) {
      grid.append(el('dt', null, '原始值'));
      const dd = el('dd');
      let text;
      try {
        text = typeof evidence.raw === 'object' ? JSON.stringify(evidence.raw, null, 2) : String(evidence.raw);
      } catch {
        text = '无法展示';
      }
      dd.append(el('pre', 'raw-box', text.slice(0, 1200)));
      grid.append(dd);
    }
    block.append(grid);
    body.append(block);
  });

  if (!(row.checks || []).length) body.append(el('p', 'hint', '这一行没有逐项证据。'));
  const dialog = $('#evidenceDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
}

/* ---------- 主流程 ---------- */

function beginBusy(run) {
  state.busy = true;
  clearError();
  if (state.result) $('#resultsContent').classList.add('is-stale');
  else {
    $('#emptyResults').hidden = true;
    $('#resultsSkeleton').hidden = false;
  }
  updateActions();
  return run;
}

function endBusy() {
  state.busy = false;
  $('#resultsSkeleton').hidden = true;
  if (!state.result) $('#emptyResults').hidden = false;
  if (!state.stale) $('#resultsContent').classList.remove('is-stale');
  updateActions();
}

async function startFlow() {
  const text = $('#intentInput').value.trim();
  if (!text) {
    setText('#queryHint', '先用一句话描述你想找的股票，或点上面的示例。');
    $('#intentInput').focus();
    return;
  }
  if (state.busy && text === state.parsedText) return;
  const run = ++state.run;
  beginBusy(run);
  setText('#queryHint', '');
  setStage('understand', 'active', '正在理解这句话');
  setStage('data', 'idle', '等待条件确定');
  setStage('verify', 'idle', '等待数据');

  let intent;
  try {
    intent = await api('/api/interpret', { method: 'POST', body: JSON.stringify({ text }) });
  } catch (error) {
    if (!current(run)) return;
    endBusy();
    setStage('understand', 'error', '没能理解这句话');
    showError('model', error.message, () => startFlow());
    return;
  }
  if (!current(run)) return;

  renderIntent(intent, text);

  if (intent.blocked) {
    endBusy();
    setStage('understand', 'error', '这条请求不能执行');
    setStage('data', 'idle', '未取数');
    setStage('verify', 'idle', '未核验');
    return;
  }
  if (!state.conditions.length) {
    endBusy();
    setStage('understand', 'wait', '没有识别出可执行条件');
    setStage('data', 'idle', '未取数');
    return;
  }
  if (state.needsConfirmation) {
    endBusy();
    setStage('understand', 'wait', `已给出 ${state.conditions.length} 条可改条件，等你确认`);
    setStage('data', 'idle', '确认后自动取数');
    setText('#queryHint', '这句话有需要拍板的地方，确认左侧条件后点按这些条件筛选。');
    return;
  }
  setStage('understand', 'done', `明确条件 ${state.conditions.length} 条，无需确认`);
  await runScreen(run);
}

async function confirmFlow(force = false) {
  if (!force && $('#confirmBtn').disabled) return;
  if (!conditionsComplete() || state.intent?.blocked) return;
  if (state.historical) {
    // 历史快照只用于查看，重新查询必须取新数据。
    state.historical = false;
    state.snapshot = null;
    state.result = null;
    state.resultConditions = null;
    state.stale = false;
    $('#resultsContent').hidden = true;
    clearStaleBanner();
  }
  if (state.result && state.resultMatchesIntent && !force && snapshotExpired()) {
    state.stale = true;
    markResultStale('数据快照已超过有效期，需要重新获取数据后再核验；条件会保留，不用再确认。');
    setStage('data', 'wait', '数据快照已过期，点重新获取数据');
    updateActions();
    return;
  }
  const run = ++state.run;
  beginBusy(run);
  setStage('understand', 'done', `已确认 ${state.conditions.length} 条条件`);
  await runScreen(run);
}

async function runScreen(run) {
  if (!current(run)) return;
  if (!conditionsComplete()) {
    endBusy();
    showError('input', '有条件还没有填数值，补齐后再筛选。');
    renderConditions();
    return;
  }

  const reuse = state.snapshot && !state.historical && !snapshotExpired() && state.snapshotMode === state.requestedMode;
  if (!reuse) {
    setStage('data', 'active', state.requestedMode === 'demo' ? '正在准备合成演示数据' : '正在自动获取 12 家样本的行情与财务字段');
    let snapshot;
    try {
      snapshot = await api('/api/snapshot', { method: 'POST', body: JSON.stringify({ mode: state.requestedMode }) });
    } catch (error) {
      if (!current(run)) return;
      endBusy();
      setStage('data', 'error', '取数失败，没有生成结果');
      state.snapshot = null;
      state.historical = false;
      renderUniverse();
      showError('data', `${error.message} 不会自动改用演示数据。`, () => confirmFlow(true), { offerDemo: state.requestedMode !== 'demo' });
      return;
    }
    if (!current(run)) return;
    state.snapshot = snapshot;
    state.snapshotMode = snapshot.mode === 'demo' ? 'demo' : state.requestedMode;
    state.snapshotLocalAt = Date.now();
    state.historical = false;
    state.baseline = null;
    $('#demoBanner').hidden = state.snapshotMode !== 'demo';
    renderUniverse();
    const supported = Array.isArray(snapshot.supportedMetrics) ? snapshot.supportedMetrics.length : null;
    setStage('data', 'done', `${snapshot.source || '数据源'} · 数据日期 ${dateText(snapshot.asOf)}${supported ? ` · 可用字段 ${supported} 个` : ''}`);
  } else {
    setStage('data', 'done', `沿用本次数据快照 · 数据日期 ${dateText(state.snapshot.asOf)}`);
  }

  setStage('verify', 'active', `正在逐项核验 ${state.conditions.length} 条条件`);
  const payload = {
    snapshotId: state.snapshot.id,
    conditions: state.conditions.map(item => ({ id: item.id, metric: item.metric, op: item.op, value: item.value, origin: item.origin })),
    confirmed: true,
  };
  if (state.baseline && state.baseline.snapshotId === state.snapshot.id) payload.baselineConditions = state.baseline.conditions;

  let result;
  try {
    result = await api('/api/screen', { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    if (!current(run)) return;
    endBusy();
    const conflicts = Array.isArray(error.payload?.conflicts) ? error.payload.conflicts : [];
    if (conflicts.length) {
      state.conflictIds = conflicts.flatMap(item => (Array.isArray(item.conditionIds) ? item.conditionIds : []));
      renderConditions();
      setStage('verify', 'error', '条件之间互相冲突');
      showError('screen', '条件冲突：' + conflicts.map(item => item.message || '条件存在冲突').join('；') + '。请调整标红的条件。');
      return;
    }
    if (error.status === 410) {
      setStage('data', 'error', '数据快照已过期');
      setStage('verify', 'idle', '未核验');
      state.snapshotLocalAt = 0;
      if (state.result) {
        state.stale = true;
        markResultStale('这份数据快照已经过期，需要重新获取数据后才能再核验。');
      }
      showError('data', '数据快照已过期，请重新获取数据后再筛选。已显示的结果属于上一次取数。', () => refetch(), { offerDemo: false });
      return;
    }
    setStage('verify', 'error', '核验没有完成');
    showError('screen', error.message, () => confirmFlow(true));
    return;
  }
  if (!current(run)) return;

  const previous = payload.baselineConditions ? clone(payload.baselineConditions) : null;
  state.baseline = { snapshotId: state.snapshot.id, conditions: clone(payload.conditions) };
  state.conflictIds = [];
  state.conditions.forEach(item => { item.edited = false; });
  renderConditions();
  renderResult(result, { previous });
  setStage('verify', 'done', `${result.counts?.pass ?? 0} 家通过，${result.counts?.fail ?? 0} 家未通过，${result.counts?.unknown ?? 0} 家数据不足`);
  endBusy();
}

async function refetch() {
  state.snapshot = null;
  state.snapshotLocalAt = 0;
  state.baseline = null;
  renderUniverse();
  await confirmFlow(true);
}

/* ---------- 手动条件 ---------- */

function askManual() {
  setText('#manualConfirmText', state.conditions.length
    ? `改为手动会清空当前 ${state.conditions.length} 条条件，并放弃这句话里暂不支持的要求。`
    : '改为手动后，由你自己选择指标、比较方式和阈值。');
  $('#manualConfirm').hidden = false;
}

function enterManual() {
  state.run += 1;
  state.busy = false;
  state.resultMatchesIntent = false;
  $('#resultsSkeleton').hidden = true;
  $('#manualConfirm').hidden = true;
  state.intent = { mode: 'manual', summary: '手动设置条件', conditions: [], clarifications: [], warnings: ['手动条件不经过模型解析，口径与阈值由你负责。'], unsupported: [], blocked: false };
  state.conditions = [];
  state.conflictIds = [];
  state.parsedText = $('#intentInput').value.trim();
  state.draftValid = true;
  state.needsConfirmation = false;
  setText('#parseSummary', '手动设置条件：添加指标、比较方式和阈值后筛选。');
  const first = metrics()[0];
  if (first) {
    state.conditions.push(normalizeCondition({ metric: first.id, op: first.defaultOp || 'lt', value: first.defaultValue, origin: '手动添加' }, 0));
  }
  setStage('understand', 'wait', '手动条件，等你确认');
  renderMessages(state.intent);
  renderConditions();
  if (state.result) {
    state.stale = true;
    markResultStale('已改为手动条件，下面仍是上一次的结果。');
  }
}

/* ---------- 数据与口径 ---------- */

function renderDataDialog() {
  const body = $('#dataBody');
  body.replaceChildren();

  const scope = el('div', 'info-sec');
  scope.append(el('h3', null, '观察范围'));
  scope.append(el('p', null, `${state.universe?.label || '12 家 A 股观察样本'}：${state.universe?.description || '用于产品研究的有限观察样本，不是全市场筛选。'}`));
  body.append(scope);

  const source = el('div', 'info-sec');
  source.append(el('h3', null, '本次数据'));
  if (!state.snapshot) {
    source.append(el('p', null, '还没有取数。点开始筛选时会自动获取一份数据快照，来源与日期会显示在这里。'));
  } else {
    const table = el('table', 'info-table');
    const tbody = el('tbody');
    const rows = [
      ['数据模式', state.snapshotMode === 'demo' ? '合成演示数据（非真实行情）' : '自动取数'],
      ['来源', state.snapshot.source || '未命名'],
      ['数据日期', dateText(state.snapshot.asOf)],
      ['获取时间', state.snapshot.fetchedAt ? stampText(new Date(state.snapshot.fetchedAt)) : '未知'],
      ['服务端缓存', state.snapshot.cached ? `是，缓存 ${Math.round(Number(state.snapshot.cacheAgeSeconds) || 0)} 秒` : '否'],
      ['快照有效期', `${Number(state.ttlMinutes) || DEFAULT_TTL_MINUTES} 分钟，过期后需重新获取`],
    ];
    if (Array.isArray(state.snapshot.providerSummary) && state.snapshot.providerSummary.length) {
      rows.push(['取数说明', state.snapshot.providerSummary.filter(item => typeof item === 'string').join('；')]);
    }
    if (Array.isArray(state.snapshot.supportedMetrics) && state.snapshot.supportedMetrics.length) {
      rows.push(['可用字段', state.snapshot.supportedMetrics.map(id => metric(id).label).join('、')]);
    }
    const warnings = (state.snapshot.warnings || []).filter(text => typeof text === 'string');
    if (warnings.length) rows.push(['来源提示', warnings.join('；')]);
    rows.forEach(([label, value]) => {
      const tr = el('tr');
      tr.append(el('td', null, label), el('td', null, value));
      tbody.append(tr);
    });
    table.append(tbody);
    source.append(table);
  }
  body.append(source);

  const catalog = el('div', 'info-sec');
  catalog.append(el('h3', null, '指标口径'));
  catalog.append(el('p', null, '单位与口径都取自服务端指标目录，前端不另外换算。缺值一律显示未知，不会通过筛选。'));
  const table = el('table', 'info-table');
  const thead = el('thead');
  const headRow = el('tr');
  ['指标', '单位', '口径', '说明'].forEach(text => headRow.append(el('th', null, text)));
  thead.append(headRow);
  const tbody = el('tbody');
  metrics().forEach(item => {
    const tr = el('tr');
    tr.append(el('td', null, item.label), el('td', null, item.unit || '无'), el('td', null, item.period || '未标注'), el('td', null, item.description || '见来源备注'));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  catalog.append(table);
  body.append(catalog);

  setText('#demoHint', state.snapshotMode === 'demo'
    ? '当前已在演示数据，公司与数值均为虚构。'
    : '演示数据是合成样本，只能体验流程，不能用于研究真实股票。');
  $('#demoBtn').textContent = state.snapshotMode === 'demo' ? '切回真实数据' : '使用合成演示数据';
}

async function switchMode(mode, { run = false } = {}) {
  state.requestedMode = mode;
  state.snapshot = null;
  state.snapshotMode = mode;
  state.snapshotLocalAt = 0;
  state.baseline = null;
  state.historical = false;
  state.result = null;
  state.resultConditions = null;
  state.stale = false;
  state.run += 1;
  $('#demoBanner').hidden = mode !== 'demo';
  $('#resultsContent').hidden = true;
  clearStaleBanner();
  $('#emptyResults').hidden = false;
  setText('#resultsSub', mode === 'demo'
    ? '已切到合成演示数据，筛选结果只用于体验流程。'
    : '已切回自动取数，点按这些条件筛选会重新获取真实数据。');
  renderUniverse();
  resetStages(state.conditions.length ? '条件仍在左侧，可直接筛选' : '等待输入');
  clearError();
  updateActions();
  if (run && state.conditions.length && conditionsComplete() && state.draftValid && !state.intent?.blocked) await confirmFlow(true);
}

/* ---------- 本地记录 ---------- */

function readRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(validRecord).slice(0, MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

function writeRecords(records) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function validRecord(record) {
  return Boolean(record
    && record.schema === SCHEMA
    && record.snapshot && typeof record.snapshot.id === 'string'
    && Array.isArray(record.conditions) && record.conditions.length
    && record.conditions.every(item => item && typeof item.metric === 'string')
    && record.result && record.result.counts && Array.isArray(record.result.rows));
}

function buildRecord() {
  return clone({
    schema: SCHEMA,
    title: state.intent?.summary || '选股记录',
    savedAt: stampText(),
    savedAtISO: new Date().toISOString(),
    query: state.parsedText,
    mode: state.snapshotMode,
    historical: false,
    snapshot: state.snapshot,
    conditions: state.conditions.map(item => ({ id: item.id, metric: item.metric, op: item.op, value: item.value, origin: item.origin })),
    result: state.result,
    baselineConditions: state.baseline?.conditions || null,
  });
}

function renderRecords() {
  const root = $('#savedList');
  root.replaceChildren();
  if (!state.records.length) {
    root.append(el('p', 'saved-empty', '还没有记录。完成一次筛选后，点保存到本浏览器会存下条件、数据快照和结果。'));
    return;
  }
  root.append(el('p', 'saved-empty', '记录只存在这台浏览器里，恢复后显示为历史结果，不会当作当前数据使用。'));
  state.records.forEach((record, index) => {
    const row = el('div', 'record');
    const copy = el('div', 'record-copy');
    copy.append(el('strong', null, record.query || record.title || '选股记录'));
    copy.append(el('small', null, `保存于 ${record.savedAt || '未知时间'} · 数据日期 ${dateText(record.snapshot?.asOf)} · 通过 ${record.result?.counts?.pass ?? 0} 家 · ${record.mode === 'demo' ? '演示数据' : '自动取数'}`));
    row.append(copy);
    const actions = el('div', 'record-actions');
    const restore = el('button', 'btn btn-ghost btn-sm', '恢复');
    restore.type = 'button';
    restore.addEventListener('click', () => {
      restoreRecord(record);
      $('#historyDialog').close();
    });
    const remove = el('button', 'link-btn', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      state.records = state.records.filter((_, position) => position !== index);
      writeRecords(state.records);
      renderRecords();
    });
    actions.append(restore, remove);
    row.append(actions);
    root.append(row);
  });
}

function saveCurrent() {
  if (!state.result || state.stale || state.historical) {
    showError('input', '先完成一次有效筛选再保存，修改过条件的结果需要重新核验。');
    return;
  }
  const record = buildRecord();
  if (!record) {
    showError('input', '当前结果无法整理成记录，请改用导出 JSON。');
    return;
  }
  const records = [record, ...state.records].slice(0, MAX_RECORDS);
  if (!writeRecords(records)) {
    showError('input', '这台浏览器不允许写入本地存储，请改用导出 JSON 保存。');
    return;
  }
  state.records = records;
  renderRecords();
  setText('#resultFoot', `已保存到本浏览器（最多 ${MAX_RECORDS} 条）· ${record.savedAt}`);
}

function restoreRecord(record) {
  if (!validRecord(record)) {
    showError('input', '这条本地记录不完整或格式不认识，无法恢复。');
    return;
  }
  state.run += 1;
  state.busy = false;
  const copy = clone(record);
  state.historicalRecord = clone(record);
  state.snapshot = copy.snapshot;
  state.snapshotMode = copy.mode === 'demo' ? 'demo' : 'auto';
  state.requestedMode = state.snapshotMode;
  state.snapshotLocalAt = 0;
  state.baseline = null;
  state.conditions = copy.conditions.map((item, index) => normalizeCondition(item, index));
  state.parsedText = copy.query || '';
  state.draftValid = true;
  state.needsConfirmation = false;
  state.intent = { mode: 'manual', summary: copy.title || '历史记录条件', conditions: copy.conditions, clarifications: [], warnings: ['这是历史记录，数据日期以快照为准，不代表当前行情。'], unsupported: [], blocked: false };
  $('#intentInput').value = state.parsedText;
  setText('#charCount', `${state.parsedText.length}/200`);
  setText('#parseSummary', copy.title || '历史记录条件');
  $('#parserMode').textContent = '历史记录';
  $('#parserMode').className = 'tag tag-warn';
  $('#demoBanner').hidden = state.snapshotMode !== 'demo';
  clearError();
  renderMessages(state.intent);
  renderConditions();
  resetStages('历史记录，未重新取数');
  setStage('understand', 'done', '历史记录中的条件');
  setStage('data', 'done', `历史快照 · 数据日期 ${dateText(state.snapshot?.asOf)}`);
  setStage('verify', 'done', `历史结果 · 通过 ${copy.result?.counts?.pass ?? 0} 家`);
  renderResult(copy.result, { historical: true });
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exportCurrent() {
  if (!state.result || state.stale) {
    showError('input', '现在没有可导出的有效结果，先完成一次筛选。');
    return;
  }
  const data = state.historical
    ? clone({ ...(state.historicalRecord || buildRecord()), historical: true, exportedAt: new Date().toISOString(), note: '历史记录导出：数据日期以 snapshot.asOf 为准，不代表导出时点的行情。' })
    : clone({ ...buildRecord(), exportedAt: new Date().toISOString(), note: '导出内容与界面一致：条件、数据快照与逐项证据未作加工。' });
  if (!data) {
    showError('input', '当前结果无法整理成文件。');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = state.historical ? '选股有据-历史记录.json' : '选股有据-筛选记录.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 主题 ---------- */

function applyTheme(mode) {
  state.theme = mode;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (mode === 'system') {
    document.documentElement.dataset.theme = media?.matches ? 'dark' : 'light';
    setText('#themeBtn', '跟随系统');
    return;
  }
  document.documentElement.dataset.theme = mode;
  setText('#themeBtn', mode === 'dark' ? '深色' : '浅色');
}

/* ---------- 启动 ---------- */

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const ok = Boolean(health.ok);
    $('#healthDot').className = `status-dot ${ok ? 'ok' : 'warn'}`;
    const model = health.model?.configured ? '大模型解析可用' : '规则解析模式，未配置大模型';
    const auto = health.data?.autoAvailable ? '自动取数可用' : '自动取数未配置';
    setText('#healthText', ok ? `${model} · ${auto}` : '服务暂不可用');
  } catch {
    $('#healthDot').className = 'status-dot warn';
    setText('#healthText', '服务待连接');
  }
}

async function loadCatalog() {
  try {
    const catalog = await api('/api/catalog');
    if (Array.isArray(catalog.metrics) && catalog.metrics.length) state.catalog = catalog;
    if (catalog.universe) state.universe = catalog.universe;
    if (Number.isFinite(Number(catalog.snapshotTtlMinutes))) state.ttlMinutes = Number(catalog.snapshotTtlMinutes);
    if (catalog.defaultMode === 'demo' || catalog.defaultMode === 'auto') state.requestedMode = catalog.defaultMode;
  } catch {
    state.catalog = { metrics: METRIC_FALLBACK };
  }
  renderUniverse();
  if (state.conditions.length) renderConditions();
}

function setup() {
  applyTheme('system');
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
    if (state.theme === 'system') applyTheme('system');
  });

  state.records = readRecords();
  renderRecords();
  renderUniverse();
  resetStages();
  updateActions();
  loadHealth();
  loadCatalog();

  // 快照有效期到了只提示，不自动重取，避免重复消耗数据额度。
  setInterval(() => {
    if (!state.result || state.historical || !state.snapshot || state.busy) return;
    if (snapshotExpired() && $('#refetchBtn').hidden) {
      setText('#staleText', state.stale
        ? '数据快照已超过有效期，再次核验需要重新获取数据；条件会保留，不用再确认。'
        : `结果仍对应 ${dateText(state.snapshot.asOf)} 的数据快照；快照已超过有效期，再调条件前需重新获取数据。`);
      $('#refetchBtn').hidden = false;
      $('#staleBanner').hidden = false;
      updateActions();
    }
  }, 30_000);

  const input = $('#intentInput');
  input.addEventListener('input', () => {
    setText('#charCount', `${input.value.length}/200`);
    if (input.value.trim() === state.parsedText) {
      state.draftValid = Boolean(state.intent);
      setText('#queryHint', '');
      updateActions();
      return;
    }
    // 输入变了，草稿立即失效，但不会自动发请求。
    state.run += 1;
    state.busy = false;
    state.draftValid = false;
    state.needsConfirmation = false;
    $('#resultsSkeleton').hidden = true;
    setText('#queryHint', state.intent ? '输入已修改，点开始筛选重新理解。' : '');
    if (state.result) {
      state.stale = true;
      markResultStale('输入已修改，下面仍是上一次的结果。');
    }
    resetStages('输入已修改，等待开始筛选');
    updateActions();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startFlow();
    }
  });

  $$('.sample-chip').forEach(chip => chip.addEventListener('click', () => {
    input.value = chip.dataset.sample || '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  }));

  $('#interpretBtn').addEventListener('click', startFlow);
  $('#confirmBtn').addEventListener('click', confirmFlow);
  $('#addConditionBtn').addEventListener('click', () => {
    const used = new Set(state.conditions.map(item => item.metric));
    const next = metrics().find(item => !used.has(item.id)) || metrics()[0];
    if (!next) return;
    if (!state.intent) {
      state.intent = { mode: 'manual', summary: '手动设置条件', conditions: [], clarifications: [], warnings: [], unsupported: [], blocked: false };
      renderMessages(state.intent);
      setText('#parseSummary', '手动设置条件：添加指标、比较方式和阈值后筛选。');
    }
    state.draftValid = true;
    state.conditions.push(normalizeCondition({ metric: next.id, op: next.defaultOp || 'lt', value: next.defaultValue, origin: '手动添加' }, state.conditions.length));
    onConditionsChanged();
    renderConditions();
  });

  $('#manualBtn').addEventListener('click', askManual);
  $('#manualEntryBtn').addEventListener('click', askManual);
  $('#manualCancelBtn').addEventListener('click', () => { $('#manualConfirm').hidden = true; });
  $('#manualConfirmBtn').addEventListener('click', enterManual);

  $('#retryBtn').addEventListener('click', () => state.retry?.());
  $('#refetchBtn').addEventListener('click', () => refetch());
  $('#errorDemoBtn').addEventListener('click', () => switchMode('demo', { run: true }));
  $('#exitDemoBtn').addEventListener('click', () => switchMode('auto'));

  $$('#resultTabs .tab').forEach(tab => tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter || 'pass';
    $$('#resultTabs .tab').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
    renderRows();
  }));

  $('#compareBtn').addEventListener('click', () => {
    if (state.compareCodes.length < 2) return;
    $('#compareTab').hidden = false;
    renderCompare();
    $('#compareTab').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#compareClearBtn').addEventListener('click', () => {
    state.compareCodes = [];
    $('#compareTab').hidden = true;
    renderRows();
    renderCompare();
  });

  $('#saveBtn').addEventListener('click', saveCurrent);
  $('#exportBtn').addEventListener('click', exportCurrent);
  $('#restoreBtn').addEventListener('click', () => {
    state.records = readRecords();
    if (state.records.length === 1) {
      restoreRecord(state.records[0]);
      return;
    }
    renderRecords();
    const dialog = $('#historyDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
  });
  $('#closeHistoryDialog').addEventListener('click', () => $('#historyDialog').close());

  $('#dataInfoBtn').addEventListener('click', () => {
    renderDataDialog();
    const dialog = $('#dataDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
  });
  $('#closeDataDialog').addEventListener('click', () => $('#dataDialog').close());
  $('#demoBtn').addEventListener('click', () => {
    $('#dataDialog').close();
    switchMode(state.snapshotMode === 'demo' ? 'auto' : 'demo');
  });

  $('#closeDialog').addEventListener('click', () => $('#evidenceDialog').close());
  $('#themeBtn').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    applyTheme(order[(order.indexOf(state.theme) + 1) % order.length]);
  });
}

setup();
