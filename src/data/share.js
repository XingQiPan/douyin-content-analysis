// 开源版数据来源适配层 —— 本文件不含任何平台解析或媒体下载逻辑。
//
// 本开源版不再下载任何平台视频：只读取 monitor.db 里已导入的视频记录。需要真实
// 视频文件做转写时，请在私有采集版完成转写后把 transcript_text / transcript_path
// 一并导入。

import { getDb } from '../core/db.js';

/** 解析一条已导入的视频（从本地库读取，非实时分享页解析）。 */
export async function parseShortVideo(awemeId, opts = {}) {
  const r = getDb().prepare('SELECT * FROM videos WHERE aweme_id = ?').get(String(awemeId));
  if (!r) throw new Error(`视频不在已导入数据中: ${awemeId}`);
  return {
    awemeId: String(r.aweme_id),
    title: r.title,
    createTime: r.create_time,
    durationSec: r.duration_sec,
    cover: r.cover,
    isGallery: 0,
    playUrl: r.play_url,
    videoPath: r.video_path,
    transcriptPath: r.transcript_path,
    transcriptText: r.transcript_text,
  };
}

/** 从 URL 提取 aweme_id（纯字符串处理，无网络请求）。 */
export function awemeIdFromUrl(url) {
  const m = String(url || '').match(/\/(?:video|note)\/(\d{15,25})/);
  return m ? m[1] : null;
}

/** 下载视频：开源版不下载任何平台内容。若库中已有视频文件则返回其路径，否则抛错提示。 */
export async function downloadVideo(parsed, dir, awemeId) {
  const r = getDb().prepare('SELECT video_path FROM videos WHERE aweme_id = ?').get(String(awemeId));
  if (r?.video_path) return r.video_path;
  const e = new Error('视频文件未在本地（本开源版不下载平台内容）。请在私有采集版下载/转写后，将 transcript_text 一并导入。');
  e.code = 'NO_LOCAL_FILE';
  throw e;
}