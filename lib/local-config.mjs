import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOCAL_MODEL_PATH = fileURLToPath(new URL('../.local/model.json', import.meta.url));

// Local-only development configuration. Deployment uses environment variables.
// Do not return this object through any API, or log its contents.
export function withLocalModelConfig(env, file = LOCAL_MODEL_PATH) {
  if (env.NODE_ENV === 'production') return env;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof config.LLM_API_KEY !== 'string' || !config.LLM_API_KEY.trim()
      || config.LLM_BASE_URL !== 'https://api.deepseek.com'
      || typeof config.LLM_MODEL !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(config.LLM_MODEL)) return env;
    return {
      ...env,
      LLM_API_KEY: env.LLM_API_KEY || config.LLM_API_KEY,
      LLM_MODEL: env.LLM_MODEL || config.LLM_MODEL,
      LLM_BASE_URL: env.LLM_BASE_URL || config.LLM_BASE_URL,
    };
  } catch { return env; }
}
