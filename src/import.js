// 数据导入层（开源版核心）：把私有采集环境导出的 JSON 写入本地 SQLite，
// 供面板 / 雷达 / 选题分析 / AI 分析 / 日报全部复用。
//
// 用法：
//   npm run import -- path/to/data.json
//
// 参见 docs/import-format.md 的字段说明与示例。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, upsertBlogger } from './core/db.js';
import { logger } from './core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function d() {
  return getDb();
}

/** 生成评论唯一 cid（未提供时用确定性伪值，避免 UNIQUE 冲突）。 */
function ensureCid(email, idx) {
  return email || `import_${idx}`;
}

function insertVideoFor(bloggerId, v) {
  const db = d();
  const existing = db.prepare('SELECT id FROM videos WHERE aweme_id = ?').get(v.awemeId);
  if (existing) {
    logger.warn(`跳过已存在视频: ${v.awemeId}`);
    return existing.id;
  }
  const stats = v.stats || {};
  const r = db.prepare(
    `INSERT INTO videos (aweme_id, blogger_id, title, create_time, duration_sec,
      digg, comment_count, share, collect, play, play_url, cover, downloaded, video_path, transcript_path, transcript_text, analyzed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    v.awemeId, bloggerId, v.title ?? null, v.createTime ?? null, v.durationSec ?? null,
    stats.digg ?? null, stats.comment ?? null, stats.share ?? null, stats.collect ?? null, stats.play ?? null,
    v.playUrl ?? null, v.cover ?? null, v.downloaded ? 1 : 0, null, null,
    v.transcriptText ?? null, v.transcriptText ? 1 : 0,
  );
  logger.info(`  视频 #${Number(r.lastInsertRowid)} ${v.title || v.awemeId}`);
  return Number(r.lastInsertRowid);
}

function importComments(awemeId, comments = []) {
  const db = d();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO comments (aweme_id, cid, nickname, content, digg, reply_count, create_time)
     VALUES (?,?,?,?,?,?,?)`,
  );
  comments.forEach((c, i) => {
    ins.run(awemeId, ensureCid(c.cid, `${awemeId}_${i}`), c.nickname ?? null, c.content ?? '', c.digg ?? 0, c.replyCount ?? 0, c.createTime ?? null);
  });
  if (comments.length) logger.info(`  评论 ${comments.length} 条`);
}

function importAnalyses(awemeId, analyses = []) {
  const db = d();
  const ins = db.prepare(
    `INSERT INTO analyses (aweme_id, provider, model, kind, status, content, error, duration_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  analyses.forEach((a) => {
    ins.run(awemeId, a.provider ?? 'import', a.model ?? 'import', a.kind ?? 'video', a.status ?? 'success', a.content ?? null, a.error ?? null, a.durationMs ?? null);
  });
}

function importBlogger(b) {
  const row = upsertBlogger({
    secUid: b.secUid,
    nickname: b.nickname,
    avatar: b.avatar,
    signature: b.signature,
    followerCount: b.followerCount,
  });
  const bloggerId = Number(row.id ?? row);
  logger.info(`博主: ${b.nickname || b.secUid} (#${bloggerId})`);
  for (const v of b.videos || []) {
    const vid = insertVideoFor(bloggerId, v);
    importComments(v.awemeId, v.comments || []);
    importAnalyses(v.awemeId, v.analyses || []);
  }
}

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function importScoutRuns(runs = []) {
  const db = d();
  const mkRun = db.prepare('INSERT INTO scout_runs (domain, keywords, status, error, created_at, finished_at) VALUES (?,?,?,?,?,?)');
  const mkBlog = db.prepare(`INSERT INTO scout_blogs
    (run_id, sec_uid, nickname, signature, avatar, follower_count, verified, total_like, aweme_count,
     video_samples, max_digg, median_digg, heat_ratio, fresh_days, score, rating, ai_analysis, monitored)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const run of runs) {
    const r = mkRun.run(run.domain, JSON.stringify(run.keywords || []), run.status || 'done', run.error ?? null, run.createdAt ?? nowStr(), run.finishedAt ?? null);
    const runId = Number(r.lastInsertRowid);
    for (const b of run.blogs || []) {
      mkBlog.run(runId, b.secUid, b.nickname, b.signature ?? null, b.avatar ?? null, b.followerCount ?? null, b.verified ? 1 : 0,
        b.totalLike ?? null, b.awemeCount ?? null, b.videoSamples ?? 0, b.maxDigg ?? 0, b.medianDigg ?? 0, b.heatRatio ?? null,
        b.freshDays ?? null, b.score ?? 0, b.rating ?? null, b.aiAnalysis ?? null, b.monitored ? 1 : 0);
    }
    logger.info(`雷达跑次: 「${run.domain}」(#${runId}) ${(run.blogs || []).length} 位博主`);
  }
}

function importSearchRuns(runs = []) {
  const db = d();
  const mkRun = db.prepare('INSERT INTO search_runs (keyword, topn, status, error, created_at, finished_at, result_count) VALUES (?,?,?,?,?,?,?)');
  const mkVideo = db.prepare('INSERT OR IGNORE INTO search_videos (run_id, aweme_id, title, author, digg, comment_count, share, collect, rank, analyzed) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const run of runs) {
    const r = mkRun.run(run.keyword, run.topn ?? 5, run.status ?? 'done', run.error ?? null, run.createdAt ?? nowStr(), run.finishedAt ?? null, (run.videos || []).length);
    const runId = Number(r.lastInsertRowid);
    (run.videos || []).forEach((v, i) => {
      mkVideo.run(runId, v.awemeId, v.title ?? null, v.author ?? null, v.digg ?? 0, v.commentCount ?? 0, v.share ?? 0, v.collect ?? 0, v.rank ?? i + 1, v.analyzed ? 1 : 0);
    });
    logger.info(`选题跑次: 「${run.keyword}」(#${runId}) ${(run.videos || []).length} 条`);
  }
}

export function importData(file) {
  if (!file) {
    console.error('用法: npm run import -- <file.json>');
    process.exit(1);
  }
  const filePath = path.resolve(ROOT, file);
  const raw = readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);

  logger.info(`导入数据: ${filePath}`);
  if (!Array.isArray(data.bloggers)) data.bloggers = [];
  if (!Array.isArray(data.scoutRuns)) data.scoutRuns = [];
  if (!Array.isArray(data.searchRuns)) data.searchRuns = [];

  // 事务包裹
  const db = d();
  db.exec('BEGIN');
  try {
    data.bloggers.forEach(importBlogger);
    importScoutRuns(data.scoutRuns);
    importSearchRuns(data.searchRuns);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  logger.info(`✔ 导入完成：博主 ${data.bloggers.length} 位、雷达跑次 ${data.scoutRuns.length}、选题跑次 ${data.searchRuns.length}`);
}

// 兼容 CLI 直接调用
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/src/import.js')) {
  importData(process.argv[2]);
}