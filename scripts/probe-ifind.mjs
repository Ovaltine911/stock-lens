#!/usr/bin/env node
/** Explicit opt-in probe. Never loads a workspace config implicitly or logs credentials. */
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';

// Official call() internally sends initialize/notify/list. Pace those requests
// too, without changing the installed module or touching its configuration.
function paceOfficialHttp() {
  const original = https.request;
  let queue = Promise.resolve(); let lastStart = 0;
  https.request = function (options, callback) {
    const proxy = new EventEmitter(); const chunks = []; let request; let destroyed = false;
    proxy.write = chunk => { chunks.push(chunk); return true; };
    proxy.destroy = () => { destroyed = true; request?.destroy(); return proxy; };
    proxy.end = () => {
      queue = queue.catch(() => {}).then(async () => {
        await sleep(Math.max(0, lastStart + 600 - Date.now()));
        if (destroyed) return;
        lastStart = Date.now();
        await new Promise(resolveRequest => {
          request = original.call(https, options, response => {
            response.once('end', resolveRequest); response.once('close', resolveRequest);
            callback(response);
          });
          request.once('error', error => { proxy.emit('error', error); resolveRequest(); });
          request.once('timeout', () => { proxy.emit('timeout'); resolveRequest(); });
          for (const chunk of chunks) request.write(chunk);
          request.end();
        });
      });
      return proxy;
    };
    return proxy;
  };
  return () => { https.request = original; };
}

const financial = { tool: 'get_stock_financials', query: '600519.SH、000858.SZ在2026-09-30报告期的累计营业收入同比增长率、累计归属于母公司股东的净利润同比增长率、报告期加权平均净资产收益率ROE。请返回证券代码、指标名称、单位和报告期，不要使用单季度或年化ROE。' };
const valuation = { tool: 'get_stock_performance', query: '600519.SH、000858.SZ在2026-11-06的市盈率PE(TTM)、市净率PB(MRQ)。请返回证券代码、指标名称、单位和实际交易日期，不要使用动态PE或年度PB替代。' };
const preciseFinancial = { tool: 'get_stock_financials', query: '600519.SH、000858.SZ，报告期2026年三季报（2026-09-30）：年初至报告期末累计营业收入同比增长率、年初至报告期末累计归属母公司股东净利润同比增长率、该报告期加权平均净资产收益率（非年化）。' };
const preciseValuation = { tool: 'get_stock_performance', query: '600519.SH、000858.SZ，交易日期2026年11月6日：市盈率(PE,TTM)、市净率(PB,MRQ)。' };

// Never print arbitrary upstream strings, including errors which could reflect a key.
const allowedKeys = new Set(['result', 'content', 'type', 'text', 'jsonrpc', 'id', 'code', 'msg', 'subCode', 'subMsg', 'data', 'answer', 'indicators_params', '报告期', '交易日期', 'TTM基准日', '营业总收入(同比增长率)', '营业收入(同比增长率)', '净利润(同比增长率)', '归属母公司股东的净利润(同比增长率)', '净资产收益率ROE(加权,公布值)', '净资产收益率ROE(摊薄,公布值)', '市盈率(PE,TTM)', '市净率（PB，MRQ）']);
function shape(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (value === null) return null;
  if (Array.isArray(value)) return { length: value.length, sample: value.slice(0, 2).map(v => shape(v, depth + 1)) };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v], i) => [allowedKeys.has(k) ? k : `[other-key-${i}]`, shape(v, depth + 1)]));
  if (typeof value === 'string') {
    try { return { encodedJson: shape(JSON.parse(value), depth + 1) }; } catch { /* text, not JSON */ }
    if (['success', 'text', '最新', '最新一期(MRQ)', '报表公告日期'].includes(value)) return value;
    return { type: 'string', length: value.length, markdownTable: value.trim().startsWith('|') };
  }
  return typeof value;
}

async function main() {
  const args = process.argv.slice(2);
  const officialIndex = args.indexOf('--official');
  if (officialIndex < 0 || !args[officialIndex + 1]) {
    console.log('显式授权探测：node scripts/probe-ifind.mjs --official /path/to/ifind-finance-data [--financial-only|--valuation-only]。将消耗1–2次真实工具查询；不输出凭证或完整数据。');
    return;
  }
  const require = createRequire(import.meta.url);
  const { call } = require(resolve(args[officialIndex + 1], 'scripts/call-node.js'));
  const restoreHttp = paceOfficialHttp();
  const pair = args.includes('--precise') ? [preciseFinancial, preciseValuation] : [financial, valuation];
  const queries = args.includes('--financial-only') ? [pair[0]] : args.includes('--valuation-only') ? [pair[1]] : pair;
  let toolRequests = 0;
  for (const request of queries) {
    await sleep(600);
    toolRequests++;
    try {
      const result = await call('stock', request.tool, { query: request.query });
      if (process.env.IFIND_PROBE_SAVE_RAW === 'true' && process.env.PICODE_ARTIFACT_DIR) {
        const directory = join(process.env.PICODE_ARTIFACT_DIR, 'ifind-private');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, `${Date.now()}-${request.tool}.json`), JSON.stringify(result), { mode: 0o600 });
      }
      console.log(JSON.stringify({ tool: request.tool, parameters: { query: request.query }, ok: result.ok, httpStatus: result.status_code, shape: shape(result.data ?? result.raw ?? null) }, null, 2));
      if (!result.ok) { process.exitCode = 1; break; }
      let envelope;
      try { envelope = JSON.parse(result.data?.result?.content?.[0]?.text); } catch { /* handled below */ }
      if (envelope?.code !== 1 || envelope?.msg !== 'success') { process.exitCode = 1; break; }
    } catch { console.log(JSON.stringify({ tool: request.tool, ok: false, error: '调用失败；为保护凭证不输出上游错误文本，已停止后续请求。' })); process.exitCode = 1; break; }
  }
  restoreHttp();
  console.log(JSON.stringify({ actualToolRequests: toolRequests, concurrency: 1, credentialContentsPrinted: false }));
}
main().catch(() => { console.error('探测初始化失败；请检查显式提供的官方技能路径与私有配置。未输出原始错误。'); process.exitCode = 1; });
