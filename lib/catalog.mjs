/**
 * The deliberately small, explicit metric catalogue used by the screening engine.
 * Values and evidence are supplied by a snapshot adapter; this module has no data.
 */
export const METRICS = Object.freeze([
  Object.freeze({ id: 'pe_ttm', label: '市盈率（TTM）', unit: '倍', description: '过去十二个月净利润对应的市盈率；亏损公司可能为负值，不能据此宣称低估', min: null, max: null, defaultOp: 'lt', defaultValue: 20, period: 'TTM' }),
  Object.freeze({ id: 'pb_mrq', label: '市净率（MRQ）', unit: '倍', description: '最近报告期市净率', min: 0, max: null, defaultOp: 'lt', defaultValue: 3, period: 'MRQ' }),
  Object.freeze({ id: 'revenue_yoy', label: '营收同比', unit: '%', description: '营业收入报告期累计同比增速', min: null, max: null, defaultOp: 'gt', defaultValue: 0, period: 'YoY' }),
  Object.freeze({ id: 'profit_yoy', label: '利润同比', unit: '%', description: '净利润报告期累计同比增速', min: null, max: null, defaultOp: 'gt', defaultValue: 0, period: 'YoY' }),
  Object.freeze({ id: 'roe', label: 'ROE', unit: '%', description: '报告期加权平均净资产收益率（ROE）', min: null, max: null, defaultOp: 'gt', defaultValue: 10, period: '报告期' }),
  Object.freeze({ id: 'volatility_20d', label: '20日波动率', unit: '%', description: '近20个交易日对数收益率样本标准差×√252×100%的年化波动率', min: 0, max: null, defaultOp: 'lte', defaultValue: 30, period: '20D年化' }),
  Object.freeze({ id: 'return_20d', label: '20日收益率', unit: '%', description: '近20个交易日价格变化；不构成收益承诺', min: null, max: null, defaultOp: 'gt', defaultValue: 0, period: '20D' }),
  Object.freeze({ id: 'market_cap', label: '总市值', unit: '亿元', description: '总市值', min: 0, max: null, defaultOp: 'gt', defaultValue: 100, period: '当日' }),
]);

export const UNIVERSE = Object.freeze({
  id: 'research-12',
  label: '12 家 A 股观察样本',
  description: '用于产品研究的有限观察样本；演示数据为合成数据，不代表真实公司或报价。',
});

export function getMetric(id) {
  return METRICS.find((metric) => metric.id === id) ?? null;
}
