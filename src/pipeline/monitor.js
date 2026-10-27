// 监控编排：查新 → 下载 → 转写 → 评论 → 多模型分析 → 日报，单环节失败不中断整体。
import { loadConfig } from '../core/config.js';
import { startRun, finishRun, upsertBlogger, insertVideo, getVideoByAwemeId, updateVideo, listVideos, markBloggerChecked, replaceComments, getBloggerById, insertVideoSnapshot, insertBloggerSnapshot, insertCompetitorAlert } from '../core/db.js';
import { fetchProfile } from '../data/profile.js';
import { fetchVideoComments } from '../data/comments.js';
import { parseShortVideo, downloadVideo } from '../data/share.js';
import { transcribeVideo } from '../media/transcribe.js';
import { analyzeVideo } from '../analysis/pipeline.js';
import { generateDailyReport } from '../report/daily.js';
import { logger } from '../core/logger.js';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VIDEO_DIR = path.join(ROOT, 'data', 'videos');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 竞品检测：是否爆赞（超过阈值倍数） */
export function checkCompetitorAlert(video, blogger, threshold = 3) {
  // 用该博主历史视频点赞中位数做基准（数据不足时退回 200）
  const history = listVideos(blogger.id, { limit: 30 }).map((v) => v.digg).filter((d) => d > 0);
  let base = 200;
  if (history.length >= 5) {
    const sorted = [...history].sort((a, b) => a - b);
    base = sorted[Math.floor(sorted.length / 2)];
  }
  const digg = video.stats?.digg || 0;
  if (digg >= base * threshold) {
    return { type: 'viral', detail: `点赞 ${digg}（历史中位 ${base} 的 ${(digg / base).toFixed(1)} 倍）` };
  }
  return null;
}

/** 确保单视频的 转写稿+评论 齐备（下载在需要时发生）。onStage(stage) 汇报阶段。 */
export async function ensureAssets(video, { headless, transcribeCfg, onStage } = {}) {
  const awemeId = video.aweme_id;
  // 1. 下载（转写需要视频文件；若该视频是图集则跳过）
  let videoPath = video.video_path && (await import('node:fs')).existsSync(video.video_path) ? video.video_path : null;
  if (!videoPath) {
    onStage?.('下载视频');
    logger.info(`[${awemeId}] 免登录解析并下载...`);
    const parsed = await parseShortVideo(awemeId, { retries: 6 });
    if (parsed.isGallery) {
      logger.warn(`[${awemeId}] 是图集，无音轨可转写，只做元数据分析`);
    } else {
      mkdirSync(VIDEO_DIR, { recursive: true });
      videoPath = await downloadVideo(parsed, VIDEO_DIR, awemeId);
      updateVideo(awemeId, { downloaded: 1, video_path: videoPath, play_url: parsed.playUrl });
      logger.info(`[${awemeId}] 下载完成: ${videoPath}`);
    }
  }

  // 2. 转写
  if (videoPath && !video.transcript_text) {
    onStage?.('GPU 转写');
    const { text, txtPath } = await transcribeVideo(videoPath, awemeId, transcribeCfg);
    updateVideo(awemeId, { transcript_text: text, transcript_path: txtPath });
  }

  // 3. 评论（高赞 TOP N）——失败不阻塞后续分析，可稍后重抓
  if (!listCommentsCount(awemeId)) {
    try {
      onStage?.('抓取评论');
      const comments = await fetchVideoComments(awemeId, { target: transcribeCfg.topComments, headless });
      replaceComments(awemeId, comments);
    } catch (e) {
      logger.warn(`[${awemeId}] 评论抓取失败（不阻塞分析，可稍后在面板重抓）: ${e.message}`);
    }
  }
}

import { listComments } from '../core/db.js';
function listCommentsCount(awemeId) {
  return listComments(awemeId, { limit: 1 }).length;
}

/** 单视频全流程（分析+综合），错误向上抛由调用方隔离。 */
async function processVideo(video, blogger, { headless, onProgress, videoIdx, videoTotal, videoTimes }) {
  const cfg = loadConfig();
  const step = (stage) => onProgress?.({
    stage,
    current: videoIdx, total: videoTotal,
    detail: (video.title || video.aweme_id).replace(/\s+/g, ' ').slice(0, 30),
    etaSec: videoTimes ? estimateEta(videoTimes, videoIdx, videoTotal) : null,
  });
  const started = Date.now();
  await ensureAssets(video, { headless, onStage: (s) => step(s) });
  await sleep(2000 + Math.floor(Math.random() * 3000));
  step('AI 分析');
  await analyzeVideo(video.aweme_id);
  videoTimes?.push(Date.now() - started);
}

function estimateEta(videoTimes, videoIdx, videoTotal) {
  if (!videoTimes?.length) return null;
  const avg = videoTimes.reduce((a, b) => a + b, 0) / videoTimes.length;
  return Math.round(((videoTotal - videoIdx) * avg + 8000) / 1000);
}

/**
 * 检查一个博主的更新并跑完整 pipeline。
 * @param {object} blogger bloggers 表行
 * @param {object} opts { maxPages, limitVideos, headless, skipAnalysis, onProgress }
 * @returns {{newVideos: string[], processed: string[], errors: object[]}}
 */
