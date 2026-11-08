import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretIntent, validateModelIntent } from '../lib/llm.mjs';
import { validateConditions, screenSnapshot } from '../lib/engine.mjs';
import { createDemoSnapshot } from '../lib/data.mjs';

test('明确条件无需用户再次确认，模糊输入必须确认年度假设', async () => {
  const explicit = await interpretIntent('市盈率大于0且市盈率不高于25，净资产收益率大于10%', { env: {} });
  assert.equal(explicit.needsConfirmation, false);
  assert.equal(validateConditions(explicit.conditions).valid, true);
  const fuzzy = await interpretIntent('经营改善、估值合理、走势相对稳定', { env: {} });
  assert.equal(fuzzy.needsConfirmation, true);
  assert.equal(fuzzy.clarifications.length, 3);
  assert.ok(fuzzy.conditions.some(c => c.metric === 'revenue_yoy_annual'));
  assert.ok(fuzzy.clarifications.some(c => c.explanation.includes('年度')));
});
test('明确季度同比不会自动改成年度条件', async () => {
  const intent = await interpretIntent('营收同比大于10%', { env: {} });
  assert.equal(intent.conditions[0].metric, 'revenue_yoy');
  assert.equal(intent.conditions.some(c => c.metric.endsWith('_annual')), false);
});
test('单次数据快照支持年度条件与后续阈值差异', async () => {
  const intent = await interpretIntent('经营改善、估值合理、走势稳定', { env: {} });
  const snapshot = createDemoSnapshot();
  const first = screenSnapshot(snapshot, intent.conditions);
  assert.equal(first.counts.total, 12);
  assert.ok(first.counts.pass > 0);
  const changed = intent.conditions.map(c => c.metric === 'pe_ttm' && c.op === 'lte' ? { ...c, value: 40 } : c);
  const second = screenSnapshot(snapshot, changed, intent.conditions);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.diff.removed.length, 0);
});
test('模型对未知要求必须原文锚定并阻止自动执行', () => {
  const result = validateModelIntent({ summary: '草稿', conditions: [{ id:'a',metric:'pe_ttm',op:'lt',value:20,origin:'PE小于20' }],clarifications:[],warnings:[],unsupported:['股息率大于5%'],blocked:false }, 'PE小于20且股息率大于5%');
  assert.equal(result.needsConfirmation, true);
  assert.deepEqual(result.unsupported, ['股息率大于5%']);
});
