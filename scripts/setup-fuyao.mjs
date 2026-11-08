import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSetupServer } from './setup-model.mjs';

export const LOCAL_FUYAO_PATH = fileURLToPath(new URL('../.local/fuyao.json', import.meta.url));
const PAGE = fileURLToPath(new URL('./setup/fuyao.html', import.meta.url));
const CHECK_URL = 'https://fuyao.aicubes.cn/api/a-share/valuations/snapshot?thscodes=600519.SH';
function error(status, message) { return Object.assign(new Error(message), { status, safe: true }); }

export async function validateFuyaoKey(key, { fetchImpl = fetch } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,1000}$/.test(key.trim())) throw error(400, '密钥格式不正确，请完整复制扶摇后台的 API Key，不要带请求头名称。');
  const cleaned = key.trim();
  let payload;
  try {
    const response = await fetchImpl(CHECK_URL, {
      headers: { 'X-api-key': cleaned, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw error(401, '扶摇没有接受该密钥，请确认已经生效且具有估值接口权限。');
    if (!response.ok) throw error(502, '扶摇服务暂时不可用，配置未保存，请稍后重试。');
    const text = await response.text();
    if (text.length > 200_000) throw error(502, '扶摇返回内容异常，配置未保存。');
    payload = JSON.parse(text);
  } catch (cause) {
    if (cause.safe) throw cause;
    throw error(502, '无法连接扶摇验证密钥，或返回内容无法读取，配置未保存。请稍后重试。');
  }
  if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.code)) throw error(502, '扶摇未返回有效业务状态，配置未保存。');
  if (payload.code !== 0) {
    console.log(`FUYAO_VALIDATION: http=200 business_code=${payload.code} saved=false`);
    throw error(422, `扶摇返回业务错误码 ${payload.code}，配置未保存。请在扶摇后台检查密钥状态、接口权限与额度。`);
  }
  const items = payload.data?.item;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.thscode !== '600519.SH') throw error(502, '扶摇响应缺少预期的股票数据结构，配置未保存，请联系开发者核对。');
  console.log('FUYAO_VALIDATION: http=200 business_code=0 checked_endpoint=valuations/snapshot');
  return { FUYAO_API_KEY: cleaned, verifiedAt: new Date().toISOString(), checkedEndpoint: '/api/a-share/valuations/snapshot' };
}
export async function inspectFuyaoConfig(file) {
  try {
    const cfg = JSON.parse(await readFile(file, 'utf8'));
    return { configured: typeof cfg.FUYAO_API_KEY === 'string' && cfg.FUYAO_API_KEY.trim().length >= 8 };
  } catch (cause) {
    if (cause.code === 'ENOENT') return { configured: false };
    // Do not silently overwrite a damaged or inaccessible private config.
    throw error(500, '已有扶摇配置无法安全读取，请联系开发者检查，不会自动覆盖。');
  }
}
export function createFuyaoSetupServer({ configPath = LOCAL_FUYAO_PATH, validate = validateFuyaoKey } = {}) {
  return createSetupServer({
    configPath, validate, pagePath: PAGE, inspectConfig: inspectFuyaoConfig, provider: '扶摇',
    successMessage: '扶摇估值接口验证通过，密钥已私有保存在本机。请回到聊天回复“扶摇已保存”。其他接口权限、字段口径与云端接入仍待核验。',
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.FUYAO_SETUP_PORT || 4175);
  createFuyaoSetupServer().listen(port, '127.0.0.1', () => console.log(`本机扶摇配置入口：http://127.0.0.1:${port}`));
}
