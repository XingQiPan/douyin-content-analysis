#!/usr/bin/env node
// douyin content analysis —— 开源版 CLI 入口
// 命令：
//   npm run import -- <file.json>       导入本地数据（采集在私有版完成）
//   npm run download -- <链接|aweme_id> 免登录解析并下载单个公开视频
//   node src/index.js list              列出监控博主
//   node src/index.js enable|disable    启停博主
//   npm run analyze -- <aweme_id>       单视频补跑 AI 分析
//   npm run report -- <sec_uid>         立即生成今日日报
//   npm run web                         本地面板（含雷达/选题/可视化）
//   npm run daemon                      定时调度（cron 见 config.json）
import { listBloggers, setBloggerEnabled, listVideos, getBloggerBySecUid } from './core/db.js';
import { logger } from './core/logger.js';

const [, , cmd, ...args] = process.argv;

function extractSecUid(input) {
  if (!input) return null;
  const s = String(input);
  const m = s.match(/user\/([A-Za-z0-9_-]{20,})/) || s.match(/(MS4wLjABAAAA[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s.trim())) return s.trim();
  return null;
}

// 采集类命令在开源版不支持：本版数据通过 npm run import 从私有采集版注入。
function collectionUnsupported() {
  console.error('该命令属于「采集」能力，开源版不提供。本版聚焦数据分析与可视化。');
  console.error('请在你的私有采集环境（含采集层的完整项目）中完成后，用 `npm run import -- <file.json>` 把数据导入本版本。');
  process.exit(2);
}

async function main() {
  switch (cmd) {
    // 以下覆盖「登录/添加博主/即时检查」等采集相关命令，统一提示
    case 'login':
    case 'add':
    case 'check':
      collectionUnsupported();
      break;

    case 'list': {
      const rows = listBloggers();
      if (!rows.length) {
        console.log('（空）还没有博主，用 `npm run import -- <file.json>` 导入已采集的数据。');
        return;
      }
      for (const b of rows) {
        const vids = listVideos(b.id, { limit: 1000 }).length;
        console.log(
          `#${b.id} ${b.enabled ? '✅' : '⛔'} ${b.nickname || '(无昵称)'}  粉丝:${b.follower_count ?? '?'}  视频数:${vids}${b.last_error ? `  ⚠️ ${b.last_error.slice(0, 50)}` : ''}`,
        );
        console.log(`    sec_uid: ${b.sec_uid}`);
      }
      break;
    }

    case 'enable':
    case 'disable': {
      const b = getBloggerBySecUid(extractSecUid(args[0]) || '') || listBloggers().find((x) => String(x.id) === args[0]);
      if (!b) {
        console.error('未找到博主（传 sec_uid 或 list 里的编号）');
        process.exit(1);
      }
      setBloggerEnabled(b.id, cmd === 'enable');
      logger.info(`已${cmd}博主 ${b.nickname || b.sec_uid}`);
      break;
    }

    case 'download': {
      // 免登录解析并下载单个公开视频（不依赖登录态）
      if (!args[0]) {
        console.error('用法: npm run download -- <分享链接 或 aweme_id>');
        process.exit(1);
      }
      const { parseShortVideo, downloadVideo, awemeIdFromUrl } = await import('./douyin/share.js');
      const { mkdirSync } = await import('node:fs');
      const path_ = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const ROOT = path_.resolve(path_.dirname(fileURLToPath(import.meta.url)), '..');
      const parsed = await parseShortVideo(args[0], { retries: 6 });
      if (parsed.isGallery) {
        console.log(`是图集「${parsed.title}」，无视频直链可下载。`);
        process.exit(0);
      }
      const dir = path_.join(ROOT, 'data', 'videos');
      mkdirSync(dir, { recursive: true });
      const awemeId = parsed.awemeId || awemeIdFromUrl(args[0]);
      const filePath = await downloadVideo(parsed, dir, awemeId);
      logger.info(`✅ 视频下载完成: ${filePath}`);
      console.log(`标题: ${parsed.title}`);
      console.log(`链接: ${parsed.playUrl}`);
      break;
    }

    case 'analyze': {
      if (!args[0]) {
        console.error('用法: npm run analyze -- <aweme_id 或视频链接>');
        process.exit(1);
      }
      const { awemeIdFromUrl } = await import('./douyin/share.js');
      let awemeId = /^\d{15,25}$/.test(args[0]) ? args[0] : awemeIdFromUrl(args[0]);
      if (!awemeId) {
        console.error('无法解析 aweme_id');
        process.exit(1);
      }
      const { processOneVideo } = await import('./pipeline/monitor.js');
      const force = args.includes('--force');
      await processOneVideo(awemeId, { force });
      logger.info(`✅ 视频 ${awemeId} 分析完成，可用 npm run web 查看`);
      break;
    }

    case 'report': {
      const b = getBloggerBySecUid(extractSecUid(args[0]) || '') || listBloggers().find((x) => String(x.id) === args[0]);
      if (!b) {
        console.error('未找到博主');
        process.exit(1);
      }
      const { generateDailyReport } = await import('./report/daily.js');
      const vids = listVideos(b.id, { limit: args[1] ? Number(args[1]) : 5 });
      const date = args[2] || new Date().toISOString().slice(0, 10);
      const path = generateDailyReport(b.id, vids.map((v) => v.aweme_id), date);
      logger.info(`日报: ${path}`);
      break;
    }

    case 'web': {
      const { startWeb } = await import('./web/server.js');
      await startWeb();
      break;
    }

    case 'daemon': {
      logger.info('守护进程启动：定时调度 + 本地面板');
      try {
        const { cleanAll } = await import('./scripts/clean.mjs');
        const { freed } = cleanAll();
        if (freed.tmp || freed.videos || freed.logs) logger.info(`[启动清理] tmp ${(freed.tmp/1048576).toFixed(1)}MB / 视频 ${(freed.videos/1048576).toFixed(1)}MB / 日志 ${(freed.logs/1048576).toFixed(1)}MB`);
      } catch (e) { logger.warn('[启动清理] 失败:', e.message); }
      const { startWeb } = await import('./web/server.js');
      const url = await startWeb();
      logger.info(`✅ 面板: ${url}`);
      const { initScheduler } = await import('./core/scheduler.js');
      initScheduler();
      setInterval(() => {}, 1 << 30);
      break;
    }

    default:
      console.log(`douyin content analysis —— 抖音博主内容数据分析框架（开源版）

用法:
  npm run import -- <file.json>         导入已采集的数据到本地库
  node src/index.js list                查看博主列表
  node src/index.js enable|disable <id|sec_uid>   启停博主
  npm run download -- <链接|aweme_id>    免登录解析并下载单个公开视频
  npm run analyze -- <aweme_id>         对已导入视频补跑 AI 分析（--force 重跑）
  npm run report -- <id> [条数]          立即生成日报
  npm run web                           本地面板（监控/雷达/选题/日报/可视化）
  npm run daemon                        定时调度 + 面板

注：本开源版含免登录视频下载；博主/评论/搜索等登录态采集请用私有版后 npm run import 导入。`);
  }
}

main().catch((e) => {
  logger.error(e.stack || e.message);
  process.exit(1);
});