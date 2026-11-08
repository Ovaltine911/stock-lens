import { getMetric, METRICS } from './catalog.mjs';

const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function conflict(metric, message, conditionIds) {
  return { metric, message, conditionIds: [...new Set(conditionIds)] };
}

/** Validate only explicit, deterministic conditions. Never coerces user input. */
export function validateConditions(conditions) {
  const errors = [];
  const conflicts = [];
  if (!Array.isArray(conditions)) return { valid: false, errors: ['conditions 必须是数组'], conflicts };
  if (conditions.length === 0) return { valid: false, errors: ['至少需要一个筛选条件'], conflicts };
  if (conditions.length > 16) return { valid: false, errors: ['筛选条件最多 16 个'], conflicts };
  const ids = new Set();
  const byMetric = new Map();
  conditions.forEach((condition, index) => {
    if (!plainObject(condition)) {
      errors.push(`第 ${index + 1} 个条件必须是对象`);
      return;
    }
    const id = typeof condition.id === 'string' && condition.id.trim() ? condition.id.trim() : `condition-${index + 1}`;
    if (typeof condition.id !== 'string' || !condition.id.trim()) errors.push(`第 ${index + 1} 个条件缺少 id`);
    else if (ids.has(condition.id)) errors.push(`条件 id 重复：${condition.id}`);
    ids.add(id);
    if (!getMetric(condition.metric)) errors.push(`不支持的指标：${String(condition.metric)}`);
    if (!OPERATORS.has(condition.op)) errors.push(`不支持的运算符：${String(condition.op)}`);
    if (!finite(condition.value)) errors.push(`条件 ${id} 的 value 必须是有限数字`);
    if (typeof condition.origin !== 'string' || !condition.origin.trim()) errors.push(`条件 ${id} 缺少 origin`);
    if (getMetric(condition.metric) && OPERATORS.has(condition.op) && finite(condition.value)) {
      if (!byMetric.has(condition.metric)) byMetric.set(condition.metric, []);
      byMetric.get(condition.metric).push({ ...condition, id });
    }
  });

  for (const [metric, list] of byMetric) {
    const equals = list.filter((c) => c.op === 'eq');
    if (equals.length > 1 && equals.some((c) => c.value !== equals[0].value)) {
      conflicts.push(conflict(metric, '同一指标的等于条件互相冲突', equals.map((c) => c.id)));
    }
    const eq = equals[0];
    const lower = list.filter((c) => c.op === 'gt' || c.op === 'gte')
      .sort((a, b) => b.value - a.value || (a.op === 'gt' ? -1 : 1) - (b.op === 'gt' ? -1 : 1))[0];
    const upper = list.filter((c) => c.op === 'lt' || c.op === 'lte')
      .sort((a, b) => a.value - b.value || (a.op === 'lt' ? -1 : 1) - (b.op === 'lt' ? -1 : 1))[0];
    if (lower && upper) {
      const impossible = lower.value > upper.value ||
        (lower.value === upper.value && (lower.op === 'gt' || upper.op === 'lt'));
      if (impossible) conflicts.push(conflict(metric, '严格/包含边界条件没有可满足的交集', [lower.id, upper.id]));
    }
    if (eq) {
      const incompatible = list.filter((c) => c.id !== eq.id && (
        (c.op === 'gt' && eq.value <= c.value) ||
        (c.op === 'gte' && eq.value < c.value) ||
        (c.op === 'lt' && eq.value >= c.value) ||
        (c.op === 'lte' && eq.value > c.value) ||
        (c.op === 'eq' && eq.value !== c.value)
      ));
      if (incompatible.length) conflicts.push(conflict(metric, '等于条件与边界条件冲突', [eq.id, ...incompatible.map((c) => c.id)]));
    }
  }
  return { valid: errors.length === 0 && conflicts.length === 0, errors, conflicts };
}

function compare(value, condition) {
  switch (condition.op) {
    case 'gt': return value > condition.value;
    case 'gte': return value >= condition.value;
    case 'lt': return value < condition.value;
    case 'lte': return value <= condition.value;
    case 'eq': return value === condition.value;
    default: return false;
  }
}

function unknownEvidence(metric, stock, reason = '缺少可用证据') {
  return {
    value: null, source: '', sourceUrl: '', field: metric, asOf: null,
    period: getMetric(metric)?.period ?? '', unit: getMetric(metric)?.unit ?? '',
    status: 'missing', note: reason,
  };
}

const OP_LABELS = { gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', eq: '等于' };
function validAsOf(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value);
}

