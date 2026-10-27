// 每日分析报告生成：当轮新视频的多模型分析并排 + 综合结论 + 近 30 天趋势。
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getVideoByAwemeId, getBloggerById, listAnalyses, listVideos, upsertReport, listComments } from '../core/db.js';
import { logger } from '../core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fmtTime(unix) {
  return unix ? new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知';
}

function safeName(name) {
  return String(name || 'unknown').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40) || 'unknown';
}

/** 单视频小节：数据 + 各模型分析（JSON 转可读 markdown）+ 综合结论。 */
function videoSection(video, analyses) {
  const lines = [];
  const t = (video.title || '无标题').replace(/\s+/g, ' ');
  lines.push(`## [${t}](https://www.douyin.com/video/${video.aweme_id})`);
  lines.push('');
  lines.push(`- 发布：${fmtTime(video.create_time)} ｜ 时长 ${video.duration_sec ?? '?'}s`);
  lines.push(
    `- 数据：👍 ${video.digg ?? '?'} ｜ 💬 ${video.comment_count ?? '?'} ｜ 🔁 ${video.share ?? '?'} ｜ ⭐ ${video.collect ?? '?'}${video.play ? ` ｜ ▶ ${video.play}` : ''}`,
  );
  lines.push('');

  const synth = analyses.filter((a) => a.kind === 'synthesis' && a.status === 'success');
  const analysts = analyses.filter((a) => a.kind === 'video' && a.status === 'success');

  if (synth.length) {
    lines.push('### 🎯 综合结论');
    lines.push('');
    lines.push(synth[synth.length - 1].content || '');
    lines.push('');
  }

  if (analysts.length) {
    lines.push('<details>');
    lines.push(`<summary><b>各模型原始拆解（${analysts.length} 个模型）</b> —— 点击展开</summary>`);
    lines.push('');
    for (const a of analysts) {
      lines.push(`#### ${a.model}`);
      lines.push('');
      // 尝试把 JSON 渲染成易读形式
      try {
        const j = JSON.parse(a.content);
        lines.push('```json');
        lines.push(JSON.stringify(j, null, 2));
        lines.push('```');
      } catch {
        lines.push(a.content || '');
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  const errors = analyses.filter((a) => a.status === 'error');
  if (errors.length) {
    lines.push(`> ⚠️ 失败模型：${errors.map((e) => `${e.model}（${e.error?.slice(0, 60)}）`).join('、')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 近 30 天趋势小节。 */
function trendSection(bloggerId) {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const vids = listVideos(bloggerId, { limit: 200 }).filter((v) => v.create_time >= since && v.digg != null);
  if (!vids.length) return '';
  const lines = ['## 📈 近 30 天趋势', ''];
  const total = vids.length;
  const avg = (k) => {
    const vals = vids.map((v) => v[k]).filter((x) => x != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };
  lines.push(`- 近 30 天发布 **${total}** 条（平均 ${Math.round(30 / Math.max(total, 1)).toFixed(1)} 天/条）`);
  lines.push(`- 平均点赞 ${avg('digg')} ｜ 平均评论 ${avg('comment_count')} ｜ 平均收藏 ${avg('collect')} ｜ 平均分享 ${avg('share')}`);
  const best = [...vids].sort((a, b) => (b.digg ?? 0) - (a.digg ?? 0))[0];
  if (best) lines.push(`- 最佳表现：[${best.title?.slice(0, 30) || best.aweme_id}](https://www.douyin.com/video/${best.aweme_id}) 👍${best.digg}（${fmtTime(best.create_time)}）`);
  lines.push('');
  lines.push('| # | 发布时间 | 标题 | 赞 | 评 | 藏 | 转 |');
  lines.push('|---|---------|------|----|----|----|----|');
  vids.slice(0, 15).forEach((v, i) => {
    const t = (v.title || '').replace(/\|/g, '/').slice(0, 28) || v.aweme_id;
    lines.push(`| ${i + 1} | ${fmtTime(v.create_time).slice(0, 10)} | [${t}](https://www.douyin.com/video/${v.aweme_id}) | ${v.digg} | ${v.comment_count} | ${v.collect} | ${v.share} |`);
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成某博主某天的分析日报。
 * @param {number} bloggerId
 * @param {string[]} awemeIds 当天要写进报告的视频
 * @param {string} dateStr YYYY-MM-DD
 */
export function generateDailyReport(bloggerId, awemeIds, dateStr = new Date().toISOString().slice(0, 10)) {
  const blogger = getBloggerById(bloggerId);
  if (!blogger) throw new Error(`博主不存在: ${bloggerId}`);
  const dir = path.join(ROOT, 'reports', safeName(blogger.nickname || blogger.sec_uid));
  mkdirSync(dir, { recursive: true });

  const lines = [];
  const fanW = blogger.follower_count ? ` · 粉丝 ${(blogger.follower_count / 10000).toFixed(1)}w` : '';
  lines.push(`# 📊 ${blogger.nickname || blogger.sec_uid} 分析日报 · ${dateStr}`);
  lines.push('');
  lines.push(`> ${fanW ? `粉丝 ${fanW.replace(' · 粉丝 ', '')} · ` : ''}本轮分析 **${awemeIds.length}** 条视频 · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  lines.push('');

  for (const awemeId of awemeIds) {
    const video = getVideoByAwemeId(awemeId);
    if (!video) continue;
    const analyses = listAnalyses(awemeId);
    lines.push(videoSection(video, analyses));
    lines.push('---');
    lines.push('');
  }

  const trend = trendSection(bloggerId);
  if (trend) {
    lines.push(trend);
    lines.push('---');
    lines.push('');
  }

  let analystNames = '';
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    analystNames = (cfg.llm.providers[0].models?.analysts || []).join(' / ');
  } catch {}
  lines.push(`*由 douyin-monitor 多模型自动分析生成${analystNames ? `：${analystNames}` : ''}*`);

  const filePath = path.join(dir, `${dateStr}.md`);
  writeFileSync(filePath, lines.join('\n'), 'utf8');
  upsertReport(bloggerId, dateStr, filePath);
  logger.info(`日报已生成: ${filePath}`);
  return filePath;
}
