import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS, UNIVERSE } from './lib/catalog.mjs';
import { validateConditions, screenSnapshot } from './lib/engine.mjs';
import { loadSnapshot, dataCapabilities } from './lib/data.mjs';
import { interpretIntent, modelCapabilities } from './lib/llm.mjs';
import { withLocalModelConfig } from './lib/local-config.mjs';
import { ifindCapabilities } from './lib/ifind.mjs';
import { protectReview } from './lib/review-access.mjs';
import { createSnapshotCache } from './lib/snapshot-cache.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(ROOT, 'public');
const MAX_BODY = 32_768;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function loadLocalEnv(file = path.join(ROOT, '.env'), env = process.env) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
}
function apiError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, safe: true, extra });
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
async function parseBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw apiError(415, 'CONTENT_TYPE', '请求格式不受支持，请刷新页面后重试。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw apiError(413, 'TOO_LARGE', '请求内容过长，请减少筛选条件或描述。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch { throw apiError(400, 'INVALID_JSON', '请求内容格式异常，请刷新页面后重试。'); }
}
function checkOrigin(req, env) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw apiError(403, 'ORIGIN', '请从产品页面发起此操作。');
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const allowed = env.APP_ORIGIN ? new URL(env.APP_ORIGIN) : new URL(`http://${req.headers.host}`);
    const actual = new URL(origin);
    if (actual.host !== allowed.host || !['http:', 'https:'].includes(actual.protocol) || (env.APP_ORIGIN && actual.origin !== allowed.origin)) throw new Error('origin');
  } catch { throw apiError(403, 'ORIGIN', '请求来源不匹配，请从产品页面重新操作。'); }
}
function validateRequestConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length > 16) throw apiError(422, 'INVALID_CONDITIONS', '请设置 1 到 16 个有效条件。');
  const normalized = conditions.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || c.id.length > 80 || typeof c.metric !== 'string' || c.metric.length > 40 || typeof c.op !== 'string' || typeof c.origin !== 'string' || c.origin.length > 400) {
      throw apiError(422, 'INVALID_CONDITIONS', `第 ${i + 1} 条条件格式无效，请删除后重新添加。`);
    }
    return { id: c.id, metric: c.metric, op: c.op, value: c.value, origin: c.origin };
  });
  const validation = validateConditions(normalized);
  if (validation.errors.length) throw apiError(422, 'INVALID_CONDITIONS', '条件中的指标、数值或比较关系无效，请检查后重试。');
  if (validation.conflicts.length) throw apiError(422, 'CONFLICT', '条件之间存在冲突，请调整后再筛选。', { conflicts: validation.conflicts });
  return normalized;
}

