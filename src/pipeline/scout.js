// 博主雷达：给定领域 → 海量发现博主 → 纯 HTTP 拉指标 → 双时点对比算涨粉率 → AI 评级潜力博主。
// 发现三通道：①关键词搜用户（discover/search，一次 20 位）②领域词搜视频取作者 ③种子博主粉丝扩展（预留）
// 潜力核心指标 growth = 平均点赞 / 粉丝数（算法推荐驱动、内容强于粉丝盘的信号）。
import { loadConfig } from '../core/config.js';
import {
  createScoutRun, insertScoutBlogs, finishScoutRun, getScoutRun, listScoutRuns, markScoutMonitored,
  getDb, getBloggerBySecUid,
} from '../core/db.js';
import * as api from '../data/signedApi.js';
import { chat } from '../llm/client.js';
import { logger } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用领域关键词生成搜索变体。 */
export function domainKeywords(domain) {
  const base = domain.trim();
  const set = new Set([base, `${base} 教程`, `${base} 干货`, `${base} 赚钱`, `${base} 起号`, `普通人 ${base}`, `${base} 推荐`]);
  return [...set];
}

/** 纯 HTTP 拉博主主页信息（粉丝/总赞/作品数/签名）。 */
async function fetchBlogDetail(secUid) {
  const p = await api.userProfile(secUid);
  if (!p) throw new Error('用户信息为空');
  return p;
}

