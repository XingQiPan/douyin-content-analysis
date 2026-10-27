// 选题分析 pipeline：关键词搜索 → 按点赞挑爆款 → 逐条完整分析 → 跨视频规律总结 → 调研报告。
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import {
  createSearchRun, setSearchRunVideos, markSearchVideoAnalyzed, finishSearchRun,
  getSearchRun, upsertSearchReport, ensureSearchPoolBlogger, getVideoByAwemeId,
  insertVideo, updateVideo, getBloggerById, listAnalyses, updateSearchRunCursor,
} from '../core/db.js';
import { searchDouyin } from '../data/search.js';
import { ensureAssets } from './monitor.js';
import { analyzeVideo } from '../analysis/pipeline.js';
import { chat, parseJsonLoose } from '../llm/client.js';
import { logger } from '../core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CROSS_SYSTEM = `你是短视频选题策略顾问。针对同一个搜索关键词，多条爆款视频已分别完成拆解。
请横向对比这些爆款，提炼"该关键词下的爆款规律"，输出一份可直接指导选题的总结（Markdown，中文）。
重点：共性钩子、共性结构、受众痛点交叉点、内容空位（没人做但观众想要的角度）、可执行的 3 个新选题建议。`;

function crossPrompt(keyword, items) {
  const body = items
    .map((v, i) => `## 爆款${i + 1}：${v.title}（👍${v.digg} 💬${v.comment_count} ⭐${v.collect}）\n综合结论：\n${v.synth || '（无）'}`)
    .join('\n\n');
  return `搜索关键词：「${keyword}」，共 ${items.length} 条爆款视频。\n\n${body}\n\n请输出横向对比总结。`;
}