export function createApp({ env = process.env, snapshotLoader = loadSnapshot, interpreter = interpretIntent, now = () => Date.now(), cacheTtlMs = 30 * 60_000, rateLimit = 60, localModelConfig = false } = {}) {
  const runtimeEnv = () => localModelConfig ? withLocalModelConfig(env) : env;
  const snapshots = new Map();
  const requests = new Map();
  const autoSnapshotCache = createSnapshotCache({ load: async mode => ({ ...await snapshotLoader(mode, { env }), id: randomUUID() }), now, ttlMs: 15 * 60_000 });
  let modelInFlight = 0;
  let dataInFlight = 0;
  const cleanup = () => {
    const t = now();
    for (const [id, item] of snapshots) if (t - item.createdAt > cacheTtlMs) snapshots.delete(id);
    for (const [id, item] of requests) if (t - item.start > 60_000) requests.delete(id);
  };
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (!protectReview(req, res, runtimeEnv(), route)) return;
      if (route.startsWith('/api/')) {
        cleanup();
        if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, model: modelCapabilities(runtimeEnv()), data: { ...dataCapabilities(env), ...ifindCapabilities(env), autoAvailable: Boolean(env.FUYAO_API_KEY || env.FUYAO_CONFIG_PATH || ifindCapabilities(env).ifindConfigured) }, version: '0.2.0' });
        if (req.method === 'GET' && route === '/api/catalog') return json(res, 200, { metrics: METRICS, universe: UNIVERSE, defaultMode: 'auto', snapshotTtlMinutes: 15 });
        if (req.method !== 'POST') throw apiError(405, 'METHOD', '不支持此请求方式。');
        if (!['/api/interpret', '/api/snapshot', '/api/screen'].includes(route)) throw apiError(404, 'NOT_FOUND', '请求的功能不存在。');
        checkOrigin(req, env);
        // Deliberately do not trust arbitrary forwarded IP headers. Shared proxy
        // users may share this bucket; production should add edge rate limiting.
        const address = req.socket.remoteAddress || 'unknown';
        const bucket = requests.get(address) || { start: now(), count: 0 };
        bucket.count += 1;
        if (requests.size > 5000) requests.delete(requests.keys().next().value);
        requests.set(address, bucket);
        if (bucket.count > rateLimit) throw apiError(429, 'RATE_LIMIT', '操作过于频繁，请稍等一分钟后重试。');
        const body = await parseBody(req);
        if (route === '/api/interpret') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) throw apiError(400, 'INVALID_INPUT', '请输入 1 到 2000 字的筛选意图。');
          if (modelInFlight >= 3) throw apiError(429, 'BUSY', '解析服务正忙，请稍后再试。');
          modelInFlight++;
          try {
            const intent = await interpreter(body.text, { env: runtimeEnv() });
            return json(res, 200, intent);
          } finally { modelInFlight--; }
        }
        if (route === '/api/snapshot') {
          if (!['auto', 'demo', 'public', 'fuyao', 'ifind'].includes(body.mode)) throw apiError(400, 'INVALID_MODE', '请选择明确的数据来源。');
          if (dataInFlight >= 2) throw apiError(429, 'BUSY', '数据服务正忙，请稍后再试。');
          dataInFlight++;
          try {
            const snapshot = body.mode === 'auto' ? await autoSnapshotCache.get('auto') : await snapshotLoader(body.mode, { env });
            if (!snapshot || !Array.isArray(snapshot.stocks) || !snapshot.stocks.length || snapshot.stocks.length > 100 || snapshot.mode !== body.mode) throw apiError(502, 'DATA_SCHEMA', '数据源返回内容异常，未生成正常筛选结果。');
            // Opaque random IDs avoid collisions and prevent request-time mutations.
            // Reuse a still-live cached snapshot ID; each new load gets an opaque ID.
            if (body.mode !== 'auto') snapshot.id = randomUUID();
            if (!snapshots.has(snapshot.id)) snapshots.set(snapshot.id, { snapshot: structuredClone(snapshot), createdAt: now() });
            while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
            return json(res, 200, snapshot);
          } finally { dataInFlight--; }
        }
        if (route === '/api/screen') {
          if (body.confirmed !== true) throw apiError(422, 'CONFIRM_REQUIRED', '请先确认筛选条件及口径。');
          const conditions = validateRequestConditions(body.conditions);
          const baseline = body.baselineConditions === undefined ? undefined : validateRequestConditions(body.baselineConditions);
          if (typeof body.snapshotId !== 'string') throw apiError(400, 'SNAPSHOT_REQUIRED', '请先获取数据快照。');
          const cached = snapshots.get(body.snapshotId);
          if (!cached) throw apiError(410, 'SNAPSHOT_EXPIRED', '数据快照已失效，请重新获取数据。历史保存结果仍可查看。');
          return json(res, 200, screenSnapshot(cached.snapshot, conditions, baseline));
        }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw apiError(405, 'METHOD', '不支持此请求方式。');
      let pathname;
      try { pathname = decodeURIComponent(route); } catch { throw apiError(400, 'BAD_PATH', '访问地址格式无效。'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.') && p.length)) throw apiError(404, 'NOT_FOUND', '页面不存在。');
      const filename = path.resolve(STATIC_ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(STATIC_ROOT + path.sep)) throw apiError(404, 'NOT_FOUND', '页面不存在。');
      let content;
      try { content = await readFile(filename); } catch { throw apiError(404, 'NOT_FOUND', '页面不存在。'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) return res.end();
      const domainError = typeof error.code === 'string' && /^(MODEL_|DATA_|FUYAO_|IFIND_|PUBLIC_|INVALID_|NO_|SOURCE_|CONFIG_|RATE_|TIMEOUT)/.test(error.code);
      const safe = error.safe || domainError;
      const status = safe && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : domainError ? 503 : 500;
      const message = safe && typeof error.message === 'string' && !/Bearer\s|api[_-]?key\s*[:=]/i.test(error.message) ? error.message : '服务暂时不可用，未生成筛选结论。请稍后重试。';
      json(res, status, { error: { code: safe ? error.code : 'INTERNAL', message }, ...(error.extra || {}) });
    }
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  loadLocalEnv();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  createApp({ localModelConfig: true }).listen(port, host, () => console.log(`选股有据已启动：http://${host}:${port}`));
}
