// 选题策划与脚本生成
import { loadConfig } from '../core/config.js';
import { chat } from '../llm/client.js';
import { logger } from '../core/logger.js';
import { searchVideos } from '../data/signedApi.js';

const CREATION_SYSTEM = `你是短视频创作顾问。根据用户提供的主题和参考资料，输出：
1. 选题策划方案（3-5 个角度，每个含钩子建议）
2. 口播脚本大纲（按选定角度展开，含时间线、互动点、悬念点）
语气：直接、实用、像资深编导在给建议`;

export async function planTopic(topic, references = []) {
  const cfg = loadConfig();
  const provider = (cfg.llm.providers || []).find((p) => p.enabled !== false);
  const model = provider?.models?.synthesizer || provider?.models?.analysts?.[0];
  if (!model || !provider) throw new Error('未配置 LLM');

  // 1. 搜索参考资料（抖音；失败不中断，仅用用户提供的参考）
  let topVideos = [];
  try {
    logger.info(`[创作] 搜索「${topic}」参考资料...`);
    const searchResults = await searchVideos(topic, { count: 20 });
    topVideos = searchResults.videos.slice(0, 10);
  } catch (e) {
    logger.warn(`[创作] 抖音搜索失败（降级为仅用用户参考）: ${e.message.slice(0, 60)}`);
  }

  // 2. 构建 prompt
  const refLines = topVideos.map((v, i) => `${i + 1}. ${v.title || v.aweme_id} | 👍${v.stats?.digg || 0} | ${v.author?.nickname}`).join('\n');
  const userRefs = references.map((r, i) => `${i + 1}. ${r}`).join('\n');

  const user = `主题：${topic}

抖音搜索结果（TOP10）：
${refLines}

用户提供的额外参考：
${userRefs || '无'}

请输出：
1. 选题策划方案（3-5 个角度，每个含：角度名称、钩子建议、目标受众、预期互动点）
2. 推荐对标视频（从搜索结果选 2-3 个，说明为什么值得参考）`;

  // 3. 调用 LLM
  logger.info(`[创作] 生成选题策划...`);
  const result = await chat(provider, {
    model,
    system: CREATION_SYSTEM,
    user,
    temperature: 0.8,
    maxTokens: 3000,
  });

  return {
    topic,
    references: topVideos,
    plan: result.content,
  };
}

export async function generateScript(topic, angle, style = '干货') {
  const cfg = loadConfig();
  const provider = (cfg.llm.providers || []).find((p) => p.enabled !== false);
  const model = provider?.models?.synthesizer || provider?.models?.analysts?.[0];
  if (!model || !provider) throw new Error('未配置 LLM');

  const styleGuide = {
    '干货': '信息密度高，每 30 秒一个知识点，用数据/案例支撑',
    '故事': '以个人经历/案例开场，有起伏转折，情感共鸣',
    '争议': '抛出反常识观点，用对比/反问制造冲突，引导评论',
  };

  const user = `主题：${topic}
角度：${angle}
风格：${style}（${styleGuide[style] || '信息密度高，实用为主'}）

请输出口播脚本大纲：
1. 开头钩子（0-10 秒，必须抓人）
2. 主体结构（分 3-5 段，每段标注时长、核心观点、互动点/悬念点）
3. 结尾引导（引导点赞/评论/关注的话术）
4. 提词器格式（大字版，每行不超过 15 字，适合提词器滚动）`;

  logger.info(`[创作] 生成${style}风格脚本...`);
  const result = await chat(provider, {
    model,
    system: CREATION_SYSTEM,
    user,
    temperature: 0.7,
    maxTokens: 3000,
  });

  return {
    topic,
    angle,
    style,
    script: result.content,
  };
}