export async function checkBlogger(blogger, { maxPages, limitVideos, headless = false, skipAnalysis = false, onProgress } = {}) {
  const cfg = loadConfig();
  maxPages ??= cfg.monitor.maxPagesPerBlogger;
  limitVideos ??= cfg.monitor.maxVideosPerCheck;

  const runId = startRun(`check:${blogger.nickname || blogger.sec_uid}`);
  const newVideos = [];
  const processed = [];
  const errors = [];
  const videoTimes = [];

  try {
    onProgress?.({ stage: '抓取投稿列表', detail: '打开博主主页…' });
    const { blogger: info, videos } = await fetchProfile(blogger.sec_uid, { maxPages, headless });
    upsertBlogger({
      secUid: blogger.sec_uid,
      nickname: info.nickname,
      avatar: info.avatar,
      signature: info.signature,
      followerCount: info.followerCount,
    });
    const bloggerId = getBloggerById(blogger.id)?.id ?? blogger.id;
    insertBloggerSnapshot(bloggerId, info.followerCount ?? null, videos.length);

    // 找新视频（库里没有的 aweme_id）；已有视频顺便回填缺失的封面
    for (const v of videos) {
      const r = insertVideo(bloggerId, v);
      if (r.isNew) newVideos.push(v.awemeId);
      else if (v.cover && !getVideoByAwemeId(v.aweme_id)?.cover) updateVideo(v.aweme_id, { cover: v.cover });
      // 数据快照：每次检查记录一次互动数据，供增长曲线使用
      insertVideoSnapshot(v.awemeId, v.stats || {});
      
      // 竞品爆赞检测
      if (blogger.blogger_type === 'competitor') {
        const alert = checkCompetitorAlert(v, blogger, blogger.alert_threshold || 3);
        if (alert) {
          insertCompetitorAlert(bloggerId, v.awemeId, alert.type, alert.detail);
          logger.info(`[竞品] ${blogger.nickname} 视频 ${v.awemeId} 触发预警: ${alert.detail}`);
        }
      }
    }
    logger.info(`[${info.nickname || blogger.sec_uid}] 本轮发现 ${videos.length} 条投稿，其中新视频 ${newVideos.length} 条`);

    // 竞品轻量模式：只抓元数据+快照，跳过下载/转写/分析
    const isCompetitor = blogger.blogger_type === 'competitor';
    const todo = newVideos.slice(0, limitVideos);
    let idx = 0;
    for (const awemeId of todo) {
      idx++;
      try {
        const v = getVideoByAwemeId(awemeId);
        if (isCompetitor) {
          // 竞品：只更新元数据+快照
          onProgress?.({ stage: '竞品快照', current: idx, total: todo.length, detail: awemeId });
          updateVideo(awemeId, { digg: v.stats?.digg, comment_count: v.stats?.comment, share: v.stats?.share, collect: v.stats?.collect });
          insertVideoSnapshot(awemeId, v.stats || {});
          // 爆赞检测
          const alert = checkCompetitorAlert(v, blogger, blogger.alert_threshold || 3);
          if (alert) {
            insertCompetitorAlert(bloggerId, awemeId, alert.type, alert.detail);
            logger.info(`[竞品] ${blogger.nickname} 视频 ${awemeId} 触发预警: ${alert.detail}`);
          }
        } else if (skipAnalysis) {
          onProgress?.({ stage: '准备素材', current: idx, total: todo.length, detail: awemeId });
          await ensureAssets(v, { headless, transcribeCfg: { ...cfg.monitor.transcribe, topComments: cfg.monitor.topComments } });
        } else {
          await processVideo(v, blogger, { headless, onProgress, videoIdx: idx - 1, videoTotal: todo.length, videoTimes });
        }
        processed.push(awemeId);
      } catch (e) {
        logger.error(`[${awemeId}] 处理失败: ${e.message}`);
        errors.push({ awemeId, error: e.message });
      }
    }

    markBloggerChecked(bloggerId);

    // 生成日报（有处理成功的视频才生成）
    if (processed.length) {
      onProgress?.({ stage: '生成日报', current: todo.length, total: todo.length, detail: '' });
      await sleep(1000);
      generateDailyReport(bloggerId, processed);
    }

    finishRun(runId, {
      summary: `新视频 ${newVideos.length} 条，处理 ${processed.length} 条，失败 ${errors.length} 条`,
      status: errors.length && !processed.length ? 'error' : 'success',
      error: errors.length ? errors.map((e) => `${e.awemeId}: ${e.error}`).join(' | ').slice(0, 500) : null,
    });
    return { newVideos, processed, errors };
  } catch (e) {
    markBloggerChecked(blogger.id, e.message);
    finishRun(runId, { status: 'error', error: e.message });
    throw e;
  }
}

/** 单视频补跑全流程（面板/CLI 触发）。 */
export async function processOneVideo(awemeId, { headless = false, force = false } = {}) {
  const video = getVideoByAwemeId(awemeId);
  if (!video) throw new Error(`视频不存在: ${awemeId}`);
  const blogger = getBloggerById(video.blogger_id);
  if (force) {
    updateVideo(awemeId, { analyzed: 0 });
  }
  const cfg = loadConfig();
  await ensureAssets(video, { headless, transcribeCfg: { ...cfg.monitor.transcribe, topComments: cfg.monitor.topComments } });
  await analyzeVideo(awemeId, { force });
  return getVideoByAwemeId(awemeId);
}
