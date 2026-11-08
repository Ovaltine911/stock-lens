import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretRules, checkCompliance } from '../lib/intent.mjs';

test('explicit threshold parsing is rules-only and visible', () => {
  const result = interpretRules('ROE 不低于 10，市值大于 100');
  assert.equal(result.mode, 'rules');
  assert.match(result.warnings[0], /未调用大模型/);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.conditions.map(({ metric, op, value }) => ({ metric, op, value })), [
    { metric: 'roe', op: 'gte', value: 10 }, { metric: 'market_cap', op: 'gt', value: 100 },
  ]);
});

test('explicit PE threshold preserves user meaning and does not inject a guard', () => {
  const result = interpretRules('市盈率低于 20');
  assert.equal(result.blocked, false);
  assert.deepEqual(result.conditions.map((item) => [item.metric, item.op, item.value]), [['pe_ttm', 'lt', 20]]);
  assert.doesNotMatch(result.warnings.join(' '), /已加入 PE/);
});

test('fuzzy suggestions create editable draft conditions requiring confirmation', () => {
  const result = interpretRules('经营改善、估值合理、走势稳定');
  assert.equal(result.conditions.length, 5);
  assert.equal(result.blocked, false);
  assert.equal(result.clarifications.length, 3);
  assert.ok(result.conditions.every((item) => item.draft && item.requiresConfirmation));
  assert.deepEqual(result.conditions.map(({ metric, op, value }) => ({ metric, op, value })), [
    { metric: 'revenue_yoy_annual', op: 'gt', value: 0 }, { metric: 'profit_yoy_annual', op: 'gt', value: 0 },
    { metric: 'pe_ttm', op: 'gt', value: 0 }, { metric: 'pe_ttm', op: 'lte', value: 25 },
    { metric: 'volatility_20d', op: 'lte', value: 30 },
  ]);
  assert.match(result.warnings.join(' '), /可编辑草稿/);
});

test('明确年度增长不被嵌套解析成季度同比', () => {
  const r = interpretRules('年度营收同比大于0且年度归母净利润同比大于10%');
  assert.equal(r.needsConfirmation, false);
  assert.deepEqual(r.conditions.map(c => c.metric), ['revenue_yoy_annual', 'profit_yoy_annual']);
});

test('relative stability wording creates annualized volatility draft', () => {
  const result = interpretRules('走势相对稳定');
  assert.equal(result.blocked, false);
  assert.deepEqual(result.conditions.map(({ metric, op, value }) => ({ metric, op, value })), [{ metric: 'volatility_20d', op: 'lte', value: 30 }]);
  assert.equal(result.conditions[0].draft, true);
  assert.equal(result.conditions[0].requiresConfirmation, true);
  assert.match(result.clarifications[0].question, /年化波动率/);
});

test('unsupported dividend and unlisted time windows are blocked', () => {
  for (const text of ['PE小于20且股息率大于5%', '近5日涨幅小于3']) {
    const result = interpretRules(text);
    assert.equal(result.blocked, true);
    assert.equal(result.conditions.length, 0);
    assert.ok(result.unsupported.length > 0);
  }
});

test('parser does not borrow operator across adjacent metrics and handles TTM suffix', () => {
  assert.equal(interpretRules('市盈率，市净率小于3').conditions.length, 0);
  const result = interpretRules('市盈率（TTM）小于20');
  assert.deepEqual(result.conditions.map(({ metric, op, value }) => ({ metric, op, value })), [{ metric: 'pe_ttm', op: 'lt', value: 20 }]);
});

test('unsupported OR, complex negation, and industry are blocked, never discarded', () => {
  for (const text of ['ROE 大于 10 或市值大于 100', '不是高波动的股票', '新能源行业 ROE 大于 10']) {
    const result = interpretRules(text);
    assert.equal(result.blocked, true);
    assert.ok(result.unsupported.length > 0);
    assert.match(result.blockReason, /支持/);
    assert.equal(result.conditions.length, 0);
  }
});

test('compliance blocks direct transaction and promises, not general screening', () => {
  assert.equal(checkCompliance('帮我买入低估股票').blocked, true);
  assert.equal(checkCompliance('保证明天涨').blocked, true);
  assert.equal(checkCompliance('筛选 ROE 大于 10').blocked, false);
  assert.equal(interpretRules('筛选 ROE 大于 10').blocked, false);
});

test('malformed or hostile input does not throw or get executed', () => {
  for (const value of [null, undefined, 123, '<script>alert(1)</script>', 'ROE 大于 NaN']) {
    assert.doesNotThrow(() => interpretRules(value));
  }
  assert.equal(interpretRules('<script>alert(1)</script>').conditions.length, 0);
});