function checkCondition(stock, condition) {
  const metric = getMetric(condition.metric);
  const evidence = plainObject(stock?.metrics?.[condition.metric])
    ? stock.metrics[condition.metric] : unknownEvidence(condition.metric, stock);
  const value = evidence.value;
  // A numeric value without provenance/period/unit/date metadata is not
  // auditable and therefore remains unknown, even when marked "ok".
  const hasMetadata = typeof evidence.source === 'string' && evidence.source.trim() !== '' &&
    typeof evidence.field === 'string' && evidence.field.trim() !== '' &&
    typeof evidence.period === 'string' && evidence.period === metric.period &&
    typeof evidence.unit === 'string' && evidence.unit === metric.unit &&
    validAsOf(evidence.asOf);
  const usable = evidence.status === 'ok' && finite(value) && hasMetadata;
  if (!usable) {
    const reason = evidence.status === 'stale' ? '证据已过期，不能通过筛选' :
      evidence.status === 'error' ? '证据读取错误，不能通过筛选' :
      !hasMetadata ? '证据缺少可审计元数据，结果未知' : '证据缺失或不是有限数字，结果未知';
    return { condition, evidence, result: 'unknown', reason };
  }
  const passed = compare(value, condition);
  return { condition, evidence, result: passed ? 'pass' : 'fail', reason: passed ? `证据值 ${value} 满足${OP_LABELS[condition.op]} ${condition.value}` : `证据值 ${value} 不满足${OP_LABELS[condition.op]} ${condition.value}` };
}

function screenRows(snapshot, conditions) {
  const stocks = Array.isArray(snapshot?.stocks) ? snapshot.stocks : [];
  return stocks.map((stock) => {
    const checks = conditions.map((condition) => checkCondition(stock, condition));
    const status = checks.some((check) => check.result === 'fail') ? 'fail' : checks.some((check) => check.result === 'unknown') ? 'unknown' : 'pass';
    return { code: typeof stock?.code === 'string' ? stock.code : '', name: typeof stock?.name === 'string' ? stock.name : '', industry: typeof stock?.industry === 'string' ? stock.industry : '', status, checks };
  });
}

function counts(rows) {
  return rows.reduce((result, row) => { result[row.status] += 1; result.total += 1; return result; }, { pass: 0, fail: 0, unknown: 0, total: 0 });
}

/** Screen one immutable snapshot. Unknown evidence never passes. */
export function screenSnapshot(snapshot, conditions, baselineConditions) {
  const validation = validateConditions(conditions);
  if (!validation.valid) {
    const error = new Error(validation.errors.concat(validation.conflicts.map((item) => item.message)).join('；') || '筛选条件无效');
    error.code = validation.conflicts.length ? 'CONFLICT' : 'INVALID_CONDITIONS';
    error.conflicts = validation.conflicts;
    throw error;
  }
  if (!plainObject(snapshot) || !Array.isArray(snapshot.stocks) || typeof snapshot.id !== 'string') {
    const error = new Error('snapshot 无效'); error.code = 'INVALID_SNAPSHOT'; throw error;
  }
  const rows = screenRows(snapshot, conditions);
  let diff = null;
  if (baselineConditions !== undefined) {
    const baselineValidation = validateConditions(baselineConditions);
    if (!baselineValidation.valid) {
      const error = new Error('baselineConditions 无效'); error.code = baselineValidation.conflicts.length ? 'CONFLICT' : 'INVALID_CONDITIONS'; error.conflicts = baselineValidation.conflicts; throw error;
    }
    const baselineRows = screenRows(snapshot, baselineConditions);
    const currentSet = new Set(rows.filter((row) => row.status === 'pass').map((row) => row.code));
    const baselineSet = new Set(baselineRows.filter((row) => row.status === 'pass').map((row) => row.code));
    diff = {
      added: [...currentSet].filter((code) => !baselineSet.has(code)),
      removed: [...baselineSet].filter((code) => !currentSet.has(code)),
      unchanged: [...currentSet].filter((code) => baselineSet.has(code)),
      baselineCount: baselineSet.size,
      currentCount: currentSet.size,
    };
  }
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.filter((item) => typeof item === 'string') : [];
  if (rows.some((row) => row.status === 'unknown')) warnings.push('部分证据缺失、过期或错误，未知结果不会通过筛选。');
  return { snapshotId: snapshot.id, conditions: conditions.map((condition) => ({ ...condition })), counts: counts(rows), rows, conflicts: [], diff, warnings: [...new Set(warnings)] };
}

export { OPERATORS };
