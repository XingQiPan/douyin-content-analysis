// 开源版数据来源适配层 —— 本文件不含任何平台数据抓取与反向逻辑。
//
// 私有版里本模块做抖音关键词搜索，本开源版改为在已导入的 SQLite 数据里做
// 标题模糊匹配，返回与私有版一致的 `{ keyword, videos }` 结构。

import { getDb } from '../core/db.js';

function buildVideo(r) {
  return {
    awemeId: String(r.aweme_id),
    title: r.title,
    createTime: r.create_time,
    durationSec: r.duration_sec,
    cover: r.cover,
    stats: { digg: r.digg, comment: r.comment_count, share: r.share, collect: r.collect, play: r.play },
    author: { nickname: r.author_nick || null, secUid: r.author_sec || null },
    isGallery: 0,
    playUrl: r.play_url,
    transcriptText: r.transcript_text,
  };
}

/** 在已导入视频中按关键词模糊搜索（title 匹配，按点赞排序）。 */
export async function searchDouyin(keyword, { maxResults = 24, headless = true, onStatus } = {}) {
  const like = `%${keyword}%`;
  const rows = getDb()
    .prepare(`SELECT v.*, b.nickname author_nick, b.sec_uid author_sec
             FROM videos v LEFT JOIN bloggers b ON b.id = v.blogger_id
             WHERE v.title LIKE ? ORDER BY v.digg DESC LIMIT ?`)
    .all(like, maxResults);
  const videos = rows.map(buildVideo);
  return { keyword, videos, partial: false };
}

/** 兼容调用：开源版无搜索引擎桥接，与主路径相同（本地匹配）。 */
export async function searchDouyinBridge(keyword, { maxResults = 24 } = {}) {
  return searchDouyin(keyword, { maxResults });
}