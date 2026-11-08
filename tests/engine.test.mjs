import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConditions, screenSnapshot } from '../lib/engine.mjs';

const condition = (id, metric = 'roe', op = 'gte', value = 10) => ({ id, metric, op, value, origin: `${metric}${op}${value}` });
const evidence = (value, status = 'ok', metric = 'roe') => ({ value, source: 'test', sourceUrl: 'https://example.test', field: metric === 'roe' ? 'f167' : `raw_${metric}`, asOf: '2025-01-01', period: metric === 'roe' ? '报告期' : ({ pb_mrq: 'MRQ', pe_ttm: 'TTM', volatility_20d: '20D年化' }[metric] ?? 'FY'), unit: metric === 'pb_mrq' || metric === 'pe_ttm' ? '倍' : '%', status });
const snapshot = {
  id: 'snap-1', mode: 'demo', source: 'synthetic test', asOf: '2025-01-01', fetchedAt: '2025-01-01T00:00:00Z',
  universe: { id: 'research-12', label: 'test', description: 'test' }, warnings: [], stocks: [
    { code: 'A', name: 'Alpha', industry: 'test', metrics: { roe: evidence(10) } },
    { code: 'B', name: 'Beta', industry: 'test', metrics: { roe: evidence(9) } },
    { code: 'C', name: 'Gamma', industry: 'test', metrics: { roe: evidence(null, 'missing') } },
    { code: 'D', name: 'Delta', industry: 'test', metrics: { roe: evidence(10, 'stale') } },
  ],
};

test('catalog condition validates explicit finite values', () => {
  assert.equal(validateConditions([condition('x')]).valid, true);
  assert.equal(validateConditions([]).valid, false);
  assert.equal(validateConditions([condition('x', 'nope')]).valid, false);
  assert.equal(validateConditions([condition('x', 'roe', 'gte', NaN)]).valid, false);
});

test('strict and inclusive boundaries detect only impossible intersections', () => {
  assert.equal(validateConditions([condition('a', 'roe', 'gt', 10), condition('b', 'roe', 'lte', 10)]).conflicts.length, 1);
  assert.equal(validateConditions([condition('a', 'roe', 'gte', 10), condition('b', 'roe', 'gt', 10), condition('c', 'roe', 'lte', 10)]).conflicts.length, 1);
  assert.equal(validateConditions([condition('a', 'roe', 'gte', 10), condition('b', 'roe', 'lte', 10)]).valid, true);
  assert.equal(validateConditions([condition('a', 'roe', 'gt', 10), condition('b', 'roe', 'lt', 20)]).valid, true);
  assert.equal(validateConditions([condition('a', 'roe', 'eq', 10), condition('b', 'roe', 'gte', 10)]).valid, true);
  assert.equal(validateConditions([condition('a', 'roe', 'eq', 10), condition('b', 'roe', 'gt', 10)]).conflicts.length, 1);
});

test('screen uses AND three-valued logic and fail precedes unknown', () => {
  const result = screenSnapshot(snapshot, [condition('c')]);
  assert.deepEqual(result.counts, { pass: 1, fail: 1, unknown: 2, total: 4 });
  assert.equal(result.rows.find((row) => row.code === 'A').status, 'pass');
  assert.equal(result.rows.find((row) => row.code === 'B').status, 'fail');
  assert.equal(result.rows.find((row) => row.code === 'C').status, 'unknown');
  assert.equal(result.rows.find((row) => row.code === 'D').status, 'unknown');
  assert.match(result.warnings.join(' '), /未知/);
});

test('one failed check wins over another unknown check', () => {
  const altered = structuredClone(snapshot);
  altered.stocks[1].metrics.roe = evidence(9);
  altered.stocks[1].metrics.pb_mrq = evidence(null, 'missing');
  const result = screenSnapshot(altered, [condition('r'), condition('p', 'pb_mrq', 'lt', 3)]);
  const row = result.rows.find((item) => item.code === 'B');
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.checks.map((check) => check.result), ['fail', 'unknown']);
});

test('source field names may be provider-specific, but date period and unit must match', () => {
  const result = screenSnapshot(snapshot, [condition('c')]);
  assert.equal(result.rows[0].status, 'pass');
  const altered = structuredClone(snapshot);
  altered.stocks[0].metrics.roe = { ...evidence(99), asOf: null };
  assert.equal(screenSnapshot(altered, [condition('c')]).rows[0].status, 'unknown');
  altered.stocks[0].metrics.roe = { ...evidence(99), period: 'TTM' };
  assert.equal(screenSnapshot(altered, [condition('c')]).rows[0].status, 'unknown');
});

test('same snapshot baseline diff compares pass sets', () => {
  const result = screenSnapshot(snapshot, [condition('c', 'roe', 'gte', 10)], [condition('c', 'roe', 'gt', 9)]);
  assert.deepEqual(result.diff, { added: [], removed: [], unchanged: ['A'], baselineCount: 1, currentCount: 1 });
  const changed = screenSnapshot(snapshot, [condition('c', 'roe', 'gte', 9)], [condition('c', 'roe', 'gte', 10)]);
  assert.deepEqual(changed.diff, { added: ['B'], removed: [], unchanged: ['A'], baselineCount: 1, currentCount: 2 });
});

test('conflict throws structured error', () => {
  assert.throws(() => screenSnapshot(snapshot, [condition('a', 'roe', 'gt', 10), condition('b', 'roe', 'lt', 10)]), (error) => error.code === 'CONFLICT' && error.conflicts.length === 1);
});
