// 单视频全方位分析 pipeline：多模型并行拆解 → 综合报告，结果入库。
import { enabledProviders } from '../core/config.js';
import { chat, parseJsonLoose } from '../llm/client.js';
import { VIDEO_ANALYST_SYSTEM, videoAnalystPrompt, SYNTHESIS_SYSTEM, synthesisPrompt } from './prompts.js';
import { insertAnalysis, updateAnalysis, getVideoByAwemeId, getBloggerById, listComments, listVideos } from '../core/db.js';
import { logger } from '../core/logger.js';

/** 组装数据对比上下文：该视频数据 vs 博主近 30 天均值。 */
function statsContext(video, bloggerId) {
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const others = listVideos(bloggerId, { limit: 100 }).filter(
      (v) => v.aweme_id !== video.aweme_id && v.create_time >= since && v.digg != null,
    );
    if (!others.length) return null;
    const avg = (k) => {
      const vals = others.map((v) => v[k]).filter((x) => x != null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const parts = [];
    const digg = avg('digg');
    const collect = avg('collect');
    const comment = avg('comment_count');
    if (digg) parts.push(`平均点赞 ${digg}（本条 ${video.digg}，${video.digg >= digg ? '高' : '低'} ${Math.abs(Math.round(((video.digg - digg) / digg) * 100))}%）`);
    if (collect) parts.push(`平均收藏 ${collect}（本条 ${video.collect}）`);
    if (comment) parts.push(`平均评论 ${comment}（本条 ${video.comment_count}）`);
    return parts.length ? parts.join('；') : null;
  } catch {
    return null;
  }
}

/** 运行一个分析模型并落库，返回 analysis id。 */
async function runOne(awemeId, { provider, model, system, user, parseJson = false }) {
  const id = insertAnalysis({ awemeId, provider: provider.id, model, kind: parseJson ? 'video' : 'synthesis' });
  const started = Date.now();
  try {
    const result = await chat(provider, { model, system, user, temperature: 0.5, maxTokens: 8000 });
    let content = result.content;
    if (parseJson) {
      try {
        content = JSON.stringify(parseJsonLoose(content));
      } catch {
        logger.warn(`[${model}] 返回内容不是合法 JSON，按原文保存`);
      }
    }
    updateAnalysis(id, { status: 'success', content, duration_ms: result.durationMs });
    logger.info(`[${model}] 分析完成（${(result.durationMs / 1000).toFixed(1)}s）`);
    return { id, ok: true, content };
  } catch (e) {
    updateAnalysis(id, { status: 'error', error: e.message, duration_ms: Date.now() - started });
    logger.error(`[${model}] 分析失败: ${e.message}`);
    return { id, ok: false, error: e.message };
  }
}

/**
 * 对单个视频做多模型并行分析 + 综合报告。已分析过的视频跳过（force 强制重跑）。
 * @returns {{results: object[], synthesis: object|null, skipped: boolean}}
 */
export async function analyzeVideo(awemeId, { force = false, onProgress } = {}) {
  const video = getVideoByAwemeId(awemeId);
  if (!video) throw new Error(`视频不存在: ${awemeId}`);
  const blogger = getBloggerById(video.blogger_id);
  const comments = listComments(awemeId, { limit: 50 });
  const transcript = video.transcript_text || '';

  if (!force && video.analyzed) {
    logger.info(`视频 ${awemeId} 已分析过，跳过（force=true 可重跑）`);
    return { skipped: true };
  }

  const pairs = [];
  for (const p of enabledProviders()) {
    for (const model of p.models?.analysts || []) pairs.push({ provider: p, model });
  }
  if (!pairs.length) throw new Error('config 中没有配置 models.analysts');

  const prompt = videoAnalystPrompt({
    video,
    blogger,
    statsContext: statsContext(video, video.blogger_id),
    transcript,
    comments,
    topN: comments.length,
  });

  logger.info(`开始多模型分析（${pairs.map((x) => x.model).join(', ')}）...`);
  onProgress?.({ stage: 'analysts', total: pairs.length });
  const settled = await Promise.allSettled(
    pairs.map((pair) => runOne(awemeId, { provider: pair.provider, model: pair.model, system: VIDEO_ANALYST_SYSTEM, user: prompt, parseJson: true })),
  );
  const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false, error: String(s.reason) }));
  const okResults = [];
  for (const r of results) {
    if (r.ok) {
      const row = pairs[results.indexOf(r)];
      okResults.push({ model: row.model, provider: row.provider, content: r.content });
    }
  }
  if (!okResults.length) throw new Error('所有分析模型都失败了');

  // 综合报告
  let synthesis = null;
  try {
    const { synthesizerPair } = await import('../llm/client.js');
    const pair = synthesizerPair();
    logger.info(`综合报告模型: ${pair.model}`);
    const s = await runOne(awemeId, {
      provider: pair.provider,
      model: pair.model,
      system: SYNTHESIS_SYSTEM,
      user: synthesisPrompt({ video, blogger, reports: okResults.map((r) => ({ model: r.model, content: r.content })) }),
    });
    synthesis = s;
  } catch (e) {
    logger.warn(`综合报告生成失败（不影响各模型分析）: ${e.message}`);
  }

  const { updateVideo } = await import('../core/db.js');
  updateVideo(awemeId, { analyzed: 1 });
  return { results, synthesis, skipped: false };
}
