// 每日赛道简报生成
import { loadConfig } from '../core/config.js';
import {
  listBloggers, listVideos, getBloggerById,
  insertDailyBriefing, getDailyBriefing,
} from '../core/db.js';
import { chat } from '../llm/client.js';
import { logger } from '../core/logger.js';

const BRIEFING_SYSTEM = `你是短视频赛道分析师。根据提供的赛道数据，生成一份简洁的每日简报（Markdown 格式）。
要求：
1. 标题：【赛道简报】{domain} · {date}
2. 核心发现（3-5 条，每条一句话）
3. 爆款视频 TOP3（标题 + 点赞 + 一句话点评）
4. 趋势观察（涨粉/互动/内容方向变化）
5. 行动建议（1-2 条可执行建议）
语气：专业但不枯燥，像给同事发消息`;

export async function generateDailyBriefing(domain, date) {
  const cfg = loadConfig();
  const provider = (cfg.llm.providers || []).find((p) => p.enabled !== false);
  const model = provider?.models?.synthesizer || provider?.models?.analysts?.[0];
  if (!model || !provider) throw new Error('未配置 LLM');

  // 1. 收集数据
  const bloggers = listBloggers().filter((b) => {
    if (domain) return b.nickname?.includes(domain) || b.sec_uid?.includes(domain);
    return b.blogger_type !== 'competitor'; // 默认排除竞品
  });

  // 近 7 天优先，不足则退化为最近视频（避免低频检查时永远无简报）
  let allVideos = [];
  for (const b of bloggers) {
    const vids = listVideos(b.id, { limit: 50 }).filter((v) => {
      const days = (Date.now() / 1000 - v.create_time) / 86400;
      return days <= 7;
    });
    allVideos.push(...vids.map((v) => ({ ...v, blogger: b })));
  }
  if (allVideos.length < 3) {
    allVideos = [];
    for (const b of bloggers) {
      allVideos.push(...listVideos(b.id, { limit: 20 }).map((v) => ({ ...v, blogger: b })));
    }
    allVideos = [...allVideos].sort((a, b) => (b.create_time || 0) - (a.create_time || 0)).slice(0, 20);
  }

  if (!allVideos.length) {
    logger.info(`[简报] ${domain || '全赛道'} 无可用视频数据，跳过`);
    return null;
  }

  // 2. 排序取 TOP
  const topByDigg = [...allVideos].sort((a, b) => (b.digg || 0) - (a.digg || 0)).slice(0, 10);
  const topByCollect = [...allVideos].sort((a, b) => (b.collect || 0) - (a.collect || 0)).slice(0, 5);

  // 3. 构建 prompt
  const topDiggLines = topByDigg.map((v, i) => `${i + 1}. ${v.title || v.aweme_id} | 👍${v.digg || 0} | ${v.blogger?.nickname}`).join('\n');
  const topCollectLines = topByCollect.map((v, i) => `${i + 1}. ${v.title || v.aweme_id} | ⭐${v.collect || 0}`).join('\n');
  const totalDigg = allVideos.reduce((s, v) => s + (v.digg || 0), 0);
  const totalCollect = allVideos.reduce((s, v) => s + (v.collect || 0), 0);
  const avgDigg = Math.round(totalDigg / allVideos.length);

  const user = `赛道：${domain || '综合'}
日期：${date}
监控博主数：${bloggers.length}
最近 3 天视频数：${allVideos.length}

TOP10 爆款（按点赞）：
${topDiggLines}

TOP5 收藏：
${topCollectLines}

数据汇总：
- 总视频数：${allVideos.length}
- 总点赞：${totalDigg}
- 总收藏：${totalCollect}
- 平均点赞：${avgDigg}

请生成今日简报。`;

  // 4. 调用 LLM
  logger.info(`[简报] 生成 ${domain || '综合'} 简报...`);
  let result;
  try {
    result = await chat(provider, {
      model,
      system: BRIEFING_SYSTEM,
      user,
      temperature: 0.7,
      maxTokens: 2000,
    });
  } catch (e) {
    logger.error(`[简报] LLM 调用失败: ${e.message.slice(0, 80)}`);
    throw new Error(`简报生成失败（LLM 异常）: ${e.message.slice(0, 60)}`);
  }
  if (!result?.content?.trim()) throw new Error('简报生成失败（模型返回空内容）');

  // 5. 入库
  const briefingId = insertDailyBriefing(date, domain || '综合', result.content, topByDigg.slice(0, 3));
  logger.info(`[简报] 已生成 ${domain || '综合'} 简报 (id=${briefingId})`);

  return {
    id: briefingId,
    date,
    domain: domain || '综合',
    content: result.content,
    topVideos: topByDigg.slice(0, 3),
  };
}

export async function getOrCreateBriefing(date, domain) {
  let briefing = getDailyBriefing(date);
  if (!briefing) {
    briefing = await generateDailyBriefing(domain, date);
  }
  return briefing;
}
