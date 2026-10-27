// 开源版数据来源适配层 —— 本文件不含任何平台采集逻辑。
//
// 私有版里这个模块是「登录态浏览器评论区抓取」，本开源版读取已导入的
// monitor.db 评论数据，返回与私有版一致的结构。

import { getDb } from '../core/db.js';

/** 读取某视频已导入的评论（数据来源于 `npm run import` 灌入的 JSON）。 */
export async function fetchVideoComments(awemeId, { target = 50, headless = false } = {}) {
  const rows = getDb()
    .prepare('SELECT * FROM comments WHERE aweme_id = ? ORDER BY digg DESC LIMIT ?')
    .all(String(awemeId), target);
  return rows.map((r) => ({
    cid: r.cid,
    nickname: r.nickname,
    content: r.content,
    digg: r.digg,
    reply_count: r.reply_count,
    create_time: r.create_time,
  }));
}