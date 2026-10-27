// 开源版数据来源适配层 —— 本文件不含任何平台采集逻辑。
//
// 本开源版读取本地已导入的 SQLite 数据，返回与私有版形态一致的结构
// （blogger + videos），供上层监控编排复用。

import { getDb } from '../core/db.js';

/** 拉取博主资料 + 已导入的投稿列表（数据来自 monitor.db，非实时抓取）。 */
export async function fetchProfile(secUid, { maxPages = 2, headless = false, timeoutMs = 90000 } = {}) {
  const b = getDb().prepare('SELECT * FROM bloggers WHERE sec_uid = ?').get(secUid);
  if (!b) throw new Error(`博主不在已导入数据中: ${secUid}`);

  const blogger = {
    secUid,
    nickname: b.nickname,
    signature: b.signature,
    followerCount: b.follower_count,
    avatar: b.avatar,
  };

  const rows = getDb().prepare('SELECT * FROM videos WHERE blogger_id = ? ORDER BY create_time DESC').all(b.id);
  const videos = rows.map((r) => ({
    awemeId: String(r.aweme_id),
    title: r.title,
    createTime: r.create_time,
    durationSec: r.duration_sec,
    cover: r.cover,
    stats: { digg: r.digg, comment: r.comment_count, share: r.share, collect: r.collect, play: r.play },
    author: { nickname: blogger.nickname, secUid },
    isGallery: 0,
    playUrl: r.play_url,
    downloaded: r.downloaded,
    transcriptText: r.transcript_text,
  }));

  return { blogger, videos };
}

/** 兼容私有版的宽松 aweme 归一化：开源版数据已是规范结构，原样返回。 */
export function normalizeAweme(raw) {
  return raw || { awemeId: '', title: '', createTime: null, durationSec: null, cover: null, stats: {}, author: {}, isGallery: 0, playUrl: null };
}