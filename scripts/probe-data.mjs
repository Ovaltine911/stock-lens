#!/usr/bin/env node
/** Bounded, credential-free probe. Never prints credentials. */
const requests = [
  ['Fuyao valuations without key', 'https://fuyao.aicubes.cn/api/a-share/valuations/snapshot?thscodes=600519.SH', {}],
  ['Eastmoney quote', 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f116,f162,f167', {}],
  ['Eastmoney 20-day+ K line', (() => { const end = new Date(); const start = new Date(end.getTime() - 100 * 86400000); const fmt = (d) => d.toISOString().slice(0, 10).replaceAll('-', ''); return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&beg=${fmt(start)}&end=${fmt(end)}`; })(), {}],
];
const controllerTimeout = (promise, ms = 8000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
for (const [label, url, options] of requests) {
  const started = Date.now();
  try {
    const response = await controllerTimeout(fetch(url, options));
    const text = await response.text();
    let body = null; try { body = JSON.parse(text); } catch { /* Tencent/plain or malformed JSON */ }
    const business = body?.code ?? body?.rc ?? 'n/a';
    const rows = body?.data?.klines?.length ?? body?.data?.item?.length ?? 'n/a';
    console.log(JSON.stringify({ label, url, httpStatus: response.status, businessCode: business, rows, bytes: text.length, elapsedMs: Date.now() - started }));
  } catch (error) {
    console.log(JSON.stringify({ label, url, status: 'error', message: error.message, elapsedMs: Date.now() - started }));
  }
}
console.log(JSON.stringify({ conclusion: 'Fuyao requires X-api-key; public Eastmoney endpoints were probed without credentials. Probe output is availability evidence, not stock data.' }));
