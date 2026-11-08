import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LOCAL_MODEL_PATH, withLocalModelConfig } from '../lib/local-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'setup', 'index.html');
const SCRIPT = path.join(HERE, 'setup', 'setup.js');
const TOKENS = path.join(HERE, '..', 'public', 'tokens.css');
function fail(status, message) { return Object.assign(new Error(message), { status, safe: true }); }
function eq(a, b) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

export async function validateDeepSeekKey(key, { fetchImpl = fetch } = {}) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{20,500}$/.test(key.trim())) throw fail(400, '密钥格式不正确，请完整复制开放平台的密钥。');
  const cleaned = key.trim();
  let payload;
  try {
    const response = await fetchImpl('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${cleaned}` },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw fail(401, 'DeepSeek 未接受这个密钥，请检查是否复制完整或已被撤销。');
    if (!response.ok) throw fail(502, 'DeepSeek 服务暂时不可用，配置尚未保存，请稍后重试。');
    payload = await response.json();
  } catch (error) {
    if (error.safe) throw error;
    throw fail(502, '无法连接 DeepSeek 验证密钥，配置尚未保存，请检查网络后重试。');
  }
  const names = Array.isArray(payload?.data) ? payload.data.map(model => model?.id).filter(id => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(id)) : [];
  const selected = ['deepseek-flash', 'deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner'].find(id => names.includes(id));
  if (!selected) throw fail(422, '密钥可以连接，但没有识别到本产品支持的模型。请联系开发者核对模型列表。');
  return { LLM_API_KEY: cleaned, LLM_MODEL: selected, LLM_BASE_URL: 'https://api.deepseek.com' };
}

export function createSetupServer({ configPath = LOCAL_MODEL_PATH, validate = validateDeepSeekKey } = {}) {
  const csrf = randomBytes(32).toString('hex');
  let busy = false;
  const attempts = [];
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const origin = `http://127.0.0.1:${server.address()?.port}`;
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '配置入口只接受本机页面发起的请求。');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(await readFile(PAGE));
      }
      if (req.method === 'GET' && ['/setup.js', '/tokens.css'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        return res.end(await readFile(url.pathname.endsWith('.js') ? SCRIPT : TOKENS));
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const configured = withLocalModelConfig({}, configPath);
        return json(200, { configured: Boolean(configured.LLM_API_KEY), csrf, model: configured.LLM_MODEL || null });
      }
      if (req.method !== 'POST' || url.pathname !== '/configure') throw fail(404, '配置入口不存在。');
      if (req.headers.origin !== origin || !eq(req.headers['x-setup-csrf'], csrf)) throw fail(403, '配置请求已失效，请刷新本机页面后重试。');
      if (req.headers['content-type'] !== 'application/json') throw fail(415, '配置请求格式不正确。');
      const now = Date.now();
      while (attempts.length && attempts[0] < now - 60_000) attempts.shift();
      if (busy || attempts.length >= 5) throw fail(429, '正在验证或尝试过于频繁，请稍后再试。');
      attempts.push(now);
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) throw fail(413, '配置内容过长。'); }
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw fail(400, '配置内容无法读取。'); }
      body = '';
      busy = true;
      try {
        const configured = withLocalModelConfig({}, configPath);
        if (configured.LLM_API_KEY && parsed.replace !== true) throw fail(409, '已有本机配置，请确认替换后再保存。');
        const config = await validate(parsed.key);
        parsed.key = '';
        await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
        await chmod(path.dirname(configPath), 0o700);
        const tmp = `${configPath}.${randomBytes(6).toString('hex')}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(tmp, configPath);
          await chmod(configPath, 0o600);
        } finally { await unlink(tmp).catch(() => {}); }
        console.log('MODEL_SETUP_SAVED: provider=DeepSeek credential_redacted=true');
        return json(200, { ok: true, message: '密钥验证并保存成功。回到产品刷新页面后即可使用大模型解析。', model: config.LLM_MODEL });
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) json(error.safe ? error.status : 500, { error: error.safe ? error.message : '配置保存失败，未输出密钥，请联系开发者检查本机文件权限。' });
      else res.end();
    }
  });
  server.requestTimeout = 25_000;
  server.headersTimeout = 5000;
  return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.SETUP_PORT || 4174);
  createSetupServer().listen(port, '127.0.0.1', () => console.log(`本机模型配置入口：http://127.0.0.1:${port}`));
}