function median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}
function avg(arr) {
  return arr?.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** 计算指标与规则分（0-100）。 */
function scoreBlog(b) {
  const avgLike = b.awemeCount ? Math.round((b.totalFavorited || 0) / b.awemeCount) : 0;
  // 赞粉比封顶 500%（防止小基数除零/失真）
  const heat = b.followerCount && b.followerCount >= 1000 ? Math.min(500, Math.round((avgLike / b.followerCount) * 1000) / 10) : 0;
  b.heatCapped = b.followerCount >= 1000 && heat >= 500;
  const recency = b.freshDays == null ? 5 : b.freshDays <= 7 ? 1 : b.freshDays <= 30 ? 2 : b.freshDays <= 60 ? 3 : b.freshDays <= 90 ? 4 : 5;
  const verifiedBoost = b.verified ? 8 : 0;
  let score = 0;
  score += Math.min(40, heat * 4); // 内容热度（赞粉比）最高 40
  score += Math.min(20, avgLike ? Math.log10(avgLike) * 5 : 0); // 互动规模
  score += (5 - recency) * 3; // 更新活跃
  score += Math.min(15, b.maxDigg ? Math.log10(b.maxDigg) * 3.75 : 0); // 爆款样本
  score += Math.min(10, (b.videoSamples || 0) * 1.5); // 数据厚度
  score = Math.round(Math.min(100, score + verifiedBoost));
  b.metrics = { heat, avgLike, maxDigg: b.maxDigg || 0, freshDays: b.freshDays };
  return score;
}

/** 规则评级（AI 可覆盖）。 */
function ruleRating(b) {
  const { followerCount, metrics } = b;
  if (!followerCount || followerCount < 1000) return '🌱 早期观察';
  if (b.freshDays != null && b.freshDays > 90) return '已停更';
  if (followerCount < 50000) return metrics.heat >= 5 ? '🚀 上升期黑马' : '📈 稳步成长';
  if (followerCount < 500000) return metrics.heat >= 2 ? '⭐ 赛道头部' : '🏔 成熟大号';
  return metrics.heat >= 1 ? '👑 头部标杆' : '🧊 巨头/低互动';
}

const AI_SYSTEM = `你是短视频赛道投资分析师。基于一个抖音博主的量化数据（粉丝数、平均点赞、赞粉比、更新频率、签名、代表作点赞），判断该博主在其赛道的定位与价值。
核心判断逻辑：
- growth(赞粉比) 高 + 粉丝绝对值低 = 潜力博主（算法认可、还有巨大增长空间，最值得学习/合作）
- 赞粉比高 + 粉丝中等 = 上升期黑马（正在起飞）
- 粉丝大 + 赞粉比低 = 成熟大号/停滞（学习其存量方法论，而非增长打法）
- 更新极不活跃 = 已停更/半退休
输出严格 JSON：{"rating":"潜力新星|上升期黑马|稳步成长|赛道头部|成熟大号|早期观察|已停更","score":0-100,"oneLine":"一句话点评（25字内）","why":"为什么，2-3句","learn":"值得学的1-2点","risk":"风险/短板"}`;

async function aiRate(provider, model, domain, b) {
  const user = `赛道：${domain}\n昵称：${b.nickname}\n粉丝：${b.followerCount}\n作品数：${b.awemeCount ?? '?'}\n总获赞：${b.totalFavorited ?? '?'}\n签名：${(b.signature || '无').slice(0, 60)}\n单条平均赞：${b.metrics.avgLike}\n赞粉比：${b.metrics.heat}%\n代表作最高赞：${b.metrics.maxDigg || '?'}\n最近更新：${b.metrics.freshDays ?? '?'} 天前${b.growth != null ? `\n对比上次涨粉：${b.growth > 0 ? '+' : ''}${b.growth}%` : ''}`;
  try {
    const r = await chat(provider, { model, system: AI_SYSTEM, user, temperature: 0.4, maxTokens: 900 });
    const j = JSON.parse(/```(?:json)?\s*([\s\S]*?)```/.exec(r.content)?.[1] || r.content);
    return j;
  } catch (e) {
    logger.warn(`[雷达] ${b.nickname} AI 评级失败: ${e.message.slice(0, 60)}`);
    return null;
  }
}

/**
 * 领域扫描全流程（任务队列里执行）。
 * @param {number|null} previousRunId 对比基线（上次扫描），用于算涨粉率
 */
export async function scoutDomain(domain, { keywords = null, limit = 20, previousRunId = null, onProgress } = {}) {
  const cfg = loadConfig();
  const provider = (cfg.llm.providers || []).find((p) => p.enabled !== false);
  const model = provider?.models?.scout || provider?.models?.synthesizer;
  const runId = createScoutRun(domain, keywords || domainKeywords(domain));
  const report = (step) => onProgress?.(step);

  try {
    // 1. 双通道发现：搜用户（海量一次 20 位）+ 搜视频取作者
    const kws = keywords?.length ? keywords : domainKeywords(domain);
    const authorMap = new Map(); // secUid -> {nickname, samples}
    const addAuthor = (sid, nickname, sample) => {
      if (!sid) return;
      if (!authorMap.has(sid)) authorMap.set(sid, { nickname: nickname || '', samples: [] });
      const entry = authorMap.get(sid);
      if (sample) entry.samples.push(sample);
      if (!entry.nickname && nickname) entry.nickname = nickname;
    };

    report({ stage: '搜索领域用户', detail: `关键词 ${kws.length} 组` });
    for (let ki = 0; ki < kws.length; ki++) {
      report({ stage: '搜索领域用户', current: ki, total: kws.length, detail: `「${kws[ki]}」` });
      try {
        const r = await api.searchUsers(kws[ki], { count: 20 });
        for (const u of r.users) addAuthor(u.secUid, u.nickname, null);
      } catch (e) {
        logger.warn(`[雷达] 用户搜索「${kws[ki]}」失败: ${e.message.slice(0, 50)}`);
      }
      await sleep(1500 + Math.random() * 1500);
      if (authorMap.size >= limit * 1.2) break;
    }
    // 视频搜索补充（带爆款样本数据）
    report({ stage: '搜索领域视频', detail: `已发现 ${authorMap.size} 位` });
    for (let ki = 0; ki < Math.min(kws.length, 3); ki++) {
      try {
        const r = await api.searchVideos(kws[ki], { count: 20 });
        for (const v of r.videos) {
          if (v.author?.secUid) addAuthor(v.author.secUid, v.author.nickname, { title: v.title, digg: v.stats?.digg || 0, createTime: v.createTime });
        }
      } catch (e) {
        logger.warn(`[雷达] 视频搜索「${kws[ki]}」失败: ${e.message.slice(0, 50)}`);
      }
      await sleep(1500 + Math.random() * 1500);
    }
    logger.info(`[雷达] 「${domain}」发现候选博主 ${authorMap.size} 位`);

    // 2. 逐个拉主页指标（纯 HTTP，快且稳）
    const candidates = [...authorMap.entries()].slice(0, limit);
    const enriched = [];
    let idx = 0;
    for (const [secUid, base] of candidates) {
      idx++;
      report({ stage: '拉取博主指标', current: idx - 1, total: candidates.length, detail: base.nickname || secUid.slice(0, 10) });
      try {
        const d = await fetchBlogDetail(secUid);
        // 爆款样本：来自视频搜索的作者聚合
        const samples = base.samples || [];
        const now = Math.floor(Date.now() / 1000);
        const freshDays = samples.some((s) => s.createTime) ? Math.round((now - Math.max(...samples.map((s) => s.createTime || 0))) / 86400) : null;
        const maxDigg = samples.length ? Math.max(...samples.map((s) => s.digg || 0)) : 0;
        enriched.push({
          secUid, nickname: d.nickname || base.nickname, signature: d.signature, avatar: d.avatar,
          followerCount: d.followerCount, verified: d.verified, awemeCount: d.awemeCount,
          totalFavorited: d.totalFavorited ?? samples.reduce((x, s) => x + s.digg, 0),
          videoSamples: samples.length, maxDigg, freshDays,
          monitored: Boolean(getBloggerBySecUid(secUid)),
        });
      } catch (e) {
        logger.warn(`[雷达] ${base.nickname || secUid.slice(0, 10)} 指标拉取失败: ${e.message.slice(0, 60)}`);
      }
      await sleep(800 + Math.random() * 1200);
    }

    // 3. 指标 + 规则分
    for (const b of enriched) b.score = scoreBlog(b);
    enriched.sort((a, b) => b.score - a.score);

    // 4. 对比基线算涨粉率
    let baselineMap = new Map();
    if (previousRunId) {
      const prev = getScoutRun(previousRunId);
      if (prev) baselineMap = new Map(prev.blogs.map((x) => [x.sec_uid, x]));
    }
    for (const b of enriched) {
      const prev = baselineMap.get(b.secUid);
      if (prev?.follower_count && b.followerCount) {
        b.growth = Math.round(((b.followerCount - prev.follower_count) / prev.follower_count) * 1000) / 10;
        b.prevFollower = prev.follower_count;
      } else b.growth = null;
    }

    // 5. AI 评级 TOP N
    if (model && provider) {
      const top = enriched.filter((b) => b.followerCount >= 1000).slice(0, 10);
      for (let i = 0; i < top.length; i++) {
        report({ stage: 'AI 潜力评级', current: i, total: top.length, detail: top[i].nickname });
        const ai = await aiRate(provider, model, domain, top[i]);
        if (ai) {
          top[i].aiAnalysis = JSON.stringify(ai);
          top[i].aiRating = ai.rating;
          top[i].aiScore = ai.score;
          top[i].finalScore = Math.round((ai.score * 0.7 + top[i].score * 0.3));
        } else {
          top[i].finalScore = top[i].score;
          top[i].aiRating = ruleRating(top[i]);
        }
        await sleep(800);
      }
    }
    for (const b of enriched) {
      if (b.finalScore === undefined) { b.finalScore = b.score; b.aiRating = ruleRating(b); }
    }
    enriched.sort((a, b) => b.finalScore - a.finalScore);

    // 6. 入库
    insertScoutBlogs(runId, enriched.map((b) => ({
      secUid: b.secUid, nickname: b.nickname, signature: b.signature, avatar: b.avatar,
      followerCount: b.followerCount, verified: b.verified, totalLike: b.totalFavorited,
      awemeCount: b.awemeCount, videoSamples: b.videoSamples,
      maxDigg: b.metrics.maxDigg, medianDigg: b.metrics.avgLike, heatRatio: b.metrics.heat, freshDays: b.metrics.freshDays,
      score: b.finalScore, rating: b.aiRating,
      aiAnalysis: b.aiAnalysis || JSON.stringify({ growth: b.growth, avgLike: b.metrics.avgLike }),
      monitored: b.monitored,
    })));
    // 存基线快照供下次对比
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`scout_baseline_${domain}`, JSON.stringify({ runId, at: Date.now(), blogs: Object.fromEntries(enriched.map((b) => [b.secUid, b.followerCount])) }));
    finishScoutRun(runId, { status: 'done' });
    logger.info(`[雷达] 「${domain}」完成：${enriched.length} 位博主`);
    return { runId, count: enriched.length };
  } catch (e) {
    finishScoutRun(runId, { status: 'error', error: e.message });
    throw e;
  }
}

export { listScoutRuns, getScoutRun, markScoutMonitored };
