// 开源版数据来源适配层 —— 本文件不含任何平台数据抓取与反向能力。
//
// 本开源版用本地已导入的 SQLite 数据完全替代平台接口：所有函数只读 monitor.db
// 里用户通过 `npm run import` 灌入的数据，返回与私有版相同形状的结构，保证上层
// 业务（AI 分析 / 雷达评分 / 选题报告）零改动可复用。
//
// 说明：本开源版不采集真实平台数据。要得到真实数据，请在你的私有采集环境
// （含完整采集层的私有版）中导出 JSON，再通过 `npm run import` 注入。

import { getDb } from '../core/db.js';

/** 读一条博主在库中的资料（私有版由接口返回）。 */
export async function userProfile(secUid) {
  const row = getDb().prepare('SELECT * FROM bloggers WHERE sec_uid = ?').get(secUid);
  if (!row) throw new Error(`博主不在已导入数据中: ${secUid}`);
  return {
    secUid,
    nickname: row.nickname,
    signature: row.signature,
    avatar: row.avatar,
    followerCount: row.follower_count,
    verified: 0,
    awemeCount: getDb().prepare('SELECT COUNT(*) c FROM videos WHERE blogger_id = ?').get(row.id).c,
    totalFavorited: null,
  };
}

/** 按关键词"搜索用户"：在已导入博主中按昵称/签名模糊匹配。 */
export async function searchUsers(keyword, { count = 20 } = {}) {
  const like = `%${keyword}%`;
  const rows = getDb()
    .prepare(`SELECT * FROM bloggers WHERE nickname LIKE ? OR signature LIKE ? LIMIT ?`)
    .all(like, like, count);
  return {
    users: rows.map((r) => ({
      secUid: r.sec_uid,
      nickname: r.nickname,
      followerCount: r.follower_count,
      signature: r.signature,
    })),
  };
}

/** 按关键词"搜索视频"：在已导入视频中按标题模糊匹配。 */
export async function searchVideos(keyword, { count = 20, offset = 0 } = {}) {
  const like = `%${keyword}%`;
  const rows = getDb()
    .prepare(`SELECT v.*, b.nickname author_nick, b.sec_uid author_sec FROM videos v LEFT JOIN bloggers b ON b.id = v.blogger_id
             WHERE v.title LIKE ? ORDER BY v.digg DESC LIMIT ? OFFSET ?`)
    .all(like, count, offset);
  return {
    videos: rows.map((r) => ({
      awemeId: String(r.aweme_id),
      title: r.title,
      createTime: r.create_time,
      durationSec: r.duration_sec,
      cover: r.cover,
      isGallery: 0,
      playUrl: null,
      stats: { digg: r.digg, comment: r.comment_count, share: r.share, collect: r.collect },
      author: { secUid: r.author_sec || null, nickname: r.author_nick || null },
    })),
    cursor: null,
    hasMore: false,
  };
}

/** 兼容私有版调用：加载更多。开源版数据一次性导入，无更多页。 */
export async function __loadMore() {
  return { videos: [], cursor: null, hasMore: false };
}