// 磁盘清理：tmp 过期文件 / 视频保留策略（配置 keepVideoDays）/ 日志轮转。
// daemon 启动时自动执行；也可 node scripts/clean.mjs 手动跑。
import { readdirSync, statSync, unlinkSync, existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/core/db.js';
import { loadConfig } from '../src/core/config.js';
import { logger } from '../src/core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const f of readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, f.name);
    n += f.isDirectory() ? dirSize(fp) : statSync(fp).size;
  }
  return n;
}

export function cleanAll({ applyVideos = true } = {}) {
  const cfg = loadConfig();
  const now = Date.now();
  const freed = { tmp: 0, videos: 0, logs: 0 };

  // 1. data/tmp：删 7 天前的文件
  const tmpDir = path.join(ROOT, 'data', 'tmp');
  if (existsSync(tmpDir)) {
    for (const f of readdirSync(tmpDir)) {
      try {
        const fp = path.join(tmpDir, f);
        if (now - statSync(fp).mtimeMs > 7 * DAY) {
          freed.tmp += statSync(fp).size;
          unlinkSync(fp);
        }
      } catch {}
    }
  }

  // 2. 视频保留策略：keepVideoDays > 0 时删除超期 mp4（保留 DB 记录与转写稿）
  const keepDays = Number(cfg.monitor?.keepVideoDays || 0);
  if (applyVideos && keepDays > 0) {
    const videoDir = path.join(ROOT, 'data', 'videos');
    if (existsSync(videoDir)) {
      const d = getDb();
      for (const f of readdirSync(videoDir)) {
        if (!f.endsWith('.mp4')) continue;
        const fp = path.join(videoDir, f);
        try {
          if (now - statSync(fp).mtimeMs > keepDays * DAY) {
            const awemeId = f.replace('.mp4', '');
            d.prepare('UPDATE videos SET video_path = NULL, downloaded = 0 WHERE aweme_id = ?').run(awemeId);
            freed.videos += statSync(fp).size;
            unlinkSync(fp);
          }
        } catch {}
      }
    }
  }

  // 3. 日志轮转：>20MB 归档为 .old
  const logPath = path.join(ROOT, 'data', 'logs', 'app.log');
  if (existsSync(logPath)) {
    const size = statSync(logPath).size;
    if (size > 20 * 1048576) {
      try {
        renameSync(logPath, logPath + '.old');
        freed.logs = size;
      } catch {}
    }
  }

  return { freed, usage: diskUsage() };
}

export function diskUsage() {
  const p = (sub) => path.join(ROOT, 'data', sub);
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  let videos = 0, videoCount = 0, transcripts = 0;
  const vDir = p('videos'), tDir = p('transcripts');
  if (existsSync(vDir)) for (const f of readdirSync(vDir)) { const s = statSync(path.join(vDir, f)); videos += s.size; if (f.endsWith('.mp4')) videoCount++; }
  if (existsSync(tDir)) for (const f of readdirSync(tDir)) transcripts += statSync(path.join(tDir, f)).size;
  let dbSize = 0;
  for (const f of ['monitor.db', 'monitor.db-wal', 'monitor.db-shm']) {
    const fp = p(f);
    if (existsSync(fp)) dbSize += statSync(fp).size;
  }
  return {
    videosMB: mb(videos), videoCount, transcriptsMB: mb(transcripts),
    tmpMB: mb(dirSize(p('tmp'))), dbMB: mb(dbSize),
    logsMB: mb(dirSize(p('logs'))),
    totalMB: mb(videos + transcripts + dirSize(p('tmp')) + dbSize + dirSize(p('logs'))),
    freeGB: (() => { try { return Math.round(statfsSync(ROOT).free / 1073741824 * 10) / 10; } catch { return null; } })(),
  };
}

// CLI 直接运行
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  getDb(); // 确保表存在
  const { freed, usage } = cleanAll();
  logger.info(`清理完成：tmp ${mb(freed.tmp)}MB，视频 ${mb(freed.videos)}MB，日志 ${mb(freed.logs)}MB`);
  console.log('当前占用:', JSON.stringify(usage, null, 1));
}
function mb(n) { return Math.round((n / 1048576) * 10) / 10; }
