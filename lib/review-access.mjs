import { createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
export function accessConfigured(env) {
  return typeof env.REVIEW_PASSWORD === 'string' && env.REVIEW_PASSWORD.length >= 16;
}
export function protectReview(req, res, env, route) {
  // Health only reveals configuration booleans, never credentials or financial data.
  if (route === '/api/health' && req.method === 'GET') return true;
  const password = env.REVIEW_PASSWORD;
  const productionWithCredentials = env.NODE_ENV === 'production' && Boolean(env.LLM_API_KEY || env.OPENAI_API_KEY || env.IFIND_API_KEY || env.IFIND_CONFIG_PATH || env.FUYAO_API_KEY || env.FUYAO_CONFIG_PATH);
  if (password && !accessConfigured(env) || productionWithCredentials && !accessConfigured(env)) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'ACCESS_CONFIG', message: '评审访问保护尚未配置完成，请联系部署者。' } }));
    return false;
  }
  if (!password) return true;
  const auth = req.headers.authorization || '';
  let supplied = '';
  if (/^Basic [A-Za-z0-9+/]+=*$/.test(auth) && auth.length < 4096) supplied = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const expected = `${env.REVIEW_USER || 'reviewer'}:${password}`;
  if (timingSafeEqual(hash(supplied), hash(expected))) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="StockLens Review", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('此产品仅供授权评审访问，请使用提交材料中的评审账号。');
  return false;
}
