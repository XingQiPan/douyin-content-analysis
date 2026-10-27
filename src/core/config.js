// 配置加载：config.json 不存在时从 config.example.json 复制并提示填写。
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  llm: { providers: [] },
  monitor: {
    cron: '0 9 * * *',
    topComments: 50,
    maxPagesPerBlogger: 2,
    maxVideosPerCheck: 10,
    transcribe: { model: 'small', maxMinutes: 15 },
    keepVideoDays: 0,
  },
  web: { host: '127.0.0.1', port: 8420, password: '' },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function ensureConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    return false;
  }
  return true;
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  if (!ensureConfigFile()) {
    throw new Error(`config.json 不存在，已从模板生成 ${CONFIG_PATH}，请填写 apiKey 后重试`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = deepMerge(DEFAULTS, raw);
  cached = cfg;
  return cfg;
}

/** 清空内存缓存（面板保存设置后调用，使新配置立即生效）。 */
export function reloadConfig() {
  cached = null;
}

/** 取所有启用的 provider，校验 baseUrl/apiKey。 */
export function enabledProviders() {
  const cfg = loadConfig();
  const list = (cfg.llm.providers || []).filter((p) => p.enabled !== false);
  if (!list.length) throw new Error('config.json 中没有启用的 LLM provider');
  for (const p of list) {
    if (!p.baseUrl || !p.apiKey || p.apiKey === 'REPLACE_ME') {
      throw new Error(`provider "${p.id}" 缺少 baseUrl 或 apiKey，请编辑 config.json`);
    }
  }
  return list;
}

export const ROOT_DIR = ROOT;
export { CONFIG_PATH };
