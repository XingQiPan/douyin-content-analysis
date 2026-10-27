// OpenAI 兼容 LLM 客户端（HTTP 调用，无 SDK 依赖）。
import { enabledProviders } from '../core/config.js';
import { logger } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用 chat/completions。
 * @param {object} provider config.llm.providers 中的一项
 * @param {object} opts { model, system, user, temperature, maxTokens, timeoutMs, retries }
 * @returns {Promise<{content: string, model: string, usage: object, durationMs: number}>}
 */
export async function chat(provider, { model, system, user, temperature = 0.7, maxTokens = 8000, timeoutMs = 300000, retries = 2 }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const resp = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: Array.isArray(user) ? user : String(user) },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('响应中没有 content');
      return { content, model, usage: data.usage || {}, durationMs: Date.now() - started };
    } catch (e) {
      lastError = e;
      logger.warn(`[llm] ${provider.id}/${model} 第 ${attempt + 1} 次失败: ${e.message}`);
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

/** 解析 LLM 返回中的 JSON（容忍 ```json 包裹和前后杂文）。 */
export function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('未找到 JSON');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('JSON 未闭合');
}

/** 扁平展开所有启用 provider 的分析模型列表：[{provider, model}] */
export function analystPairs() {
  const cfg = loadConfigSafe();
  const pairs = [];
  for (const p of cfg) {
    for (const model of p.models?.analysts || []) pairs.push({ provider: p, model });
  }
  return pairs;
}

function loadConfigSafe() {
  return enabledProviders();
}

/** 综合结论模型的 {provider, model}（取第一个 provider 的 models.synthesizer）。 */
export function synthesizerPair() {
  const cfg = enabledProviders();
  const p = cfg[0];
  const model = p.models?.synthesizer;
  if (!model) throw new Error('config 中未配置 models.synthesizer');
  return { provider: p, model };
}
