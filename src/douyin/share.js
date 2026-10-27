// 抖音免登录解析链（从 聚合大搜索引擎/backend/app/providers/shortvideo.py 移植）
//
// 链路：分享链接/aweme_id → iesdouyin share 页（必须微信内置 UA）→ _ROUTER_DATA
//       → item_list[0] → 标题/作者/数据/播放地址；/playwm/ 换 /play/ 即无水印直链。
// 服务端是否下发数据有波动，因此内置重试。

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../core/logger.js';

const DOUYIN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(value) {
  return String(value ?? '').replace(/\u200b/g, '').trim();
}

// 抖音 share 页只有携带 ttwid 等 cookie 时才下发视频数据。
// 服务端在第一次请求（含重定向链）通过 Set-Cookie 种下 ttwid，第二次请求即可命中。
// Node fetch 不会跨请求保留 cookie，这里实现一个最小 cookie jar。
class CookieJar {
  #store = new Map();

  /** 收集响应的 Set-Cookie（含重定向中间跳）。 */
  capture(resp) {
    for (const raw of resp.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.#store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  header() {
    return [...this.#store].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** 手动跟随重定向的 fetch：每一跳都收 cookie、都带 cookie。 */
async function fetchWithCookies(url, { headers = {}, jar, timeoutMs = 20000, maxRedirects = 6 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resp = await fetch(current, {
      headers: { ...headers, ...(jar && jar.header() ? { Cookie: jar.header() } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar?.capture(resp);
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      current = new URL(resp.headers.get('location'), current).href;
      continue;
    }
    return resp;
  }
  throw new Error('重定向次数超限');
}

/** 从页面里抠出 _ROUTER_DATA JSON（大括号配对扫描，等价于 Python raw_decode）。 */
export function extractRouterData(html) {
  const marker = html.indexOf('_ROUTER_DATA');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function awemeIdFromUrl(url) {
  const patterns = [/\/video\/(\d{15,25})/, /\/note\/(\d{15,25})/, /modal_id=(\d{15,25})/, /(\d{18,20})/];
  for (const re of patterns) {
    const m = String(url || '').match(re);
    if (m) return m[1];
  }
  return null;
}

/** 跟随短链重定向，返回 (aweme_id, 最终URL)。 */
export async function resolveShortLink(url, { jar } = {}) {
  let final = url;
  if (/v\.douyin\.com|douyin\.com\/[A-Za-z0-9_\-]{4,16}\b/.test(url) && !/\/video\/|\/note\//.test(url)) {
    try {
      const resp = await fetchWithCookies(url, {
        headers: { 'User-Agent': DOUYIN_UA, Referer: 'https://www.douyin.com/' },
        jar,
      });
      final = resp.url;
      if (final === url) {
        const text = await resp.text();
        const m = text.match(/\/video\/(\d{15,25})/);
        if (m) return { awemeId: m[1], finalUrl: final };
      }
    } catch (e) {
      logger.warn('短链解析失败，尝试直接从 URL 提取:', e.message);
    }
  }
  return { awemeId: awemeIdFromUrl(final), finalUrl: final };
}

/** 请求 share 页并解析视频数据（item_list[0] 原始结构）。首次请求种 ttwid，重试后命中。 */
export async function fetchItemByAwemeId(awemeId, { retries = 6, jar } = {}) {
  let lastError = '抖音页面未返回视频数据（可能被风控限流）';
  for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
    try {
      const resp = await fetchWithCookies(`https://www.iesdouyin.com/share/video/${awemeId}/`, {
        headers: { 'User-Agent': DOUYIN_UA, Referer: 'https://www.douyin.com/' },
        jar,
      });
      if (resp.status !== 200) {
        lastError = `抖音页面 HTTP ${resp.status}`;
      } else {
        const data = extractRouterData(await resp.text());
        if (data) {
          const loader = data.loaderData || {};
          const pageKey = Object.keys(loader).find((k) => loader[k] && loader[k].videoInfoRes);
          const info = pageKey ? loader[pageKey].videoInfoRes || {} : {};
          const items = info.item_list || [];
          if (items.length) return items[0];
          lastError = `抖音接口无内容 (status_code=${info.status_code})`;
        } else {
          lastError = '页面无 _ROUTER_DATA';
        }
      }
    } catch (e) {
      lastError = `抖音请求失败: ${e.name}`;
    }
    await sleep(600 + attempt * 250);
  }
  throw new Error(lastError);
}

/** 把原始 item 归一化成监控系统需要的形状。 */
export function normalizeItem(item, awemeId) {
  const video = item.video || {};
  const author = item.author || {};
  const stats = item.statistics || {};
  const music = item.music || {};
  const playAddr = video.play_addr || {};
  const urls = (playAddr.url_list || []).filter(Boolean);
  const width = playAddr.width || video.width;
  const height = playAddr.height || video.height;

  let playUrl = null;
  let playUrlWatermarked = null;
  if (urls[0]) {
    if (urls[0].includes('/playwm/')) {
      playUrl = urls[0].replace('/playwm/', '/play/');
      playUrlWatermarked = urls[0];
    } else {
      playUrl = urls[0];
    }
  }

  const images = item.images || [];
  const cover =
    ((video.cover || {}).url_list || [])[0] || ((video.origin_cover || {}).url_list || [])[0] || null;
  const durationMs = video.duration || null;
  const createTime = item.create_time || null;

  return {
    platform: 'douyin',
    id: awemeId,
    awemeId,
    title: cleanText(item.desc) || `抖音视频 ${awemeId}`,
    author: cleanText(author.nickname),
    secUid: cleanText(author.sec_uid || author.uid),
    authorAvatar: ((author.avatar_thumb || {}).url_list || [])[0] || null,
    cover,
    durationMs,
    durationSec: durationMs ? Math.round(durationMs / 1000) : null,
    width,
    height,
    createTime, // unix 秒
    createTimeText: createTime ? new Date(createTime * 1000).toLocaleString('zh-CN') : null,
    musicTitle: cleanText(music.title),
    isGallery: images.length > 0,
    imageCount: images.length,
    stats: {
      digg: stats.digg_count ?? null,
      comment: stats.comment_count ?? null,
      share: stats.share_count ?? null,
      collect: stats.collect_count ?? null,
      play: stats.play_count ?? null,
    },
    playUrl, // 无水印直链（带时效签名，解析后要立刻下载）
    playUrlWatermarked,
    shareUrl: `https://www.iesdouyin.com/share/video/${awemeId}/`,
  };
}

/** 完整解析：输入分享链接或 aweme_id，返回归一化结果。 */
export async function parseShortVideo(urlOrId, { retries = 6 } = {}) {
  const jar = new CookieJar();
  let awemeId = /^\d{15,25}$/.test(String(urlOrId)) ? String(urlOrId) : null;
  let finalUrl = awemeId ? `https://www.iesdouyin.com/share/video/${awemeId}/` : String(urlOrId);
  if (!awemeId) {
    const resolved = await resolveShortLink(urlOrId, { jar });
    awemeId = resolved.awemeId;
    finalUrl = resolved.finalUrl;
  }
  if (!awemeId) throw new Error(`未能从链接中识别 aweme_id: ${urlOrId}`);
  const item = await fetchItemByAwemeId(awemeId, { retries, jar });
  const normalized = normalizeItem(item, awemeId);
  normalized.sourceUrl = finalUrl;
  return normalized;
}

/** 服务端下载文件到磁盘（直链带时效签名，解析后尽快调用）。 */
export async function downloadFile(url, filePath, { ua = DOUYIN_UA } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let resp = await fetch(url, {
    headers: { 'User-Agent': ua, Referer: 'https://www.douyin.com/' },
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok && resp.status !== 206 && ua !== DESKTOP_UA) {
    // 部分 CDN 对 UA 敏感，换桌面 UA 再试一次
    resp = await fetch(url, {
      headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.douyin.com/' },
      signal: AbortSignal.timeout(120000),
    });
  }
  if (!resp.ok && resp.status !== 206) throw new Error(`下载 HTTP ${resp.status}`);
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
  return filePath;
}

/** 下载归一化结果的视频，返回落盘路径。 */
export async function downloadVideo(item, dir, name) {
  if (item.isGallery) throw new Error('图集类型无视频直链可下载');
  if (!item.playUrl) throw new Error('解析结果中没有播放直链');
  const filePath = path.join(dir, `${name}.mp4`);
  await downloadFile(item.playUrl, filePath);
  return filePath;
}
