const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  catalog: null,
  snapshot: null,
  snapshotMode: null,
  snapshotHistorical: false,
  intent: null,
  parsedText: '',
  intentFresh: false,
  clarificationAccepted: false,
  conditions: [],
  baselineConditions: null,
  result: null,
  stale: false,
  saved: null,
  compareCodes: [],
  retryAction: null,
  requestVersion: { catalog: 0, health: 0, interpret: 0, snapshot: 0, screen: 0 },
  themePreference: 'system'
};

const metricFallback = [
  { id: 'pe_ttm', label: '市盈率（TTM）', unit: '倍', period: 'TTM', defaultOp: 'lt', defaultValue: 20 },
  { id: 'pb_mrq', label: '市净率（MRQ）', unit: '倍', period: 'MRQ', defaultOp: 'lt', defaultValue: 3 },
  { id: 'revenue_yoy', label: '营收同比', unit: '%', period: '年度', defaultOp: 'gt', defaultValue: 10 },
  { id: 'profit_yoy', label: '净利润同比', unit: '%', period: '年度', defaultOp: 'gt', defaultValue: 10 },
  { id: 'roe', label: '净资产收益率', unit: '%', period: 'TTM', defaultOp: 'gt', defaultValue: 10 },
  { id: 'volatility_20d', label: '20日波动率（年化）', unit: '%', period: '20日年化', defaultOp: 'lt', defaultValue: 30 },
  { id: 'return_20d', label: '20日涨跌幅', unit: '%', period: '20日', defaultOp: 'gt', defaultValue: 5 },
  { id: 'market_cap', label: '总市值', unit: '亿元', period: '最新', defaultOp: 'gt', defaultValue: 100 }
];

const opLabels = { gt: '大于', gte: '不低于', lt: '小于', lte: '不高于', eq: '等于' };
const modeLabels = {
  demo: '演示数据',
  fuyao: '扶摇数据',
  ifind: 'iFinD授权数据',
  public: '公开来源'
};

