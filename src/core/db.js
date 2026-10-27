// SQLite 数据层（Node 24 内置 node:sqlite，无需额外依赖）。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

let db = null;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(path.join(DATA_DIR, 'monitor.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS bloggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sec_uid TEXT NOT NULL UNIQUE,
      nickname TEXT,
      avatar TEXT,
      signature TEXT,
      follower_count INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      last_checked_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT NOT NULL UNIQUE,
      blogger_id INTEGER NOT NULL REFERENCES bloggers(id),
      title TEXT,
      create_time INTEGER,
      duration_sec INTEGER,
      digg INTEGER, comment_count INTEGER, share INTEGER, collect INTEGER, play INTEGER,
      play_url TEXT,
      downloaded INTEGER NOT NULL DEFAULT 0,
      video_path TEXT,
      transcript_path TEXT,
      transcript_text TEXT,
      analyzed INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_videos_blogger ON videos(blogger_id, create_time DESC);
    CREATE TABLE IF NOT EXISTS competitor_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blogger_id INTEGER NOT NULL,
      aweme_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_alerts ON competitor_alerts(blogger_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT NOT NULL,
      cid TEXT NOT NULL UNIQUE,
      nickname TEXT,
      content TEXT,
      digg INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      create_time INTEGER,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(aweme_id, digg DESC);
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'video',
      status TEXT NOT NULL DEFAULT 'running',
      content TEXT,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_video ON analyses(aweme_id, created_at);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blogger_id INTEGER NOT NULL,
      report_date TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(blogger_id, report_date)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      summary TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      content TEXT NOT NULL,
      top_videos TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_briefings ON daily_briefings(date DESC);
  `);
  // 轻量迁移：老库补 cover 列
  try {
    d.exec('ALTER TABLE videos ADD COLUMN cover TEXT');
  } catch {}
  try {
    d.exec('ALTER TABLE search_videos ADD COLUMN cover TEXT');
  } catch {}
  d.exec(`
    CREATE TABLE IF NOT EXISTS search_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      topn INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'running',
      result_count INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS search_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES search_runs(id),
      aweme_id TEXT NOT NULL,
      title TEXT,
      author TEXT,
      digg INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      share INTEGER DEFAULT 0,
      collect INTEGER DEFAULT 0,
      rank INTEGER,
      analyzed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(run_id, aweme_id)
    );
    CREATE TABLE IF NOT EXISTS search_reports (
      run_id INTEGER PRIMARY KEY REFERENCES search_runs(id),
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS scout_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      keywords TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scout_blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES scout_runs(id),
      sec_uid TEXT NOT NULL,
      nickname TEXT,
      signature TEXT,
      avatar TEXT,
      follower_count INTEGER,
      verified INTEGER DEFAULT 0,
      total_like INTEGER DEFAULT 0,
      aweme_count INTEGER DEFAULT 0,
      video_samples INTEGER DEFAULT 0,
      max_digg INTEGER DEFAULT 0,
      median_digg INTEGER DEFAULT 0,
      heat_ratio REAL,
      fresh_days INTEGER,
      score INTEGER,
      rating TEXT,
      ai_analysis TEXT,
      monitored INTEGER DEFAULT 0,
      UNIQUE(run_id, sec_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_scout_blog ON scout_blogs(run_id, score DESC);
    CREATE TABLE IF NOT EXISTS video_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT NOT NULL,
      digg INTEGER, comment_count INTEGER, share INTEGER, collect INTEGER,
      taken_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_vsnap ON video_snapshots(aweme_id, taken_at);
    CREATE TABLE IF NOT EXISTS blogger_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blogger_id INTEGER NOT NULL,
      follower_count INTEGER,
      video_count INTEGER,
      taken_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bsnap ON blogger_snapshots(blogger_id, taken_at);
  `);
  try { d.exec('ALTER TABLE search_runs ADD COLUMN cursor INTEGER'); } catch {}
  try { d.exec('ALTER TABLE search_runs ADD COLUMN has_more INTEGER'); } catch {}
  try {
    d.exec('ALTER TABLE bloggers ADD COLUMN blogger_type TEXT DEFAULT "monitor"');
    d.exec('ALTER TABLE bloggers ADD COLUMN alert_threshold INTEGER DEFAULT 3');
  } catch {}
}

// ============ 每日简报 ============

export function insertDailyBriefing(date, domain, content, topVideos) {
  const r = getDb()
    .prepare('INSERT OR REPLACE INTO daily_briefings (date, domain, content, top_videos) VALUES (?,?,?,?)')
    .run(date, domain, content, JSON.stringify(topVideos || []));
  return Number(r.lastInsertRowid);
}

export function getDailyBriefing(date) {
  return getDb().prepare('SELECT * FROM daily_briefings WHERE date = ?').get(date);
}

export function listDailyBriefings({ limit = 30 } = {}) {
  return getDb().prepare('SELECT * FROM daily_briefings ORDER BY date DESC LIMIT ?').all(limit);
}

// ============ 竞品监控 ============

export function setBloggerType(id, type, threshold = 3) {
  getDb().prepare('UPDATE bloggers SET blogger_type = ?, alert_threshold = ? WHERE id = ?').run(type, threshold, id);
}

export function listCompetitors() {
  return getDb().prepare("SELECT * FROM bloggers WHERE blogger_type = 'competitor' AND enabled = 1").all();
}

export function insertCompetitorAlert(bloggerId, awemeId, alertType, detail) {
  const r = getDb()
    .prepare('INSERT INTO competitor_alerts (blogger_id, aweme_id, alert_type, detail) VALUES (?,?,?,?)')
    .run(bloggerId, awemeId, alertType, detail);
  return Number(r.lastInsertRowid);
}

export function listCompetitorAlerts({ limit = 50, unreadOnly = false } = {}) {
  const sql = 'SELECT ca.*, b.nickname FROM competitor_alerts ca JOIN bloggers b ON b.id = ca.blogger_id'
    + (unreadOnly ? ' WHERE ca.read = 0' : '')
    + ' ORDER BY ca.created_at DESC LIMIT ?';
  return getDb().prepare(sql).all(limit);
}

export function markAlertsRead(ids) {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  getDb().prepare(`UPDATE competitor_alerts SET read = 1 WHERE id IN (${ph})`).run(...ids);
}

// ============ 数据快照 ============

const MAX_SNAPSHOTS_PER_VIDEO = 90;

export function insertVideoSnapshot(awemeId, stats = {}) {
  const d = getDb();
  const id = String(awemeId);
  d.prepare('INSERT INTO video_snapshots (aweme_id, digg, comment_count, share, collect) VALUES (?,?,?,?,?)')
    .run(id, stats.digg ?? null, stats.comment ?? null, stats.share ?? null, stats.collect ?? null);
  // 保留策略：超出上限时删除最旧的（保持曲线可用且表不膨胀）
  const cnt = d.prepare('SELECT COUNT(*) c FROM video_snapshots WHERE aweme_id = ?').get(id).c;
  if (cnt > MAX_SNAPSHOTS_PER_VIDEO) {
    d.prepare(`DELETE FROM video_snapshots WHERE id IN (
      SELECT id FROM video_snapshots WHERE aweme_id = ? ORDER BY taken_at, id LIMIT ?
    )`).run(id, cnt - MAX_SNAPSHOTS_PER_VIDEO);
  }
}

export function listVideoSnapshots(awemeId) {
  return getDb()
    .prepare('SELECT taken_at, digg, comment_count, share, collect FROM video_snapshots WHERE aweme_id = ? ORDER BY taken_at, id')
    .all(String(awemeId));
}

const MAX_SNAPSHOTS_PER_BLOGGER = 180;

export function insertBloggerSnapshot(bloggerId, followerCount, videoCount) {
  const d = getDb();
  d.prepare('INSERT INTO blogger_snapshots (blogger_id, follower_count, video_count) VALUES (?,?,?)')
    .run(bloggerId, followerCount ?? null, videoCount ?? null);
  const cnt = d.prepare('SELECT COUNT(*) c FROM blogger_snapshots WHERE blogger_id = ?').get(bloggerId).c;
  if (cnt > MAX_SNAPSHOTS_PER_BLOGGER) {
    d.prepare(`DELETE FROM blogger_snapshots WHERE id IN (
      SELECT id FROM blogger_snapshots WHERE blogger_id = ? ORDER BY taken_at, id LIMIT ?
    )`).run(bloggerId, cnt - MAX_SNAPSHOTS_PER_BLOGGER);
  }
}

export function listBloggerSnapshots(bloggerId) {
  return getDb()
    .prepare('SELECT taken_at, follower_count, video_count FROM blogger_snapshots WHERE blogger_id = ? ORDER BY taken_at, id')
    .all(bloggerId);
}

// ============ 博主雷达 ============

export function createScoutRun(domain, keywords) {
  const r = getDb().prepare('INSERT INTO scout_runs (domain, keywords) VALUES (?,?)').run(domain, JSON.stringify(keywords || []));
  return Number(r.lastInsertRowid);
}

export function insertScoutBlogs(runId, rows) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const ins = d.prepare(
      `INSERT OR REPLACE INTO scout_blogs (run_id, sec_uid, nickname, signature, avatar, follower_count, verified,
        total_like, aweme_count, video_samples, max_digg, median_digg, heat_ratio, fresh_days, score, rating, ai_analysis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const b of rows) {
      ins.run(runId, b.secUid, b.nickname ?? null, b.signature ?? null, b.avatar ?? null, b.followerCount ?? null,
        b.verified ? 1 : 0, b.totalLike ?? 0, b.awemeCount ?? 0, b.videoSamples ?? 0, b.maxDigg ?? 0, b.medianDigg ?? 0,
        b.heatRatio ?? null, b.freshDays ?? null, b.score ?? null, b.rating ?? null, b.aiAnalysis ?? null);
    }
    d.exec('COMMIT');
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

export function updateScoutBlogAi(runId, secUid, { score, rating, aiAnalysis }) {
  getDb()
    .prepare('UPDATE scout_blogs SET score=?, rating=?, ai_analysis=? WHERE run_id=? AND sec_uid=?')
    .run(score, rating, aiAnalysis, runId, secUid);
}

export function finishScoutRun(runId, { status = 'done', error = null } = {}) {
  getDb()
    .prepare("UPDATE scout_runs SET status=?, error=?, finished_at=datetime('now','localtime') WHERE id=?")
    .run(status, error, runId);
}

export function getScoutRun(runId) {
  const d = getDb();
  const run = d.prepare('SELECT * FROM scout_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const blogs = d.prepare('SELECT * FROM scout_blogs WHERE run_id = ? ORDER BY score DESC NULLS LAST').all(runId);
  return { ...run, keywords: JSON.parse(run.keywords || '[]'), blogs };
}

export function listScoutRuns({ limit = 20 } = {}) {
  const d = getDb();
  const runs = d.prepare('SELECT * FROM scout_runs ORDER BY id DESC LIMIT ?').all(limit);
  return runs.map((r) => ({ ...r, blog_count: d.prepare('SELECT COUNT(*) c FROM scout_blogs WHERE run_id = ?').get(r.id).c }));
}

export function markScoutMonitored(runId, secUid) {
  getDb().prepare('UPDATE scout_blogs SET monitored = 1 WHERE run_id = ? AND sec_uid = ?').run(runId, secUid);
}

/** 删除雷达扫描记录（含候选数据；已加入监控的博主不受影响）。 */
export function deleteScoutRun(runId) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM scout_blogs WHERE run_id = ?').run(runId);
    d.prepare('DELETE FROM scout_runs WHERE id = ?').run(runId);
    d.exec('COMMIT');
    return true;
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

/** 删除选题分析记录（含视频清单与报告文件引用）。 */
export function deleteSearchRun(runId) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM search_videos WHERE run_id = ?').run(runId);
    d.prepare('DELETE FROM search_reports WHERE run_id = ?').run(runId);
    d.prepare('DELETE FROM search_runs WHERE id = ?').run(runId);
    d.exec('COMMIT');
    return true;
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

// ============ 搜索分析 ============

export const SEARCH_POOL_SEC_UID = '__search_pool__';

/** 搜索视频挂在一个隐藏虚拟博主下，复用整条视频处理流水线。 */
export function ensureSearchPoolBlogger() {
  const d = getDb();
  const row = d.prepare('SELECT id FROM bloggers WHERE sec_uid = ?').get(SEARCH_POOL_SEC_UID);
  if (row) return row.id;
  const r = d
    .prepare("INSERT INTO bloggers (sec_uid, nickname, enabled) VALUES (?, '🔎 选题分析池', 0)")
    .run(SEARCH_POOL_SEC_UID);
  return Number(r.lastInsertRowid);
}

export function createSearchRun(keyword, topn) {
  const r = getDb().prepare('INSERT INTO search_runs (keyword, topn) VALUES (?,?)').run(keyword, topn);
  return Number(r.lastInsertRowid);
}

export function setSearchRunVideos(runId, videos) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const ins = d.prepare(
      `INSERT OR IGNORE INTO search_videos (run_id, aweme_id, title, author, cover, digg, comment_count, share, collect, rank)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    videos.forEach((v, i) => {
      const txt = (x) => (typeof x === 'string' ? x : x == null ? null : String(x));
      ins.run(runId, String(v.awemeId), txt(v.title), txt(v.author), txt(v.cover), v.digg ?? 0, v.comment ?? 0, v.share ?? 0, v.collect ?? 0, i + 1);
    });
    d.prepare('UPDATE search_runs SET result_count = ? WHERE id = ?').run(videos.length, runId);
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function markSearchVideoAnalyzed(runId, awemeId) {
  getDb().prepare('UPDATE search_videos SET analyzed = 1 WHERE run_id = ? AND aweme_id = ?').run(runId, awemeId);
}

export function finishSearchRun(runId, { status = 'done', error = null } = {}) {
  getDb()
    .prepare("UPDATE search_runs SET status = ?, error = ?, finished_at = datetime('now','localtime') WHERE id = ?")
    .run(status, error, runId);
}

export function getSearchRun(runId) {
  const d = getDb();
  const run = d.prepare('SELECT * FROM search_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const videos = d.prepare('SELECT * FROM search_videos WHERE run_id = ? ORDER BY rank').all(runId);
  return { ...run, videos };
}

export function listSearchRuns({ limit = 30 } = {}) {
  return getDb().prepare('SELECT * FROM search_runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function updateSearchRunCursor(runId, cursor, hasMore) {
  getDb().prepare('UPDATE search_runs SET cursor = ?, has_more = ? WHERE id = ?').run(cursor ?? null, hasMore ? 1 : 0, runId);
}

export function upsertSearchReport(runId, reportPath) {
  getDb()
    .prepare('INSERT INTO search_reports (run_id, path) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET path = excluded.path')
    .run(runId, reportPath);
}

export function getSearchReportPath(runId) {
  return getDb().prepare('SELECT path FROM search_reports WHERE run_id = ?').get(runId)?.path ?? null;
}

// ============ DAO helpers ============

export function upsertBlogger({ secUid, nickname, avatar, signature, followerCount }) {
  const d = getDb();
  const existing = d.prepare('SELECT id FROM bloggers WHERE sec_uid = ?').get(secUid);
  if (existing) {
    d.prepare(
      'UPDATE bloggers SET nickname=?, avatar=?, signature=?, follower_count=COALESCE(?, follower_count) WHERE sec_uid=?',
    ).run(nickname ?? existing.nickname ?? null, avatar ?? null, signature ?? null, followerCount ?? null, secUid);
    return existing.id;
  }
  const r = d
    .prepare('INSERT INTO bloggers (sec_uid, nickname, avatar, signature, follower_count) VALUES (?,?,?,?,?)')
    .run(secUid, nickname ?? null, avatar ?? null, signature ?? null, followerCount ?? null);
  return Number(r.lastInsertRowid);
}

export function getBloggerById(id) {
  return getDb().prepare('SELECT * FROM bloggers WHERE id = ?').get(id);
}

export function getBloggerBySecUid(secUid) {
  return getDb().prepare('SELECT * FROM bloggers WHERE sec_uid = ?').get(secUid);
}

export function listBloggers({ enabledOnly = false } = {}) {
  const sql = 'SELECT * FROM bloggers' + (enabledOnly ? ' WHERE enabled = 1' : '') + ' ORDER BY id';
  return getDb().prepare(sql).all();
}

export function setBloggerEnabled(id, enabled) {
  getDb().prepare('UPDATE bloggers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** 删除监控博主（级联清理视频/评论/分析/日报/雷达标记）。 */
export function deleteBloggerWithCascade(id) {
  const d = getDb();
  const awemeIds = d.prepare('SELECT aweme_id FROM videos WHERE blogger_id = ?').all(id).map((r) => r.aweme_id);
  d.exec('BEGIN');
  try {
    if (awemeIds.length) {
      const ph = awemeIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM comments WHERE aweme_id IN (${ph})`).run(...awemeIds);
      d.prepare(`DELETE FROM analyses WHERE aweme_id IN (${ph})`).run(...awemeIds);
    }
    d.prepare('DELETE FROM reports WHERE blogger_id = ?').run(id);
    d.prepare('DELETE FROM videos WHERE blogger_id = ?').run(id);
    d.prepare('UPDATE scout_blogs SET monitored = 0 WHERE sec_uid = (SELECT sec_uid FROM bloggers WHERE id = ?)').run(id);
    d.prepare('DELETE FROM bloggers WHERE id = ?').run(id);
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { awemeIds, videoCount: awemeIds.length };
}

export function markBloggerChecked(id, error = null) {
  getDb()
    .prepare("UPDATE bloggers SET last_checked_at = datetime('now','localtime'), last_error = ? WHERE id = ?")
    .run(error, id);
}

export function insertVideo(bloggerId, v) {
  const d = getDb();
  const existing = d.prepare('SELECT id, downloaded, analyzed FROM videos WHERE aweme_id = ?').get(v.awemeId);
  if (existing) return { id: existing.id, isNew: false, ...existing };
  const r = d
    .prepare(
      `INSERT INTO videos (aweme_id, blogger_id, title, create_time, duration_sec,
        digg, comment_count, share, collect, play, play_url, cover, downloaded, video_path, transcript_path, transcript_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      v.awemeId,
      bloggerId,
      v.title ?? null,
      v.createTime ?? null,
      v.durationSec ?? null,
      v.stats?.digg ?? null,
      v.stats?.comment ?? null,
      v.stats?.share ?? null,
      v.stats?.collect ?? null,
      v.stats?.play ?? null,
      v.playUrl ?? null,
      v.cover ?? null,
      v.downloaded ? 1 : 0,
      v.videoPath ?? null,
      v.transcriptPath ?? null,
      v.transcriptText ?? null,
    );
  return { id: Number(r.lastInsertRowid), isNew: true, downloaded: 0, analyzed: 0 };
}

export function getVideoByAwemeId(awemeId) {
  return getDb().prepare('SELECT * FROM videos WHERE aweme_id = ?').get(awemeId);
}

export function listVideos(bloggerId, { limit = 100 } = {}) {
  return getDb()
    .prepare('SELECT * FROM videos WHERE blogger_id = ? ORDER BY create_time DESC LIMIT ?')
    .all(bloggerId, limit);
}

export function listAllVideos({ limit = 500 } = {}) {
  return getDb().prepare('SELECT * FROM videos ORDER BY create_time DESC LIMIT ?').all(limit);
}

export function updateVideo(awemeId, fields) {
  const allowed = ['title', 'digg', 'comment_count', 'share', 'collect', 'play', 'play_url', 'cover', 'downloaded', 'video_path', 'transcript_path', 'transcript_text', 'analyzed'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map((k) => `${k}=?`).join(', ');
  getDb()
    .prepare(`UPDATE videos SET ${set}, updated_at = datetime('now','localtime') WHERE aweme_id = ?`)
    .run(...keys.map((k) => fields[k]), awemeId);
}

export function replaceComments(awemeId, comments) {
  const d = getDb();
  // node:sqlite 没有 .begin() 封装，手动开事务
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM comments WHERE aweme_id = ?').run(awemeId);
    const ins = d.prepare(
      'INSERT OR IGNORE INTO comments (aweme_id, cid, nickname, content, digg, reply_count, create_time) VALUES (?,?,?,?,?,?,?)',
    );
    for (const c of comments) {
      ins.run(awemeId, c.cid, c.nickname ?? null, c.content ?? null, c.digg ?? 0, c.replyCount ?? 0, c.createTime ?? null);
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function listComments(awemeId, { limit = 50 } = {}) {
  return getDb()
    .prepare('SELECT * FROM comments WHERE aweme_id = ? ORDER BY digg DESC LIMIT ?')
    .all(awemeId, limit);
}

export function insertAnalysis({ awemeId, provider, model, kind = 'video', status = 'running', content = null, error = null, durationMs = null }) {
  const r = getDb()
    .prepare('INSERT INTO analyses (aweme_id, provider, model, kind, status, content, error, duration_ms) VALUES (?,?,?,?,?,?,?,?)')
    .run(awemeId, provider, model, kind, status, content, error, durationMs);
  return Number(r.lastInsertRowid);
}

export function updateAnalysis(id, fields) {
  const allowed = ['status', 'content', 'error', 'duration_ms'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map((k) => `${k}=?`).join(', ');
  getDb().prepare(`UPDATE analyses SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export function listAnalyses(awemeId) {
  return getDb()
    .prepare("SELECT * FROM analyses WHERE aweme_id = ? AND status != 'running' ORDER BY created_at")
    .all(awemeId);
}

export function upsertReport(bloggerId, reportDate, reportPath) {
  getDb()
    .prepare(
      `INSERT INTO reports (blogger_id, report_date, path) VALUES (?,?,?)
       ON CONFLICT(blogger_id, report_date) DO UPDATE SET path = excluded.path`,
    )
    .run(bloggerId, reportDate, reportPath);
}

export function listReports(bloggerId) {
  return getDb().prepare('SELECT * FROM reports WHERE blogger_id = ? ORDER BY report_date DESC').all(bloggerId);
}

export function startRun(type) {
  const r = getDb().prepare('INSERT INTO runs (type) VALUES (?)').run(type);
  return Number(r.lastInsertRowid);
}

export function finishRun(id, { status = 'success', summary = null, error = null } = {}) {
  getDb()
    .prepare("UPDATE runs SET status=?, finished_at=datetime('now','localtime'), summary=?, error=? WHERE id=?")
    .run(status, summary, error, id);
}

export function listRuns({ limit = 50 } = {}) {
  return getDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}
