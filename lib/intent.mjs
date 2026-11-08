import { getMetric } from './catalog.mjs';

const metricTerms = [
  ['revenue_yoy_annual', ['年度营收同比', '年度营业收入同比']],
  ['profit_yoy_annual', ['年度归母净利润同比', '年度净利润同比']],
  ['pe_ttm', ['市盈率', 'PE', 'pe']],
  ['pb_mrq', ['市净率', 'PB', 'pb']],
  ['revenue_yoy', ['营收同比', '收入同比', '营收增长']],
  ['profit_yoy', ['利润同比', '净利同比', '利润增长']],
  ['roe', ['ROE', '净资产收益率']],
  ['volatility_20d', ['波动率', '波动']],
  ['return_20d', ['收益率', '涨幅', '回报']],
  ['market_cap', ['市值', '总市值']],
];
const opWords = [
  ['gte', ['不低于', '至少', '大于等于', '≥', '>=']],
  ['lte', ['不高于', '至多', '小于等于', '≤', '<=']],
  ['gt', ['高于', '大于', '超过', '>']],
  ['lt', ['低于', '小于', '少于', '<']],
  ['eq', ['等于', '为', '=']],
];
const numberPattern = '(-?\\d+(?:\\.\\d+)?)';
const numberFrom = (text, position) => {
  const match = text.slice(position).match(new RegExp(`^\\s*${numberPattern}`));
  return match ? { value: Number(match[1]), length: match[0].length } : null;
};

function normalizeText(value) { return typeof value === 'string' ? value.trim() : ''; }
function makeCondition(metric, op, value, origin, index, draft = false) {
  return { id: `${metric}-${index + 1}`, metric, op, value, origin, ...(draft ? { draft: true, requiresConfirmation: true } : {}) };
}