/** 加载更多搜索结果（游标翻页，新结果追加进列表并入库）。 */
export async function loadMoreSearch(runId, { count = 20 } = {}) {
  const run = getSearchRun(runId);
  if (!run) throw new Error('记录不存在');
  if (!run.has_more) return { added: 0, hasMore: false };
  const api = await import('../data/signedApi.js');
  const r = await api.searchVideos(run.keyword, { offset: run.cursor || 0, count });
  const known = new Set(run.videos.map((v) => v.aweme_id));
  const fresh = r.videos.filter((v) => !known.has(v.awemeId));
  if (fresh.length) {
    const poolId = ensureSearchPoolBlogger();
    const startRank = run.videos.reduce((m, v) => Math.max(m, v.rank || 0), 0);
    const d = (await import('../core/db.js')).getDb();
    d.exec('BEGIN');
    try {
      const ins = d.prepare(
        `INSERT OR IGNORE INTO search_videos (run_id, aweme_id, title, author, cover, digg, comment_count, share, collect, rank)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      fresh.forEach((v, i) => {
        ins.run(runId, v.awemeId, v.title, typeof v.author === 'string' ? v.author : v.author?.nickname || null, v.cover, v.stats?.digg ?? 0, v.stats?.comment ?? 0, v.stats?.share ?? 0, v.stats?.collect ?? 0, startRank + i + 1);
        insertVideo(poolId, { awemeId: v.awemeId, title: v.title, createTime: v.createTime, durationSec: v.durationSec, stats: v.stats, cover: v.cover });
      });
      d.exec('COMMIT');
    } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
  }
  updateSearchRunCursor(runId, r.cursor ?? null, r.hasMore);
  logger.info(`[选题分析#${runId}] 加载更多: 新增 ${fresh.length} 条`);
  return { added: fresh.length, hasMore: r.hasMore };
}

function safeName(s) {
  return String(s || 'kw').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 30);
}

/**
 * 关键词选题分析全流程（在任务队列里执行）。
 * @returns {{runId: number, reportPath: string}}
 */
export async function analyzeKeyword(keyword, { topN = 5, maxResults = 24, headless = false, bridge = false, awemeIds = null, onProgress } = {}) {
  const cfg = loadConfig();
  const poolId = ensureSearchPoolBlogger();
  const runId = createSearchRun(keyword, topN);
  const report = (step) => onProgress?.(step);

  try {
    // 1. 搜索（纯 HTTP 官方接口，免签名免浏览器；失败降级搜狗/360 桥接）
    report({ stage: '搜索抖音', detail: `关键词「${keyword}」` });
    let videos = [];
    if (bridge) {
      const { searchDouyinBridge } = await import('../data/search.js');
      const r = await searchDouyinBridge(keyword, { maxResults });
      videos = r.videos;
    } else {
      try {
        const api = await import('../data/signedApi.js');
        const r = await api.searchVideos(keyword, { count: Math.min(maxResults, 30) });
        videos = r.videos.map((v) => ({
          awemeId: v.awemeId, title: v.title, createTime: v.createTime, durationSec: v.durationSec,
          cover: v.cover, stats: v.stats, author: v.author, isGallery: v.isGallery, playUrl: null,
        }));
      } catch (e) {
        logger.warn(`[选题分析#${runId}] HTTP 搜索失败（${e.message.slice(0, 60)}），降级桥接…`);
        report({ stage: '降级桥接搜索', detail: e.message.slice(0, 40) });
        const { searchDouyinBridge } = await import('../data/search.js');
        const r = await searchDouyinBridge(keyword, { maxResults });
        videos = r.videos;
      }
    }
    if (!videos.length) throw new Error('搜索结果为空');

    // 2. 全量入库（列表展示全部内容）；topN=0 仅列表不分析
    const sorted = [...videos].sort((a, b) => (b.stats.digg || 0) - (a.stats.digg || 0));
    setSearchRunVideos(runId, sorted.map((v) => ({
      awemeId: v.awemeId, title: v.title,
      author: typeof v.author === 'string' ? v.author : (v.author?.nickname || null),
      cover: v.cover,
      digg: v.stats?.digg ?? 0, comment: v.stats?.comment ?? 0,
      share: v.stats?.share ?? 0, collect: v.stats?.collect ?? 0,
    })));
    updateSearchRunCursor(runId, r.cursor ?? null, r.hasMore);
    // 2.5 搜索结果先入 videos 表（虚拟博主池），保证详情页可看
    const poolId = ensureSearchPoolBlogger();
    for (const v of sorted) {
      insertVideo(poolId, {
        awemeId: v.awemeId, title: v.title, createTime: v.createTime, durationSec: v.durationSec,
        stats: v.stats, cover: v.cover,
      });
    }

    if (!topN) {
      finishSearchRun(runId, { status: 'done' });
      logger.info(`[选题分析#${runId}] 「${keyword}」列表模式：${sorted.length} 条`);
      return { runId, listCount: sorted.length };
    }
    const top = sorted.slice(0, topN);
    logger.info(`[选题分析#${runId}] 「${keyword}」共 ${sorted.length} 条结果，深度分析前 ${top.length} 条`);

    // 3. 逐条入池 + 完整分析
    const videoTimes = [];
    let idx = 0;
    for (const v of top) {
      idx++;
      const started = Date.now();
      try {
        const r = insertVideo(poolId, {
          awemeId: v.awemeId, title: v.title, createTime: v.createTime, durationSec: v.durationSec,
          stats: v.stats, cover: v.cover,
        });
        if (!r.isNew) updateVideo(v.awemeId, { digg: v.stats.digg, comment_count: v.stats.comment, share: v.stats.share, collect: v.stats.collect, cover: v.cover });
        const row = getVideoByAwemeId(v.awemeId);
        const step = (stage) => report({
          stage, current: idx - 1, total: top.length,
          detail: (v.title || '').replace(/\s+/g, ' ').slice(0, 28),
          etaSec: videoTimes.length ? Math.round(((top.length - idx + 1) * (videoTimes.reduce((a, b) => a + b, 0) / videoTimes.length)) / 1000) : null,
        });
        step('准备素材');
        await ensureAssets(row, {
          headless,
          transcribeCfg: { ...cfg.monitor.transcribe, topComments: cfg.monitor.topComments },
          onStage: step,
        });
        step('AI 分析');
        await analyzeVideo(v.awemeId);
        markSearchVideoAnalyzed(runId, v.awemeId);
        videoTimes.push(Date.now() - started);
      } catch (e) {
        logger.error(`[选题分析#${runId}] 视频 ${v.awemeId} 分析失败（跳过）: ${e.message}`);
      }
    }

    // 4. 跨视频规律总结
    report({ stage: '生成调研报告', current: top.length, total: top.length, detail: '横向对比爆款规律' });
    const run = getSearchRun(runId);
    const items = run.videos
      .filter((v) => v.analyzed)
      .map((v) => {
        const synth = listAnalyses(v.aweme_id).filter((a) => a.kind === 'synthesis' && a.status === 'success').pop();
        return { ...v, synth: synth?.content || '' };
      });

    const dir = path.join(ROOT, 'reports', '_选题分析');
    mkdirSync(dir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `${safeName(keyword)}-${dateStr}-run${runId}.md`);

    const lines = [];
    lines.push(`# 🔍 选题分析报告 · 「${keyword}」`);
    lines.push('');
    lines.push(`> 生成时间 ${new Date().toLocaleString('zh-CN', { hour12: false })} · 搜索 TOP${topN} · 成功分析 ${items.length} 条`);
    lines.push('');
    lines.push('## 爆款清单（按点赞）');
    lines.push('');
    lines.push('| # | 视频 | 作者 | 赞 | 评 | 藏 | 转 |');
    lines.push('|---|------|------|----|----|----|----|');
    run.videos.forEach((v, i) => {
      lines.push(`| ${i + 1} | [${(v.title || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 30)}](https://www.douyin.com/video/${v.aweme_id}) | ${v.author || '?'} | ${v.digg} | ${v.comment_count} | ${v.collect} | ${v.share} |`);
    });
    lines.push('');

    let crossMd = '';
    if (items.length >= 2) {
      try {
        const { synthesizerPair } = await import('../llm/client.js');
        const pair = synthesizerPair();
        logger.info(`[选题分析#${runId}] 规律总结模型: ${pair.model}`);
        const r = await chat(pair.provider, { model: pair.model, system: CROSS_SYSTEM, user: crossPrompt(keyword, items), temperature: 0.5, maxTokens: 6000 });
        crossMd = r.content;
        lines.push('## 🔥 爆款规律总结（跨视频对比）');
        lines.push('');
        lines.push(crossMd);
        lines.push('');
      } catch (e) {
        logger.warn(`[选题分析#${runId}] 规律总结失败: ${e.message}`);
      }
    }

    lines.push('## 各视频完整拆解');
    lines.push('');
    for (const it of items) {
      lines.push(`### ${it.rank}. [${(it.title || '').replace(/\s+/g, ' ').slice(0, 40)}](https://www.douyin.com/video/${it.aweme_id}) — ${it.author || '?'}`);
      lines.push('');
      if (it.synth) lines.push(it.synth);
      else lines.push('（分析失败，可稍后重跑）');
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    writeFileSync(filePath, lines.join('\n'), 'utf8');
    upsertSearchReport(runId, filePath);
    finishSearchRun(runId, { status: 'done' });
    logger.info(`[选题分析#${runId}] 报告已生成: ${filePath}`);
    return { runId, reportPath: filePath, crossMd };
  } catch (e) {
    finishSearchRun(runId, { status: 'error', error: e.message });
    throw e;
  }
}