const safeUrl = value => {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

const metric = id => (
  (state.catalog?.metrics || metricFallback).find(item => item.id === id)
  || metricFallback.find(item => item.id === id)
  || { id, label: id || '未知指标', unit: '', period: '' }
);

const setText = (selector, value) => {
  const element = $(selector);
  if (element) element.textContent = value == null ? '' : String(value);
};

const clone = value => {
  if (value == null) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
};

function nextVersion(name) {
  state.requestVersion[name] += 1;
  return state.requestVersion[name];
}

function isCurrent(name, version) {
  return state.requestVersion[name] === version;
}

function friendlyError(error) {
  if (!error) return '暂时无法完成，请稍后重试。';
  const message = String(error.message || '');
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return '暂时无法连接服务，请确认服务已启动后重试。';
  }
  if (message.includes('410')) return '这份快照已过期，请重新加载数据源。';
  return message.length > 180 ? '服务暂时不可用，请稍后重试。' : message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('服务返回了无法读取的结果。');
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `请求未完成（${response.status}）`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

function showError(message, title = '暂时无法完成', retryAction = null) {
  state.retryAction = retryAction;
  $('#errorBox').hidden = false;
  setText('#errorTitle', title);
  setText('#errorMessage', message);
  $('#retryBtn').hidden = !retryAction;
}

function clearError() {
  state.retryAction = null;
  $('#errorBox').hidden = true;
  $('#retryBtn').hidden = true;
}

function resetSnapshot(reason = '请加载数据源后再筛选。', invalidate = true) {
  if (invalidate) nextVersion('snapshot');
  state.snapshot = null;
  state.snapshotMode = null;
  state.snapshotHistorical = false;
  state.baselineConditions = null;
  state.result = null;
  state.compareCodes = [];
  state.stale = true;
  $('#resultsContent').hidden = true;
  $('#emptyResults').hidden = false;
  setText('#resultsSub', reason);
  setText('#snapshotTag', '未生成快照');
  $('#snapshotTag').className = 'snapshot-tag';
  setText('#dataStatus', '尚未加载');
  setText('#modeTitle', '尚未加载数据');
  setText('#modeDescription', '请选择数据模式并加载，结果不会预先生成');
  $('#modeDot').className = 'status-dot';
  renderConditions();
}

function markStale(reason = '条件或数据源已变更，请重新确认并筛选。') {
  nextVersion('screen');
  state.stale = true;
  state.result = null;
  $('#resultsContent').hidden = true;
  $('#emptyResults').hidden = false;
  setText('#resultsSub', reason);
  setText('#snapshotTag', '结果已过期');
  $('#snapshotTag').className = 'snapshot-tag';
  updateConfirmState();
}

function saveJSON(value) {
  try {
    localStorage.setItem('stock-lens:last', JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function readSaved() {
  try {
    const raw = localStorage.getItem('stock-lens:last');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function removeSaved() {
  try {
    localStorage.removeItem('stock-lens:last');
  } catch {
    // 浏览器拒绝访问本地存储时，页面仍可继续使用。
  }
}

function nowLabel(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function conditionCopy(condition) {
  const item = metric(condition.metric);
  const value = Number.isFinite(condition.value) ? condition.value : '未填写';
  return `${item.label} ${opLabels[condition.op] || condition.op || '未设置'} ${value}${item.unit}`;
}

function normalizeCondition(condition, index = 0) {
  let value = condition?.value;
  if (typeof value === 'string') {
    value = value.trim() === '' ? NaN : Number(value);
  } else if (value == null) {
    value = NaN;
  } else {
    value = Number(value);
  }
  return {
    id: condition?.id || `condition-${Date.now()}-${index}`,
    metric: condition?.metric || 'pe_ttm',
    op: condition?.op || 'lt',
    value,
    origin: condition?.origin || '用户确认'
  };
}

function renderConditionOptions(select, selected) {
  select.replaceChildren();
  (state.catalog?.metrics || metricFallback).forEach(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.label}（${item.unit}）`;
    option.selected = item.id === selected;
    select.append(option);
  });
}

function conditionRow(condition) {
  const row = document.createElement('div');
  row.className = 'condition-row';
  row.dataset.id = condition.id;

  const metricSelect = document.createElement('select');
  metricSelect.className = 'metric-select';
  metricSelect.setAttribute('aria-label', '指标');
  renderConditionOptions(metricSelect, condition.metric);

  const operationSelect = document.createElement('select');
  operationSelect.className = 'op-select';
  operationSelect.setAttribute('aria-label', '比较方式');
  Object.entries(opLabels).forEach(([key, label]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    option.selected = key === condition.op;
    operationSelect.append(option);
  });

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.step = 'any';
  valueInput.value = Number.isFinite(condition.value) ? String(condition.value) : '';
  valueInput.setAttribute('aria-label', '阈值');

  const unit = document.createElement('span');
  unit.className = 'step-badge';
  unit.textContent = metric(condition.metric).unit || '';

  const remove = document.createElement('button');
  remove.className = 'remove-btn';
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除条件');
  remove.textContent = '×';

  const update = () => {
    const current = state.conditions.find(item => item.id === condition.id);
    if (!current) return;
    current.metric = metricSelect.value;
    current.op = operationSelect.value;
    current.value = valueInput.value.trim() === '' ? NaN : Number(valueInput.value);
    current.origin = '用户编辑';
    unit.textContent = metric(current.metric).unit || '';
    markStale();
  };

  metricSelect.addEventListener('change', update);
  operationSelect.addEventListener('change', update);
  valueInput.addEventListener('change', update);
  valueInput.addEventListener('input', () => {
    const current = state.conditions.find(item => item.id === condition.id);
    if (!current) return;
    current.value = valueInput.value.trim() === '' ? NaN : Number(valueInput.value);
    current.origin = '用户编辑';
    markStale('条件正在编辑，请完成后重新筛选。');
  });
  remove.addEventListener('click', () => {
    state.conditions = state.conditions.filter(item => item.id !== condition.id);
    markStale('条件已删除，请确认剩余条件后重新筛选。');
  });

  row.append(metricSelect, operationSelect, valueInput, unit, remove);
  return row;
}

function hasBlockingIntent() {
  return Boolean(
    state.intent?.blocked
    || state.intent?.unsupported?.length
    || (state.intent?.clarifications?.length && !state.clarificationAccepted)
  );
}

function updateConfirmState() {
  const complete = state.conditions.length > 0
    && state.conditions.every(condition => Number.isFinite(condition.value));
  const canConfirm = complete
    && Boolean(state.snapshot)
    && !state.snapshotHistorical
    && state.intentFresh
    && !hasBlockingIntent()
    && (!state.stale || !state.result);
  $('#confirmBtn').disabled = !canConfirm;

  if (!state.snapshot) setText('#confirmHint', '请先加载数据源');
  else if (state.snapshotHistorical) setText('#confirmHint', '历史记录仅供查看，请重新加载数据源');
  else if (!state.intentFresh) setText('#confirmHint', '请重新解析当前输入');
  else if (hasBlockingIntent()) setText('#confirmHint', '请确认解释后再筛选，或改为手动定义条件');
  else if (!complete) setText('#confirmHint', '请补全条件');
  else if (state.stale) setText('#confirmHint', '请确认条件后筛选');
  else setText('#confirmHint', '条件将按 AND 组合');
}

function renderConditions() {
  const list = $('#conditionsList');
  list.replaceChildren();
  state.conditions.forEach(condition => list.append(conditionRow(condition)));
  updateConfirmState();
}

function renderMessages(intent) {
  const list = $('#messageList');
  list.replaceChildren();
  const messages = [];
  if (intent?.mode === 'rules') {
    messages.push({ text: '规则解析模式，未调用大模型。请逐条核对后确认。', type: '' });
  } else if (intent?.mode === 'llm') {
    messages.push({ text: '模型解析结果仅供参考，请确认每一条条件。', type: '' });
  }
  (intent?.clarifications || []).forEach(item => {
    messages.push({ text: item.question || item.explanation || '这段意图需要进一步明确。', type: 'warning' });
  });
  (intent?.warnings || []).forEach(text => messages.push({ text, type: 'warning' }));
  (intent?.unsupported || []).forEach(text => messages.push({ text: `暂不支持：${text}`, type: 'danger' }));
  if (intent?.blocked) {
    messages.push({ text: intent.blockReason || '这段请求暂时无法解析。', type: 'danger' });
  }
  if ((intent?.conditions || []).some(item => item.metric === 'volatility_20d')) {
    messages.push({
      text: '波动率口径：20 日收益率标准差年化，按 √252 处理，显示为百分比。',
      type: 'warning'
    });
  }
  if (!messages.length) messages.push({ text: '未发现额外提示，请核对条件的指标、单位和方向。', type: '' });

  messages.forEach(item => {
    const paragraph = document.createElement('p');
    paragraph.className = `message ${item.type}`;
    paragraph.textContent = item.text;
    list.append(paragraph);
  });

  if (intent?.clarifications?.length && !state.clarificationAccepted) {
    const acceptLabel = document.createElement('label');
    acceptLabel.className = 'clarification-accept';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    checkbox.addEventListener('change', () => {
      state.clarificationAccepted = checkbox.checked;
      if (state.clarificationAccepted) {
        const current = document.createElement('p');
        current.className = 'message';
        current.textContent = '已接受以上解释。条件仍可编辑，请确认后筛选。';
        list.insertBefore(current, acceptLabel);
      }
      renderConditions();
    });
    const text = document.createElement('span');
    text.textContent = '我已理解并接受以上解释，保留这些条件供我继续编辑';
    acceptLabel.append(checkbox, text);
    list.append(acceptLabel);
  }

  if (intent?.blocked || intent?.unsupported?.length || (intent?.clarifications?.length && !state.clarificationAccepted)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary';
    button.textContent = '改为手动定义条件';
    button.addEventListener('click', () => {
      state.intent = { mode: 'manual', summary: '手动定义条件', conditions: [], warnings: [], unsupported: [], clarifications: [], blocked: false };
      state.conditions = [];
      state.intentFresh = true;
      state.clarificationAccepted = false;
      setText('#parseSummary', '手动定义条件');
      setText('#parserMode', '手动模式 · 由你确认');
      renderMessages(state.intent);
      renderConditions();
    });
    list.append(button);
  }
}

function renderIntent(intent, text) {
  state.intent = intent;
  state.clarificationAccepted = false;
  state.parsedText = text;
  state.intentFresh = true;
  state.conditions = (intent.conditions || []).map(normalizeCondition);
  $('#parseResult').hidden = false;
  setText('#parseSummary', intent.summary || '已生成可编辑条件');
  setText('#parserMode', intent.mode === 'llm' ? '模型解析 · 待确认' : '规则解析模式 · 未调用大模型');
  setText('#parserNote', intent.mode === 'llm' ? '当前使用模型解析，请确认结果' : '规则解析模式，未调用大模型');
  renderMessages(intent);
  renderConditions();
}

async function interpret() {
  const text = $('#intentInput').value.trim();
  if (!text) {
    showError('请先描述一段选股想法。', '还没有输入');
    return;
  }
  clearError();
  const version = nextVersion('interpret');
  $('#interpretBtn').disabled = true;
  setText('#parserNote', '正在解析，请稍候');
  try {
    const intent = await api('/api/interpret', {
      method: 'POST',
      body: JSON.stringify({ text })
    });
    if (!isCurrent('interpret', version)) return;
    renderIntent(intent, text);
    markStale('条件已更新，请确认后筛选。');
  } catch (error) {
    if (isCurrent('interpret', version)) {
      showError(friendlyError(error), '解析没有完成', interpret);
    }
  } finally {
    if (isCurrent('interpret', version)) {
      $('#interpretBtn').disabled = false;
      if (!state.intentFresh) setText('#parserNote', '输入后解析模式将由服务返回');
    }
  }
}

async function loadCatalog() {
  const version = nextVersion('catalog');
  try {
    const catalog = await api('/api/catalog');
    if (isCurrent('catalog', version)) {
      state.catalog = catalog;
      if (state.conditions.length) renderConditions();
    }
  } catch {
    if (isCurrent('catalog', version)) state.catalog = { metrics: metricFallback };
  }
}

function updateDataDisclosure(mode) {
  const disclosures = {
    demo: ['合成演示数据，非真实行情', '12家虚构公司仅用于体验完整流程，不可据此研究真实股票。'],
    ifind: ['iFinD 授权固定日期快照', '财务报告期2026年9月30日，估值交易日2026年11月6日，非实时行情。当前核验市盈率、市净率和加权净资产收益率，其他字段可能未知。一次加载包含6次工具查询，可能消耗账号额度；仅限授权研究，保存或导出不代表允许再分发。'],
    fuyao: ['扶摇金融数据', '使用服务端配置的数据权限取数，来源、时点和口径以逐项证据为准。'],
    public: ['公开数据来源', '非全市场覆盖。口径或时间无法核实的字段保持未知，不使用其他来源偷偷补值。'],
  };
  const [title, copy] = disclosures[mode] || disclosures.demo;
  setText('#disclosureTitle', title);
  setText('#disclosureCopy', copy);
  $('#disclosure').hidden = false;
}

function setDataSourceSummary(snapshot) {
  const source = $('#sourceSummary');
  source.replaceChildren();
  const icon = document.createElement('div');
  icon.className = 'source-icon';
  icon.textContent = '✓';
  const copyElement = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = snapshot.source || '数据源已加载';
  const paragraph = document.createElement('p');
  paragraph.textContent = `${snapshot.universe?.label || '观察样本'} · ${snapshot.warnings?.[0] || '数据口径以来源记录为准'}`;
  copyElement.append(strong, paragraph);
  source.append(icon, copyElement);

  const asOf = snapshot.asOf ? nowLabel(new Date(snapshot.asOf)) : '未知';
  const fetched = snapshot.fetchedAt ? nowLabel(new Date(snapshot.fetchedAt)) : '未知';
  const meta = $('#sourceMeta');
  meta.replaceChildren();
  ['来源：' + (snapshot.source || '未命名'), `数据截至：${asOf}`, `加载于：${fetched}`].forEach(text => {
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  });

  const mode = state.snapshotMode || snapshot.mode;
  updateDataDisclosure(mode);
  setText('#modeTitle', `${modeLabels[mode] || '数据源'}${state.snapshotHistorical ? '历史记录已恢复' : '已加载'}`);
  setText('#modeDescription', mode === 'demo' ? '合成演示数据，非真实行情' : '以服务返回的来源、日期和口径为准');
  $('#modeDot').className = 'status-dot ok';
}

async function loadData() {
  const mode = $('#dataMode').value;
  updateDataDisclosure(mode);
  clearError();
  resetSnapshot('正在加载数据源，请稍候。', false);
  const version = nextVersion('snapshot');
  $('#loadDataBtn').disabled = true;
  setText('#dataStatus', '加载中');
  setText('#modeTitle', `${modeLabels[mode] || '数据源'}加载中`);
  setText('#modeDescription', '正在获取此来源的固定快照');
  try {
    const snapshot = await api('/api/snapshot', {
      method: 'POST',
      body: JSON.stringify({ mode })
    });
    if (!isCurrent('snapshot', version)) return;
    state.snapshot = snapshot;
    state.snapshotMode = mode;
    state.snapshotHistorical = false;
    state.stale = true;
    setDataSourceSummary(snapshot);
    setText('#dataStatus', '已加载');
    setText('#snapshotTag', '快照已加载');
    $('#emptyResults').hidden = false;
    $('#resultsContent').hidden = true;
    setText('#resultsSub', '快照已就绪，确认条件后开始筛选。');
    renderConditions();
  } catch (error) {
    if (isCurrent('snapshot', version)) {
      resetSnapshot('数据源加载失败，请按错误提示重试。', false);
      setText('#dataStatus', '加载失败');
      showError(friendlyError(error), '数据源没有加载', loadData);
    }
  } finally {
    if (isCurrent('snapshot', version)) $('#loadDataBtn').disabled = false;
  }
}

function createStat(label, value) {
  const element = document.createElement('div');
  element.className = 'stat-card';
  const labelElement = document.createElement('span');
  labelElement.textContent = label;
  const valueElement = document.createElement('strong');
  valueElement.textContent = value;
  element.append(labelElement, valueElement);
  return element;
}

function renderStats(result) {
  const row = $('#statsRow');
  row.replaceChildren();
  row.append(
    createStat('通过', result.counts?.pass ?? 0),
    createStat('未通过', result.counts?.fail ?? 0),
    createStat('未知', result.counts?.unknown ?? 0),
    createStat('样本总数', result.counts?.total ?? 0)
  );
}

function statusLabel(status) {
  return status === 'pass' ? '通过' : status === 'fail' ? '未通过' : '未知';
}

function showRowEvidence(row) {
  setText('#dialogTitle', `${row.name || '标的'} · 证据`);
  const body = $('#dialogBody');
  body.replaceChildren();
  (row.checks || []).forEach(check => {
    const evidence = check.evidence || {};
    const detail = document.createElement('dl');
    detail.className = 'dialog-row';
    const label = document.createElement('dt');
    label.textContent = conditionCopy(check.condition || {});
    const value = document.createElement('dd');
    const shownValue = evidence.value == null ? '未知' : `${evidence.value}${evidence.unit || ''}`;
    value.textContent = `${statusLabel(check.result)} · ${shownValue} · ${evidence.period || '期间未知'} · ${evidence.asOf || '日期未知'}`;

    const source = document.createElement('p');
    source.textContent = `来源：${evidence.source || '未提供'} · 字段：${evidence.field || '未提供'}`;
    value.append(source);
    const reason = document.createElement('p');
    reason.textContent = `判断说明：${check.reason || evidence.note || '未提供'}`;
    value.append(reason);
    if (evidence.note) {
      const note = document.createElement('p');
      note.textContent = `来源备注：${evidence.note}`;
      value.append(note);
    }
    const raw = document.createElement('p');
    raw.textContent = `原始值：${evidence.raw == null ? '未提供' : JSON.stringify(evidence.raw)}`;
    value.append(raw);

    const url = safeUrl(evidence.sourceUrl);
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看来源链接';
      value.append(link);
    }
    detail.append(label, value);
    body.append(detail);
  });
  const dialog = $('#evidenceDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
}

function renderOverview(result) {
  const root = $('#overviewTab');
  root.replaceChildren();
  const scroll = document.createElement('div');
  scroll.className = 'overview-scroll';
  const table = document.createElement('table');
  table.className = 'result-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['标的', '行业', '结论', '条件核验'].forEach(text => {
    const header = document.createElement('th');
    header.textContent = text;
    headerRow.append(header);
  });
  head.append(headerRow);
  const body = document.createElement('tbody');

  (result.rows || []).forEach(row => {
    const tableRow = document.createElement('tr');
    const name = document.createElement('td');
    const strong = document.createElement('span');
    strong.className = 'stock-name';
    strong.textContent = row.name || '未命名';
    const code = document.createElement('span');
    code.className = 'stock-code';
    code.textContent = row.code || '未知代码';
    name.append(strong, code);
    const industry = document.createElement('td');
    industry.textContent = row.industry || '未分类';
    const status = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `status-pill status-${row.status}`;
    pill.textContent = statusLabel(row.status);
    status.append(pill);
    const checks = document.createElement('td');
    checks.textContent = `${(row.checks || []).filter(item => item.result === 'pass').length}/${(row.checks || []).length} 条通过`;
    tableRow.append(name, industry, status, checks);
    tableRow.tabIndex = 0;
    tableRow.addEventListener('click', () => showRowEvidence(row));
    tableRow.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showRowEvidence(row);
      }
    });
    body.append(tableRow);
  });

  table.append(head, body);
  scroll.append(table);
  root.append(scroll);
  const note = document.createElement('p');
  note.className = 'results-sub';
  note.textContent = '点击或按回车查看逐字段证据。失败优先于未知，单项核验仍可追溯。';
  root.append(note);
}

function renderEvidence(result) {
  const root = $('#evidenceTab');
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'evidence-grid';
  const rows = (result.rows || []).filter(row => row.checks?.length).slice(0, 8);
  rows.forEach(row => {
    const card = document.createElement('div');
    card.className = 'evidence-card';
    const copyElement = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = row.name || row.code || '标的';
    const paragraph = document.createElement('p');
    paragraph.textContent = `${row.checks.length} 条字段证据 · ${statusLabel(row.status)}`;
    copyElement.append(strong, paragraph);
    const button = document.createElement('button');
    button.className = 'button button-secondary';
    button.type = 'button';
    button.textContent = '查看证据';
    button.addEventListener('click', () => showRowEvidence(row));
    card.append(copyElement, button);
    grid.append(card);
  });
  root.append(grid);
  if (!rows.length) {
    const paragraph = document.createElement('p');
    paragraph.className = 'results-sub';
    paragraph.textContent = '当前结果没有可展示的字段证据。';
    root.append(paragraph);
  }
}

function renderCompare(result) {
  const root = $('#compareTab');
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'compare-box';
  const title = document.createElement('h3');
  title.textContent = '同一快照的条件前后变化';
  const help = document.createElement('p');
  help.className = 'compare-help';
  help.textContent = '前后对比只在同一个数据快照中计算，避免把不同时间的数据混在一起。';
  box.append(title, help);

  const diff = result.diff;
  if (!diff) {
    const paragraph = document.createElement('p');
    paragraph.className = 'compare-help';
    paragraph.textContent = '这是本次快照的首次筛选。下次在相同快照上修改条件并确认后，会显示新增、移除与保持不变的标的。';
    box.append(paragraph);
  } else {
    const list = document.createElement('div');
    list.className = 'diff-list';
    [['新增', diff.added], ['移除', diff.removed], ['不变', diff.unchanged]].forEach(([label, items]) => {
      const span = document.createElement('span');
      const strong = document.createElement('b');
      strong.textContent = `${label} ${items?.length || 0}`;
      span.append(strong, document.createTextNode(items?.length ? `：${items.join('、')}` : ''));
      list.append(span);
    });
    const paragraph = document.createElement('p');
    paragraph.className = 'compare-help';
    paragraph.textContent = `前次通过 ${diff.baselineCount} 家，本次通过 ${diff.currentCount} 家。`;
    box.append(list, paragraph);
  }
  root.append(box);

  const candidates = (result.rows || []).filter(row => row.status === 'pass').slice(0, 8);
  if (!candidates.length) return;
  const candidateBox = document.createElement('div');
  candidateBox.className = 'candidate-box';
  const candidateTitle = document.createElement('h3');
  candidateTitle.textContent = '候选对比（可选 2–3 只）';
  const candidateNote = document.createElement('p');
  candidateNote.className = 'compare-help';
  candidateNote.textContent = '仅对比当前同一快照的候选，不代表推荐或收益承诺。';
  const picker = document.createElement('div');
  picker.className = 'candidate-picker';
  candidateBox.append(candidateTitle, candidateNote, picker);

  candidates.forEach(row => {
    const label = document.createElement('label');
    label.className = 'candidate-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = row.code || '';
    checkbox.checked = state.compareCodes.includes(checkbox.value);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (state.compareCodes.length >= 3) {
          checkbox.checked = false;
          return;
        }
        state.compareCodes.push(checkbox.value);
      } else {
        state.compareCodes = state.compareCodes.filter(code => code !== checkbox.value);
      }
    });
    const text = document.createElement('span');
    text.textContent = `${row.name || '未命名'}（${row.code || '无代码'}）`;
    label.append(checkbox, text);
    picker.append(label);
  });

  const compareButton = document.createElement('button');
  compareButton.type = 'button';
  compareButton.className = 'button button-secondary';
  compareButton.textContent = '生成对比';
  compareButton.addEventListener('click', () => {
    candidateBox.querySelector('.candidate-output')?.remove();
    const selected = candidates.filter(row => state.compareCodes.includes(row.code));
    if (selected.length < 2) {
      const hint = document.createElement('p');
      hint.className = 'compare-help candidate-output';
      hint.textContent = '请先选择 2–3 只候选。';
      candidateBox.append(hint);
      return;
    }
    const output = document.createElement('div');
    output.className = 'candidate-output compare-table';
    selected.forEach(row => {
      const item = document.createElement('div');
      item.className = 'evidence-card';
      const copyElement = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = row.name || row.code || '未命名';
      const paragraph = document.createElement('p');
      paragraph.textContent = (row.checks || []).map(check => {
        const evidence = check.evidence || {};
        const shown = evidence.value == null ? '未知' : `${evidence.value}${evidence.unit || ''}`;
        return `${metric(check.condition?.metric).label}：${shown}`;
      }).join(' · ');
      copyElement.append(strong, paragraph);
      item.append(copyElement);
      output.append(item);
    });
    candidateBox.append(output);
  });
  candidateBox.append(compareButton);
  root.append(candidateBox);
}

function renderResult(result, historical = false) {
  state.result = result;
  state.stale = false;
  state.snapshotHistorical = historical;
  clearError();
  $('#emptyResults').hidden = true;
  $('#resultsContent').hidden = false;
  setText('#snapshotTag', historical ? '历史记录 · 仅供查看' : `同一快照 · ${result.counts?.pass ?? 0} 家通过`);
  setText('#resultsSub', historical
    ? '这是本地保存的历史结果，不代表实时行情。若要重新筛选，请重新加载数据源。'
    : `已按 ${result.conditions?.length || 0} 条已确认条件筛选 · ${state.snapshot?.asOf ? '数据截至 ' + state.snapshot.asOf : '数据日期未知'}`);
  renderStats(result);
  renderOverview(result);
  renderEvidence(result);
  renderCompare(result);
  renderConditions();
}

async function screen() {
  if (!state.snapshot) {
    showError('请先加载数据源，再确认条件。', '还没有数据快照', loadData);
    return;
  }
  if (state.snapshotHistorical) {
    showError('历史记录仅供查看，请重新加载数据源后再筛选。', '需要重新加载数据', loadData);
    return;
  }
  if (!state.intentFresh || hasBlockingIntent()) {
    showError('当前输入仍有待处理提示，请重新解析或改为手动定义条件。', '条件尚未确认');
    return;
  }
  if (!state.conditions.length) {
    showError('请至少添加一条条件。', '条件不能为空');
    return;
  }
  if (state.conditions.some(condition => !Number.isFinite(condition.value))) {
    showError('请为每条条件填写有效阈值。', '阈值未填写');
    renderConditions();
    return;
  }

  clearError();
  const version = nextVersion('screen');
  $('#confirmBtn').disabled = true;
  setText('#confirmHint', '正在筛选，请稍候');
  try {
    const result = await api('/api/screen', {
      method: 'POST',
      body: JSON.stringify({
        snapshotId: state.snapshot.id,
        conditions: clone(state.conditions),
        baselineConditions: state.baselineConditions ? clone(state.baselineConditions) : undefined,
        confirmed: true
      })
    });
    if (!isCurrent('screen', version)) return;
    state.baselineConditions = clone(state.conditions);
    renderResult(result);
  } catch (error) {
    if (!isCurrent('screen', version)) return;
    const conflicts = error.payload?.conflicts;
    if (conflicts?.length) {
      showError(conflicts.map(item => item.message || '条件存在冲突').join('；'), '条件之间存在冲突', screen);
    } else {
      showError(friendlyError(error), error.status === 410 ? '快照已过期' : '筛选没有完成', screen);
    }
  } finally {
    if (isCurrent('screen', version)) {
      $('#confirmBtn').disabled = false;
      renderConditions();
    }
  }
}

function validSavedRecord(record) {
  return Boolean(
    record
    && record.schema === 1
    && record.snapshot
    && typeof record.snapshot.id === 'string'
    && Array.isArray(record.conditions)
    && record.conditions.length > 0
    && record.conditions.every(condition => condition && typeof condition.metric === 'string')
    && record.result
    && record.result.counts
    && Array.isArray(record.result.rows)
  );
}

function renderSaved() {
  const root = $('#savedContent');
  root.replaceChildren();
  if (!state.saved) {
    const empty = document.createElement('div');
    empty.className = 'saved-empty';
    empty.textContent = '暂无保存记录。完成一次筛选后，可保存条件、快照与结果。';
    root.append(empty);
    return;
  }
  const item = document.createElement('div');
  item.className = 'saved-record';
  const copyElement = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = state.saved.title || '未命名研究记录';
  const small = document.createElement('small');
  small.textContent = `保存于 ${state.saved.savedAt || '未知时间'} · 历史记录，不代表实时行情`;
  copyElement.append(strong, small);
  const actions = document.createElement('div');
  const restore = document.createElement('button');
  restore.className = 'button button-secondary';
  restore.type = 'button';
  restore.textContent = '恢复';
  restore.addEventListener('click', restoreSaved);
  const clear = document.createElement('button');
  clear.className = 'text-button';
  clear.type = 'button';
  clear.textContent = '删除';
  clear.addEventListener('click', () => {
    removeSaved();
    state.saved = null;
    setText('#storageStatus', '本地存储待使用');
    renderSaved();
  });
  actions.append(restore, clear);
  item.append(copyElement, actions);
  root.append(item);
}

function saveCurrent() {
  if (!state.snapshot || !state.result || state.stale) {
    showError('请先完成数据加载和一次有效筛选，再保存完整记录。', '暂时不能保存');
    return;
  }
  const record = clone({
    schema: 1,
    title: state.intent?.summary || '选股研究记录',
    savedAt: nowLabel(),
    parsedText: state.parsedText,
    snapshot: state.snapshot,
    snapshotMode: state.snapshotMode,
    conditions: state.conditions,
    result: state.result,
    baselineConditions: state.baselineConditions
  });
  if (!record || !saveJSON(record)) {
    showError('浏览器存储空间不可用，请改用导出 JSON 保存。', '无法写入本地记录');
    return;
  }
  state.saved = record;
  setText('#storageStatus', '已保存到本地');
  renderSaved();
}

function restoreSaved() {
  const record = state.saved || readSaved();
  if (!validSavedRecord(record)) {
    showError('本地记录格式无法识别或缺少完整结果，请使用完整 JSON。', '无法恢复记录');
    return;
  }
  state.saved = clone(record);
  state.snapshot = clone(record.snapshot);
  state.snapshotMode = record.snapshotMode || record.snapshot.mode;
  state.snapshotHistorical = true;
  state.clarificationAccepted = false;
  state.intent = {
    mode: 'manual',
    summary: record.title || '历史研究条件',
    conditions: record.conditions,
    warnings: [],
    unsupported: [],
    clarifications: [],
    blocked: false
  };
  state.parsedText = record.parsedText || '';
  state.intentFresh = true;
  state.conditions = record.conditions.map(normalizeCondition);
  state.baselineConditions = clone(record.baselineConditions || record.conditions);
  $('#parseResult').hidden = false;
  $('#intentInput').value = state.parsedText;
  setText('#charCount', `${state.parsedText.length} / 200`);
  setText('#parseSummary', '历史研究条件');
  setText('#parserMode', '历史记录 · 由你此前确认');
  setText('#parserNote', '历史记录不会调用大模型');
  renderMessages(state.intent);
  setDataSourceSummary(state.snapshot);
  $('#dataMode').value = state.snapshotMode;
  setText('#dataStatus', '已恢复历史');
  setText('#storageStatus', '已恢复历史记录');
  renderConditions();
  renderResult(record.result, true);
  document.querySelector('#results').scrollIntoView({ behavior: 'smooth' });
}

function exportCurrent() {
  if (!state.snapshot || !state.result || state.stale) {
    showError('当前还没有可导出的有效结果，请先完成筛选。', '没有可导出的记录');
    return;
  }
  const data = clone({
    schema: 1,
    title: state.intent?.summary || '选股研究记录',
    savedAt: nowLabel(),
    parsedText: state.parsedText,
    snapshot: state.snapshot,
    snapshotMode: state.snapshotMode,
    conditions: state.conditions,
    result: state.result,
    baselineConditions: state.baselineConditions
  });
  if (!data) {
    showError('当前数据无法整理为导出文件。', '导出没有完成');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '选股有据-研究记录.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme(mode) {
  state.themePreference = mode;
  if (mode === 'system') {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    document.documentElement.dataset.theme = media?.matches ? 'dark' : 'light';
    setText('#themeBtn', '跟随系统');
    return;
  }
  document.documentElement.dataset.theme = mode;
  setText('#themeBtn', mode === 'dark' ? '深色模式' : '浅色模式');
}

function setupTheme() {
  applyTheme('system');
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', () => {
    if (state.themePreference === 'system') applyTheme('system');
  });
  $('#themeBtn').addEventListener('click', () => {
    if (state.themePreference === 'system') applyTheme(media?.matches ? 'light' : 'dark');
    else if (state.themePreference === 'dark') applyTheme('light');
    else applyTheme('system');
  });
}

function setup() {
  const saved = readSaved();
  if (validSavedRecord(saved)) {
    state.saved = saved;
    setText('#storageStatus', '有一条本地记录');
  }
  renderSaved();
  setupTheme();

  const healthVersion = nextVersion('health');
  setText('#healthText', '正在检查连接');
  api('/api/health').then(health => {
    if (!isCurrent('health', healthVersion)) return;
    $('#healthDot').classList.toggle('ok', Boolean(health.ok));
    const model = health.model?.configured ? `模型已配置：${health.model.name || '已配置'}` : '规则解析模式，未配置模型';
    setText('#healthText', health.ok ? `服务连接正常 · ${model}` : '服务暂不可用');
  }).catch(() => {
    if (!isCurrent('health', healthVersion)) return;
    $('#healthDot').classList.remove('ok');
    setText('#healthText', '服务待连接');
  });

  loadCatalog();
  $('#intentInput').addEventListener('input', event => {
    const text = event.target.value;
    setText('#charCount', `${text.length} / 200`);
    if (text.trim() !== state.parsedText) {
      state.intentFresh = false;
      markStale('输入已修改，请重新解析当前研究意图。');
      setText('#parserNote', '输入已改变，请重新解析');
    }
  });
  $$('.sample-chip').forEach(button => button.addEventListener('click', () => {
    $('#intentInput').value = button.dataset.sample || '';
    $('#intentInput').dispatchEvent(new Event('input'));
    $('#intentInput').focus();
  }));
  $('#interpretBtn').addEventListener('click', interpret);
  $('#addConditionBtn').addEventListener('click', () => {
    state.intentFresh = true;
    state.conditions.push(normalizeCondition({
      metric: 'pe_ttm',
      op: 'lt',
      value: metric('pe_ttm').defaultValue,
      origin: '用户添加'
    }, state.conditions.length));
    $('#parseResult').hidden = false;
    markStale('条件已添加，请确认后重新筛选。');
  });
  $('#confirmBtn').addEventListener('click', screen);
  $('#loadDataBtn').addEventListener('click', loadData);
  $('#retryBtn').addEventListener('click', () => state.retryAction?.());
  $('#errorRetryBtn').addEventListener('click', () => state.retryAction?.());
  $('#saveBtn').addEventListener('click', saveCurrent);
  $('#restoreBtn').addEventListener('click', restoreSaved);
  $('#exportBtn').addEventListener('click', exportCurrent);
  $('#dismissDisclosure').addEventListener('click', () => { $('#disclosure').hidden = true; });
  $('#closeDialog').addEventListener('click', () => $('#evidenceDialog').close());
  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(item => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    ['overview', 'evidence', 'compare'].forEach(name => {
      $(`#${name}Tab`).hidden = name !== tab.dataset.tab;
    });
  }));
  $('#dataMode').addEventListener('change', () => {
    updateDataDisclosure($('#dataMode').value);
    resetSnapshot('数据模式已改变，请加载新的数据源。');
    clearError();
  });
}

setup();