const unsupportedPatterns = [
  [/股息率|分红|股利/, '分红/股息率条件'],
  [/近\s*(?!20\s*(?:日|天|个交易日))\d+\s*(?:日|天|周|月|年).*(?:涨幅|收益率|回报)/, '非目录时间窗口'],
];
function unsupportedTerms(text) {
  return unsupportedPatterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

/** Compliance guard: block direct transactions, promises, and deterministic predictions only. */
export function checkCompliance(input) {
  const text = normalizeText(input);
  const direct = /(买入|卖出|购买|建仓|加仓|减仓|清仓|直接交易|下单|荐股)/;
  const promise = /(保证|稳赚|必涨|必赚|无风险|确定收益|收益承诺|翻倍|确定性预测|一定会涨|明天涨)/;
  if (direct.test(text)) return { blocked: true, reason: '不能提供直接买卖、下单或荐股建议；可以协助整理和筛选明确指标。' };
  if (promise.test(text)) return { blocked: true, reason: '不能提供收益承诺或确定性预测；可以基于数据做透明、可复核的条件筛选。' };
  return { blocked: false };
}

function unsupportedFor(text) {
  const unsupported = unsupportedTerms(text);
  // Chinese “或” is not required to be surrounded by whitespace; never infer
  // an AND by dropping the alternative branch.
  if (/或/.test(text) || /还是/.test(text) || /\bor\b/i.test(text)) unsupported.push('OR 条件');
  if (/(不是|不属于|排除|剔除|不要|不能|非)/.test(text)) unsupported.push('复杂否定');
  if (/(行业|板块|赛道|概念|金融|科技|医药|新能源|白酒)/.test(text)) unsupported.push('行业/板块条件');
  // A metric mention separated from its own operator is incomplete; do not
  // silently retain a later metric's valid condition as a partial parse.
  if (/(市盈率|PE)\s*[，,、；;]/i.test(text)) unsupported.push('未完成的指标条件');
  return [...new Set(unsupported)];
}

function parseExplicit(text) {
  const conditions = [];
  const seenSpans = new Set();
  for (const [metric, terms] of metricTerms) {
    for (const term of terms) {
      let from = 0;
      while (from < text.length) {
        const index = text.toLowerCase().indexOf(term.toLowerCase(), from);
        if (index < 0) break;
        const afterMetric = index + term.length;
        let found = null;
        // Permit only punctuation, spaces, or an optional TTM/MRQ suffix
        // between the metric token and its operator; never borrow an operator
        // belonging to a following metric.
        const tail = text.slice(afterMetric).match(/^(?:\s*(?:[（(]\s*(?:TTM|MRQ|同比)\s*[）)]|TTM|MRQ|同比)?\s*)/i);
        const between = text.slice(afterMetric, afterMetric + (tail?.[0]?.length ?? 0));
        if (/[，,、；;]/.test(between) || /市盈率|市净率|ROE|市值|股息率/i.test(between)) { from = afterMetric; continue; }
        const opStart = afterMetric + (tail?.[0]?.length ?? 0);
        for (const [op, words] of opWords) {
          for (const word of words) {
            if (text.slice(opStart, opStart + word.length).toLowerCase() !== word.toLowerCase()) continue;
            const number = numberFrom(text, opStart + word.length);
            if (number) { found = { op, number, end: opStart + word.length + number.length }; break; }
          }
          if (found) break;
        }
        if (found) {
          const span = `${index}:${found.end}`;
          const nested = [...seenSpans].some(s => { const [a,b] = s.split(':').map(Number); return index >= a && found.end <= b; });
          if (!nested && !seenSpans.has(span)) {
            conditions.push(makeCondition(metric, found.op, found.number.value, text.slice(index, found.end), conditions.length));
            seenSpans.add(span);
          }
        }
        from = afterMetric;
      }
    }
  }
  return conditions;
}

/** Conservative parser: unsupported/fuzzy intent is surfaced, never silently discarded. */
export function interpretRules(input) {
  const text = normalizeText(input);
  const compliance = checkCompliance(text);
  const unsupported = unsupportedFor(text);
  const conditions = compliance.blocked || unsupported.length ? [] : parseExplicit(text);
  const clarifications = [];
  const warnings = ['规则解析模式，未调用大模型。'];
  if (/(经营改善|业绩改善|基本面改善)/.test(text)) {
    conditions.push(makeCondition('revenue_yoy_annual', 'gt', 0, '经营改善建议：最近完整年度营收同比大于0%（需确认年度口径）', conditions.length, true));
    conditions.push(makeCondition('profit_yoy_annual', 'gt', 0, '经营改善建议：最近完整年度归母净利润同比大于0%（需确认年度口径）', conditions.length, true));
    clarifications.push({ id: 'improvement-confirm', question: '用最近完整年度营收和归母净利润同比均大于0%衡量经营改善？', explanation: '采用已披露的两个完整年度，不代表最近季度或经营拐点。你可以修改指标和阈值。' });
    warnings.push('“经营改善”已生成可编辑草稿条件，需用户确认，不是事实判断。');
  }
  if (/(估值合理|估值便宜|估值低)/.test(text)) {
    conditions.push(makeCondition('pe_ttm', 'gt', 0, '估值合理示例：PE大于0（可调整草稿，需确认）', conditions.length, true));
    conditions.push(makeCondition('pe_ttm', 'lte', 25, '估值合理示例：PE不高于25（可调整草稿，需确认）', conditions.length, true));
    clarifications.push({ id: 'valuation-confirm', question: '是否采用 0<PE≤25 作为“估值合理”的可编辑草稿？', explanation: '这是可调整示例，不是事实判断；PE≤25没有普适含义，负PE不当作低估。' });
    warnings.push('“估值合理”已生成可编辑草稿条件，需用户确认；负PE不当作低估。');
  }
  if (/(走势稳定|走势相对稳定|股价稳定|波动稳定)/.test(text)) {
    conditions.push(makeCondition('volatility_20d', 'lte', 30, '走势稳定示例：20日年化波动率不高于30%（可调整草稿，需确认）', conditions.length, true));
    clarifications.push({ id: 'stability-confirm', question: '是否采用 20日年化波动率≤30% 作为“走势稳定”的可编辑草稿？', explanation: '这是可调整示例，不是事实判断；请确认观察窗口和阈值。' });
    warnings.push('“走势稳定”已生成可编辑草稿条件，需用户确认，不是事实判断。');
  }
  if (!text) warnings.push('请输入筛选描述。');
  if (!conditions.length && !clarifications.length && !unsupported.length && !compliance.blocked && text) {
    clarifications.push({ id: 'threshold-confirm', question: '请提供指标、比较关系和明确数字阈值。', explanation: '当前规则解析器不会猜测未明确的条件。' });
  }
  const blocked = compliance.blocked || unsupported.length > 0;
  const blockReason = compliance.blocked ? compliance.reason : unsupported.length ? `暂不支持${unsupported.join('、')}；请改为仅含明确指标的 AND 条件。` : undefined;
  return {
    mode: 'rules',
    needsConfirmation: clarifications.length > 0 || blocked,
    summary: conditions.length ? `识别到 ${conditions.length} 个明确条件（仅 AND）` : '未生成可直接执行的明确条件',
    conditions,
    clarifications,
    warnings,
    unsupported,
    blocked,
    ...(blockReason ? { blockReason } : {}),
  };
}

export { getMetric };
