// 本地面板：Express API + 静态单页前端。
import express from 'express';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, reloadConfig, CONFIG_PATH } from '../core/config.js';
import {
  getDb, listBloggers, upsertBlogger, getBloggerBySecUid, setBloggerEnabled, listVideos, getVideoByAwemeId,
  listComments, listAnalyses, listReports, listRuns, replaceComments, updateVideo,
} from '../core/db.js';
import { logger } from '../core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_PATH = path.join(ROOT, 'data', 'logs', 'app.log');

async function activeJobs() {
  const { listJobs } = await import('../core/jobs.js');
  return listJobs().filter((j) => j.status === 'queued' || j.status === 'running');
}

export async function startWeb() {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json());

  // 可选密码保护（config.web.password；同时兼容 WEB_PASSWORD 环境变量）
  const ACCESS_PW = String(cfg.web?.password || process.env.WEB_PASSWORD || '');
  if (ACCESS_PW) {
    const crypto = await import('node:crypto');
    const token = crypto.createHash('sha256').update(ACCESS_PW + 'douyin-monitor').digest('hex').slice(0, 32);
    const COOKIE = 'dm_auth';
    const isAuthed = (req) => (req.headers.cookie || '').split(';').map((x) => x.trim()).some((x) => x === `${COOKIE}=${token}`);
    const loginPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问验证</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#f5f5f7;font:14px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.card{background:#1c1c20;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px;width:320px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
h2{margin:0 0 16px;font-size:17px}input{width:100%;box-sizing:border-box;background:rgba(120,120,128,.16);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;color:inherit;font-size:14px;outline:none}
input:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.16)}button{width:100%;margin-top:12px;padding:10px;border:none;border-radius:999px;background:#0a84ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#ff453a;font-size:12.5px;margin-top:10px;min-height:16px}</style></head>
<body><form class="card" method="POST" action="/__auth"><h2>🔒 抖音监控面板</h2>
<input name="pw" type="password" placeholder="访问密码" autofocus autocomplete="current-password">
<button type="submit">进入</button><div class="err">{{ERR}}</div></form></body></html>`;
    app.post('/__auth', express.urlencoded({ extended: false }), (req, res) => {
      if (String(req.body?.pw || '') === ACCESS_PW) {
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return res.redirect('/');
      }
      res.status(401).send(loginPage.replace('{{ERR}}', '密码错误'));
    });
    app.use((req, res, next) => {
      if (isAuthed(req) || req.path === '/__auth') return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: '需要访问密码', needAuth: true });
      res.status(401).type('html').send(loginPage.replace('{{ERR}}', ''));
    });
    logger.info('[安全] 面板已启用访问密码保护');
  }

  // ---------- API ----------
  app.get('/api/bloggers', async (req, res) => {
    const active = await activeJobs();
    const rows = listBloggers()
      .filter((b) => !b.sec_uid.startsWith('__')) // 隐藏内部虚拟博主（选题分析池）
      .filter((b) => b.blogger_type !== 'competitor') // 竞品在独立视图管理
      .map((b) => ({
        ...b,
        video_count: listVideos(b.id, { limit: 1000 }).length,
        checking: active.some((j) => j.bloggerId === b.id && j.status === 'running'),
        queued: active.some((j) => j.bloggerId === b.id),
      }));
    res.json(rows);
  });

  app.post('/api/bloggers', (req, res) => {
    const { url, secUid, nickname } = req.body || {};
    const input = secUid || url || '';
    const m = String(input).match(/user\/([A-Za-z0-9_-]{20,})/) || String(input).match(/(MS4wLjABAAAA[A-Za-z0-9_-]+)/);
    const sid = m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(String(input).trim()) ? String(input).trim() : null;
    if (!sid) return res.status(400).json({ error: '无法从输入中识别 sec_uid，请粘贴博主主页链接' });
    if (getBloggerBySecUid(sid)) return res.status(409).json({ error: '该博主已在监控列表' });
    const id = upsertBlogger({ secUid: sid, nickname: nickname || null });
    res.json({ id, secUid: sid });
  });

  app.post('/api/bloggers/:id/toggle', (req, res) => {
    const b = listBloggers().find((x) => x.id === Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    setBloggerEnabled(b.id, !b.enabled);
    res.json({ ok: true, enabled: !b.enabled });
  });

  app.delete('/api/bloggers/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = listBloggers().find((x) => x.id === id);
    if (!b) return res.status(404).json({ error: 'not found' });
    // 先收集文件路径（级联删除后 videos 行就没了）
    const files = getDb()
      .prepare('SELECT video_path, transcript_path FROM videos WHERE blogger_id = ?')
      .all(id)
      .flatMap((v) => [v.video_path, v.transcript_path].filter(Boolean));
    const { deleteBloggerWithCascade } = await import('../core/db.js');
    const r = deleteBloggerWithCascade(id);
    const { unlink, stat } = await import('node:fs/promises');
    let freed = 0;
    for (const f of files) {
      try { freed += (await stat(f)).size; await unlink(f); } catch {}
    }
    logger.info(`[删除] 博主 ${b.nickname || b.sec_uid}：视频 ${r.videoCount} 条 / 文件释放 ${(freed / 1048576).toFixed(1)}MB`);
    res.json({ ok: true, videoCount: r.videoCount, freedMB: Math.round((freed / 1048576) * 10) / 10 });
  });

  app.post('/api/bloggers/:id/check', async (req, res) => {
    const b = listBloggers().find((x) => x.id === Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    const { enqueueJob, listJobs } = await import('../core/jobs.js');
    const active = listJobs().filter((j) => j.status === 'queued' || j.status === 'running');
    if (active.some((j) => j.bloggerId === b.id)) return res.status(409).json({ error: '该博主已有任务在队列中' });
    const c = loadConfig();
    const jobId = enqueueJob({
      type: 'check',
      label: `检查 · ${b.nickname || b.sec_uid.slice(0, 10)}`,
      bloggerId: b.id,
      run: async (report) => {
        const { checkBlogger } = await import('../pipeline/monitor.js');
        const r = await checkBlogger(b, { headless: c.monitor.headless ?? false, onProgress: report });
        logger.info(`[任务] ${b.nickname || b.sec_uid} 完成: 新${r.newVideos.length} 处理${r.processed.length} 失败${r.errors.length}`);
        return r;
      },
    });
    res.json({ ok: true, jobId, message: '已加入任务队列，可在总览页看进度' });
  });

  // ---------- 任务中心 ----------
  app.get('/api/jobs', async (req, res) => {
    const { listJobs, queueStats } = await import('../core/jobs.js');
    res.json({ jobs: listJobs().slice(0, 30), stats: queueStats() });
  });

  app.post('/api/check-all', async (req, res) => {
    const { enqueueJob } = await import('../core/jobs.js');
    const c = loadConfig();
    const bloggers = listBloggers({ enabledOnly: true });
    if (!bloggers.length) return res.status(400).json({ error: '没有启用的博主' });
    const { listJobs } = await import('../core/jobs.js');
    const active = listJobs().filter((j) => j.status === 'queued' || j.status === 'running');
    let queued = 0;
    for (const b of bloggers) {
      if (active.some((j) => j.bloggerId === b.id)) continue;
      enqueueJob({
        type: 'check',
        label: `检查 · ${b.nickname || b.sec_uid.slice(0, 10)}`,
        bloggerId: b.id,
        run: async (report) => {
          const { checkBlogger } = await import('../pipeline/monitor.js');
          return checkBlogger(b, { headless: c.monitor.headless ?? false, onProgress: report });
        },
      });
      queued++;
    }
    res.json({ ok: true, queued, message: `${queued} 个博主已入队` });
  });

  // ---------- 定时调度 ----------
  app.get('/api/scheduler', async (req, res) => {
    const s = await import('../core/scheduler.js');
    res.json({
      enabled: s.schedulerEnabled(),
      cron: s.schedulerCron(),
      nextRun: s.schedulerEnabled() ? s.nextRunAt() : null,
    });
  });

  app.post('/api/scheduler', async (req, res) => {
    const s = await import('../core/scheduler.js');
    try {
      s.setScheduler({ enabled: req.body?.enabled, cron: req.body?.cron });
      res.json({ ok: true, enabled: s.schedulerEnabled(), cron: s.schedulerCron(), nextRun: s.schedulerEnabled() ? s.nextRunAt() : null });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/scheduler/run-now', async (req, res) => {
    const s = await import('../core/scheduler.js');
    s.runNow();
    res.json({ ok: true });
  });

  // ---------- 博主雷达 ----------
  app.post('/api/scout/scan', async (req, res) => {
    const domain = String(req.body?.domain || '').trim();
    if (!domain) return res.status(400).json({ error: '请输入领域关键词' });
    const limit = Math.min(Math.max(Number(req.body?.limit) || 20, 5), 40);
    const { enqueueJob, listJobs } = await import('../core/jobs.js');
    const running = listJobs().find((j) => j.type === 'scout' && (j.status === 'running' || j.status === 'queued'));
    if (running) return res.status(409).json({ error: '已有雷达扫描在' + (running.status === 'running' ? '执行' : '排队') });
    const { getDb } = await import('../core/db.js');
    const baseline = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(`scout_baseline_${domain}`);
    let previousRunId = null;
    if (baseline) { try { previousRunId = JSON.parse(baseline.value).runId; } catch {} }
    enqueueJob({
      type: 'scout',
      label: `雷达 · ${domain.slice(0, 14)}`,
      run: async (report) => {
        const { scoutDomain } = await import('../pipeline/scout.js');
        return scoutDomain(domain, { limit, previousRunId, onProgress: report });
      },
    });
    res.json({ ok: true, message: `「${domain}」扫描已入队` + (previousRunId ? `（将对比上次基线算涨粉率）` : '') });
  });

  app.get('/api/scout/runs', async (req, res) => {
    const { listScoutRuns } = await import('../core/db.js');
    const { listJobs } = await import('../core/jobs.js');
    const active = listJobs().find((j) => j.type === 'scout' && (j.status === 'running' || j.status === 'queued'));
    res.json({ runs: listScoutRuns(), activeJob: active || null });
  });

  app.get('/api/scout/runs/:id', async (req, res) => {
    const { getScoutRun } = await import('../core/db.js');
    const run = getScoutRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  });

  app.delete('/api/scout/runs/:id', async (req, res) => {
    const { deleteScoutRun } = await import('../core/db.js');
    const n = deleteScoutRun(Number(req.params.id));
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  app.post('/api/scout/runs/:id/add', async (req, res) => {
    const secUid = String(req.body?.secUid || '');
    const nickname = String(req.body?.nickname || '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(secUid)) return res.status(400).json({ error: 'sec_uid 不合法' });
    const { upsertBlogger, getBloggerBySecUid, markScoutMonitored } = await import('../core/db.js');
    if (getBloggerBySecUid(secUid)) return res.status(409).json({ error: '已在监控列表' });
    // 雷达已拿到的资料一并带入，避免监控卡显示空白
    upsertBlogger({
      secUid, nickname: nickname || null,
      avatar: req.body?.avatar || null,
      signature: req.body?.signature || null,
      followerCount: req.body?.followerCount ?? null,
    });
    markScoutMonitored(Number(req.params.id), secUid);
    logger.info(`[雷达] 已加入监控: ${nickname || secUid.slice(0, 12)}`);
    res.json({ ok: true });
  });

  app.get('/api/scout/runs/:id/scatter', async (req, res) => {
    // 散点图数据：x=粉丝(log)，y=赞粉比，气泡=平均点赞
    const { getScoutRun } = await import('../core/db.js');
    const run = getScoutRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run.blogs
      .filter((b) => b.follower_count && b.heat_ratio != null)
      .map((b) => ({ name: b.nickname, x: b.follower_count, y: b.heat_ratio, z: b.total_like ? Math.round(b.total_like / Math.max(b.video_samples, 1)) : b.median_digg || 1, rating: b.rating, score: b.score, secUid: b.sec_uid })));
  });

  // ---------- 选题分析（关键词 → 爆款 → 报告） ----------
  app.post('/api/search/analyze', async (req, res) => {
    const keyword = String(req.body?.keyword || '').trim();
    const topN = Math.min(Math.max(Number(req.body?.topN) || 5, 0), 10);
    const listOnly = Boolean(req.body?.listOnly) || topN === 0;
    if (!keyword) return res.status(400).json({ error: '请输入搜索关键词' });
    const { enqueueJob, listJobs } = await import('../core/jobs.js');
    const running = listJobs().find((j) => j.type === 'search' && (j.status === 'running' || j.status === 'queued'));
    if (running) return res.status(409).json({ error: `已有搜索分析任务在${running.status === 'running' ? '执行' : '排队'}（${running.label}）` });
    const c = loadConfig();
    const { createSearchRun } = await import('../core/db.js');
    const runId = createSearchRun(keyword, listOnly ? 0 : topN);
    enqueueJob({
      type: 'search',
      label: listOnly ? `搜索 · ${keyword.slice(0, 14)}` : `选题分析 · ${keyword.slice(0, 14)}`,
      run: async (report) => {
        const { analyzeKeyword } = await import('../pipeline/search.js');
        return analyzeKeyword(keyword, { topN: listOnly ? 0 : topN, headless: c.monitor.headless ?? false, onProgress: report });
      },
    });
    res.json({ ok: true, runId, message: '已入队，可在下方看进度' });
  });

  app.get('/api/search/runs', async (req, res) => {
    const { listSearchRuns, getSearchReportPath } = await import('../core/db.js');
    const { listJobs } = await import('../core/jobs.js');
    const activeSearch = listJobs().find((j) => j.type === 'search' && (j.status === 'running' || j.status === 'queued'));
    const activeVideo = listJobs().filter((j) => j.type === 'video' && (j.status === 'running' || j.status === 'queued')).map((j) => ({ label: j.label, status: j.status, stage: j.stage }));
    const runs = listSearchRuns().map((r) => ({ ...r, hasReport: Boolean(getSearchReportPath(r.id)) }));
    res.json({ runs, activeJob: activeSearch ? { stage: activeSearch.stage, current: activeSearch.current, total: activeSearch.total, detail: activeSearch.detail, etaSec: activeSearch.etaSec, status: activeSearch.status, label: activeSearch.label } : null, activeVideos: activeVideo });
  });

  app.get('/api/search/runs/:id', async (req, res) => {
    const { getSearchRun, getSearchReportPath } = await import('../core/db.js');
    const run = getSearchRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({
      ...run,
      hasReport: Boolean(getSearchReportPath(run.id)),
      videos: run.videos.map((v) => ({ ...v, analyses: listAnalyses(v.aweme_id).filter((a) => a.status === 'success').length })),
    });
  });

  app.get('/api/search/runs/:id/report', async (req, res) => {
    const { getSearchReportPath } = await import('../core/db.js');
    const p = getSearchReportPath(Number(req.params.id));
    if (!p || !existsSync(p)) return res.status(404).json({ error: '报告尚未生成' });
    res.type('text/plain; charset=utf-8').send(readFileSync(p, 'utf8'));
  });

  app.delete('/api/search/runs/:id', async (req, res) => {
    const { deleteSearchRun, getSearchReportPath } = await import('../core/db.js');
    const reportPath = getSearchReportPath(Number(req.params.id));
    const n = deleteSearchRun(Number(req.params.id));
    if (!n) return res.status(404).json({ error: 'not found' });
    if (reportPath && existsSync(reportPath)) { try { await (await import('node:fs/promises')).unlink(reportPath); } catch {} }
    res.json({ ok: true });
  });

  app.get('/api/bloggers/:id/videos', (req, res) => {
    res.json(listVideos(Number(req.params.id), { limit: 200 }));
  });

  // ---------- 博主数据仪表盘 ----------
  const STOP = new Set(['的','了','是','在','我','你','他','她','它','这','那','就','都','能','会','要','有','没','不','很','还','把','被','给','和','与','或','吗','呢','吧','啊','哦','也','人','个','上','下','中','里','说','做','用','看','去','来','对','让','我们','你们','自己','什么','怎么','如何','一个','这个','那个','已经','现在','直接','全部','真的','为什么','可以','以及','等等','如果','因为','所以','但是','而且','一下','这些','那些','还是','就是','大家','东西','内容']);
  function titleKeywords(titles) {
    const freq = new Map();
    const bump = (w) => freq.set(w, (freq.get(w) || 0) + 1);
    for (const raw of titles.join(' ').replace(/#[^\s#]+/g, ' ').match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) || []) {
      if (/^[A-Za-z0-9]+$/.test(raw)) {
        if (raw.length >= 2 && raw.length <= 12 && !STOP.has(raw.toLowerCase())) bump(raw);
        continue;
      }
      const clean = raw.replace(/[0-9]+\.[0-9]+/g, '').replace(/[0-9]/g, '');
      for (const seg of clean.match(/[A-Za-z]+|[\u4e00-\u9fa5]+/g) || []) {
        if (/^[A-Za-z]+$/.test(seg)) {
          if (seg.length >= 2 && seg.length <= 12 && !STOP.has(seg.toLowerCase())) bump(seg);
        } else {
          for (let i = 0; i + 2 <= seg.length; i++) {
            const g = seg.slice(i, i + 2);
            if (STOP.has(g[0]) || STOP.has(g[1])) continue;
            bump(g);
          }
        }
      }
    }
    return [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w, c]) => ({ w, c }));
  }

  app.get('/api/bloggers/:id/stats', (req, res) => {
    const b = listBloggers().find((x) => x.id === Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    const vids = listVideos(b.id, { limit: 500 }).filter((v) => v.create_time);
    const num = (x) => Number(x) || 0;
    const now = Math.floor(Date.now() / 1000);
    const median = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((x, y) => x - y);
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };

    const diggs = vids.map((v) => num(v.digg));
    const totals = {
      videos: vids.length,
      digg: diggs.reduce((a, x) => a + x, 0),
      comment: vids.reduce((a, v) => a + num(v.comment_count), 0),
      share: vids.reduce((a, v) => a + num(v.share), 0),
      collect: vids.reduce((a, v) => a + num(v.collect), 0),
    };

    const v30 = vids.filter((v) => v.create_time >= now - 30 * 86400);
    const recent = [...vids].sort((x, y) => y.create_time - x.create_time).slice(0, 11);
    let avgGapDays = null;
    if (recent.length >= 2) {
      let gaps = 0;
      for (let i = 1; i < recent.length; i++) gaps += recent[i - 1].create_time - recent[i].create_time;
      avgGapDays = Math.round((gaps / 86400 / (recent.length - 1)) * 10) / 10;
    }

    // 近 12 周发布频率
    const weeks = [];
    for (let w = 11; w >= 0; w--) {
      const end = now - w * 7 * 86400;
      const start = end - 7 * 86400;
      weeks.push({
        label: `${new Date(start * 1000).getMonth() + 1}/${new Date(start * 1000).getDate()}`,
        count: vids.filter((v) => v.create_time >= start && v.create_time < end).length,
      });
    }

    // 点赞分布（对数段）
    const bins = [[0, 100], [100, 300], [300, 500], [500, 1000], [1000, 2000], [2000, 5000], [5000, Infinity]];
    const distribution = bins.map(([a, b2]) => ({
      label: b2 === Infinity ? `${a}+` : `${a}-${b2}`,
      count: diggs.filter((x) => x >= a && x < b2).length,
    }));

    // 发布时间习惯（周一=0）
    const hourDist = Array.from({ length: 24 }, (_, h) => ({ h, count: vids.filter((v) => new Date(v.create_time * 1000).getHours() === h).length }));
    const weekDist = Array.from({ length: 7 }, (_, d) => ({
      d,
      count: vids.filter((v) => (new Date(v.create_time * 1000).getDay() + 6) % 7 === d).length,
    }));

    const med = median(diggs.filter((x) => x > 0));
    const eng = {
      likeCollectRatio: totals.digg ? Math.round((totals.collect / totals.digg) * 100) / 100 : null,
      likeCommentRatio: totals.digg ? Math.round((totals.comment / totals.digg) * 100) / 100 : null,
      viralRate: vids.length ? diggs.filter((x) => x >= med * 3 && x > 0).length / vids.length : 0,
      medianDigg: med,
      avgDigg: vids.length ? Math.round(totals.digg / vids.length) : 0,
      bestDigg: diggs.length ? Math.max(...diggs) : 0,
    };

    const top = [...vids]
      .sort((a, b2) => num(b2.digg) - num(a.digg))
      .slice(0, 8)
      .map((v) => ({ awemeId: v.aweme_id, title: (v.title || '').replace(/\s+/g, ' ').slice(0, 22), digg: num(v.digg), collect: num(v.collect) }));

    const timeline = [...vids]
      .sort((a, b2) => a.create_time - b2.create_time)
      .slice(-60)
      .map((v) => ({ t: v.create_time, digg: num(v.digg), collect: num(v.collect), comment: num(v.comment_count), share: num(v.share) }));

    res.json({
      blogger: { id: b.id, nickname: b.nickname, followerCount: b.follower_count, lastCheckedAt: b.last_checked_at },
      totals,
      eng,
      v30Count: v30.length,
      avgGapDays,
      weeks,
      distribution,
      hourDist,
      weekDist,
      top,
      keywords: titleKeywords(vids.map((v) => v.title || '')),
      timeline,
    });
  });

  app.get('/api/videos/:awemeId', (req, res) => {
    const v = getVideoByAwemeId(req.params.awemeId);
    if (!v) return res.status(404).json({ error: 'not found' });
    res.json({
      ...v,
      hasFile: Boolean(v.video_path && existsSync(v.video_path)),
      comments: listComments(v.aweme_id, { limit: 50 }),
      analyses: listAnalyses(v.aweme_id),
    });
  });

  // 本地视频文件流（sendFile 自带 Range 支持，可拖进度条）
  app.get('/api/videos/:awemeId/file', (req, res) => {
    const v = getVideoByAwemeId(req.params.awemeId);
    if (!v || !v.video_path || !existsSync(v.video_path)) return res.status(404).json({ error: '视频文件不存在，请先下载' });
    res.sendFile(v.video_path, { acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // 触发下载原视频（免登录解析链路，后台执行）
  app.post('/api/videos/:awemeId/download', (req, res) => {
    const v = getVideoByAwemeId(req.params.awemeId);
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.video_path && existsSync(v.video_path)) return res.json({ ok: true, already: true });
    res.json({ ok: true, message: '下载已启动' });
    (async () => {
      const { parseShortVideo, downloadVideo } = await import('../data/share.js');
      const parsed = await parseShortVideo(v.aweme_id, { retries: 6 });
      if (parsed.isGallery) {
        logger.warn(`[web触发] ${v.aweme_id} 是图集，无可下载视频`);
        return;
      }
      const p = await downloadVideo(parsed, path.join(ROOT, 'data', 'videos'), v.aweme_id);
      updateVideo(v.aweme_id, { downloaded: 1, video_path: p, play_url: parsed.playUrl, cover: parsed.cover || v.cover });
      logger.info(`[web触发] ${v.aweme_id} 视频下载完成: ${p}`);
    })().catch((e) => logger.error(`[web触发] ${v.aweme_id} 下载失败: ${e.message}`));
  });

  app.post('/api/videos/analyze-batch', async (req, res) => {
    const ids = Array.isArray(req.body?.awemeIds) ? req.body.awemeIds.filter((x) => /^\d{15,25}$/.test(String(x))).slice(0, 10) : [];
    if (!ids.length) return res.status(400).json({ error: '需要 awemeIds 数组' });
    const { enqueueJob, listJobs } = await import('../core/jobs.js');
    const active = listJobs().filter((j) => j.type === 'video' && (j.status === 'queued' || j.status === 'running'));
    let n = 0;
    for (const id of ids) {
      if (active.some((j) => j.label.includes(id))) continue;
      if (!getVideoByAwemeId(id)) return res.status(404).json({ error: `视频不存在: ${id}` });
      const c = loadConfig();
      enqueueJob({
        type: 'video',
        label: `分析 ${id}`,
        run: async (report) => {
          const { processOneVideo } = await import('../pipeline/monitor.js');
          report({ stage: '深度分析', detail: id });
          return processOneVideo(id, { headless: c.monitor.headless ?? false });
        },
      });
      n++;
    }
    res.json({ ok: true, queued: n });
  });

  app.post('/api/videos/:awemeId/analyze', async (req, res) => {
    const v = getVideoByAwemeId(req.params.awemeId);
    if (!v) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, message: '分析已启动' });
    const { processOneVideo } = await import('../pipeline/monitor.js');
    processOneVideo(v.aweme_id, { force: Boolean(req.body?.force) })
      .then(() => logger.info(`[web触发] 视频 ${v.aweme_id} 分析完成`))
      .catch((e) => logger.error(`[web触发] 视频 ${v.aweme_id} 分析失败: ${e.message}`));
  });

  app.post('/api/videos/:awemeId/refresh-comments', async (req, res) => {
    const v = getVideoByAwemeId(req.params.awemeId);
    if (!v) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, message: '评论重抓已启动' });
    const { fetchVideoComments } = await import('../data/comments.js');
    const c = loadConfig();
    try {
      const comments = await fetchVideoComments(v.aweme_id, { target: c.monitor.topComments, headless: c.monitor.headless ?? false });
      replaceComments(v.aweme_id, comments);
      logger.info(`[web触发] 视频 ${v.aweme_id} 评论重抓完成: ${comments.length} 条`);
    } catch (e) {
      logger.error(`[web触发] 评论重抓失败: ${e.message}`);
    }
  });

  app.get('/api/reports/:bloggerId', (req, res) => {
    res.json(listReports(Number(req.params.bloggerId)));
  });

  app.get('/api/reports/:bloggerId/:date', (req, res) => {
    const r = listReports(Number(req.params.bloggerId)).find((x) => x.report_date === req.params.date);
    if (!r || !existsSync(r.path)) return res.status(404).json({ error: 'not found' });
    res.type('text/plain; charset=utf-8').send(readFileSync(r.path, 'utf8'));
  });

  app.get('/api/runs', (req, res) => res.json(listRuns({ limit: 50 })));

  // ---------- 登录（面板内扫码） ----------
  const { startLogin, cancelLogin, loginState, authStatus } = await import('./loginService.js');

  app.get('/api/auth/status', async (req, res) => {
    res.json(await authStatus({ force: req.query.force === '1' }));
  });

  app.post('/api/login/start', async (req, res) => {
    const r = await startLogin();
    if (!r.ok) return res.json({ ok: true, already: true, message: r.error }); // 已有会话时前端直接接管轮询
    res.json(r);
  });

  app.post('/api/login/cancel', (req, res) => {
    res.json(cancelLogin());
  });

  app.get('/api/login/status', (req, res) => {
    res.json(loginState());
  });

  // ---------- 设置（LLM provider / 监控参数） ----------
  const readConfigFile = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const writeConfigFile = (cfg) => writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

  app.get('/api/settings', (req, res) => {
    const cfg = readConfigFile();
    res.json({
      providers: cfg.llm?.providers || [],
      monitor: cfg.monitor || {},
      configPath: CONFIG_PATH,
    });
  });

  app.post('/api/settings', async (req, res) => {
    const { providers, monitor } = req.body || {};
    if (!Array.isArray(providers) || !providers.length) {
      return res.status(400).json({ error: '至少需要一个 LLM provider' });
    }
    for (const [i, p] of providers.entries()) {
      const n = `Provider ${i + 1}`;
      if (!p.baseUrl || !/^https?:\/\//.test(String(p.baseUrl).trim())) return res.status(400).json({ error: `${n}: baseUrl 必须是 http(s) 地址` });
      if (!p.apiKey || !String(p.apiKey).trim()) return res.status(400).json({ error: `${n}: apiKey 不能为空` });
      const analysts = (p.models?.analysts || []).map((s) => String(s).trim()).filter(Boolean);
      if (!analysts.length) return res.status(400).json({ error: `${n}: 至少填一个分析模型` });
      if (!String(p.models?.synthesizer || '').trim()) return res.status(400).json({ error: `${n}: 需要填综合模型` });
    }
    const cfg = readConfigFile();
    cfg.llm = {
      providers: providers.map((p) => ({
        id: String(p.id || `provider-${Date.now()}`).trim() || `provider-${Date.now()}`,
        baseUrl: String(p.baseUrl).trim().replace(/\/$/, ''),
        apiKey: String(p.apiKey).trim(),
        enabled: p.enabled !== false,
        models: {
          analysts: p.models.analysts.map((s) => String(s).trim()).filter(Boolean),
          synthesizer: String(p.models.synthesizer).trim(),
        },
      })),
    };
    if (monitor) {
      cfg.monitor = {
        ...cfg.monitor,
        cron: String(monitor.cron || cfg.monitor.cron || '0 9 * * *').trim(),
        topComments: Number(monitor.topComments) || 50,
        maxPagesPerBlogger: Number(monitor.maxPagesPerBlogger) || 2,
        maxVideosPerCheck: Number(monitor.maxVideosPerCheck) || 10,
        headless: Boolean(monitor.headless),
        proxy: String(monitor.proxy || 'auto'),
        keepVideoDays: Math.max(Number(monitor.keepVideoDays) || 0, 0),
        transcribe: {
          model: String(monitor.transcribe?.model || 'small'),
          maxMinutes: Number(monitor.transcribe?.maxMinutes) || 15,
        },
      };
    }
    writeConfigFile(cfg);
    reloadConfig();
    logger.info('[设置] config.json 已通过面板更新');
    // cron 变更同步到运行中的调度器
    try {
      const s = await import('../core/scheduler.js');
      s.setScheduler({ cron: cfg.monitor.cron });
    } catch (e) {
      logger.warn('[设置] 同步调度器失败:', e.message);
    }
    res.json({ ok: true, note: '已保存并立即生效（定时监控同步更新）' });
  });

  app.post('/api/settings/test', async (req, res) => {
    const { baseUrl, apiKey, model } = req.body || {};
    if (!baseUrl || !apiKey) return res.status(400).json({ error: '需要 baseUrl 和 apiKey' });
    const base = String(baseUrl).trim().replace(/\/$/, '');
    const auth = { Authorization: `Bearer ${String(apiKey).trim()}` };
    try {
      const r = await fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const j = await r.json();
        const models = (j.data || []).map((m) => m.id).filter(Boolean);
        return res.json({ ok: true, via: 'models', models });
      }
      // 部分端点没有 /models，退化用最小 chat 验证
      const c = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(15000),
      });
      if (c.ok) return res.json({ ok: true, via: 'chat', models: [] });
      return res.status(400).json({ error: `HTTP ${r.status}（/models）/ HTTP ${c.status}（chat），请检查地址和 key` });
    } catch (e) {
      res.status(400).json({ error: '连接失败: ' + e.message });
    }
  });

  app.post('/api/logs', (req, res) => {
    try {
      const data = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
      res.type('text/plain; charset=utf-8').send(data.slice(-Number(req.query.lines || 120)).join('\n'));
    } catch {
      res.type('text/plain').send('(暂无日志)');
    }
  });

  app.get('/api/videos/:awemeId/snapshots', async (req, res) => {
    const { listVideoSnapshots } = await import('../core/db.js');
    res.json(listVideoSnapshots(req.params.awemeId));
  });

  app.get('/api/bloggers/:id/follower-trend', async (req, res) => {
    const { listBloggerSnapshots } = await import('../core/db.js');
    res.json(listBloggerSnapshots(Number(req.params.id)));
  });

  app.post('/api/search/runs/:id/more', async (req, res) => {
    const { enqueueJob } = await import('../core/jobs.js');
    const runId = Number(req.params.id);
    enqueueJob({
      type: 'search',
      label: `加载更多 · run${runId}`,
      run: async (report) => {
        report({ stage: '加载更多结果', detail: '' });
        const { loadMoreSearch } = await import('../pipeline/search.js');
        return loadMoreSearch(runId, {});
      },
    });
    res.json({ ok: true });
  });

  app.get('/api/scout/runs/:id/trends', async (req, res) => {
    const { getDb } = await import('../core/db.js');
    const d = getDb();
    const rows = d.prepare(
      `SELECT sb.sec_uid, sb.follower_count, sr.created_at FROM scout_blogs sb
       JOIN scout_runs sr ON sr.id = sb.run_id
       WHERE sr.domain = (SELECT domain FROM scout_runs WHERE id = ?) AND sb.follower_count IS NOT NULL
       ORDER BY sr.created_at`,
    ).all(Number(req.params.id));
    const out = {};
    for (const r of rows) (out[r.sec_uid] ||= []).push({ date: r.created_at, follower: r.follower_count });
    res.json(out);
  });

  // ---------- 每日简报 ----------
  app.get('/api/briefings', async (req, res) => {
    const { listDailyBriefings } = await import('../core/db.js');
    res.json(listDailyBriefings());
  });

  app.get('/api/briefings/:date', async (req, res) => {
    const { getDailyBriefing } = await import('../core/db.js');
    const briefing = getDailyBriefing(req.params.date);
    if (!briefing) return res.status(404).json({ error: 'not found' });
    res.json(briefing);
  });

  app.post('/api/briefings/generate', async (req, res) => {
    const { generateDailyBriefing } = await import('../pipeline/briefing.js');
    try {
      const briefing = await generateDailyBriefing(req.body?.domain, req.body?.date || new Date().toISOString().slice(0, 10));
      res.json(briefing || { error: '无数据' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 创作工作台 ----------
  app.post('/api/creation/plan', async (req, res) => {
    const { planTopic } = await import('../pipeline/creation.js');
    try {
      const result = await planTopic(req.body?.topic, req.body?.references || []);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/creation/script', async (req, res) => {
    const { generateScript } = await import('../pipeline/creation.js');
    try {
      const result = await generateScript(req.body?.topic, req.body?.angle, req.body?.style || '干货');
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 竞品监控 ----------
  app.post('/api/bloggers/:id/type', async (req, res) => {
    const { setBloggerType } = await import('../core/db.js');
    setBloggerType(Number(req.params.id), req.body?.type || 'monitor', req.body?.threshold || 3);
    res.json({ ok: true });
  });

  app.get('/api/competitors', async (req, res) => {
    const { listCompetitors, listCompetitorAlerts } = await import('../core/db.js');
    res.json({
      competitors: listCompetitors(),
      alerts: listCompetitorAlerts({ limit: 20 }),
    });
  });

  app.post('/api/competitors/alerts/read', async (req, res) => {
    const { markAlertsRead } = await import('../core/db.js');
    markAlertsRead(req.body?.ids || []);
    res.json({ ok: true });
  });

  app.get('/api/disk-usage', async (req, res) => {
    const m = await import('../../scripts/clean.mjs');
    res.json(m.diskUsage());
  });

  app.get('/api/config-meta', (req, res) => {
    const c = loadConfig();
    const active = c.llm.providers.filter((p) => p.enabled !== false);
    res.json({
      cron: c.monitor.cron,
      analysts: active.flatMap((p) => p.models?.analysts || []),
      synthesizer: active.map((p) => p.models?.synthesizer).filter(Boolean),
      topComments: c.monitor.topComments,
      transcribeModel: c.monitor.transcribe?.model,
    });
  });

  // ---------- 静态前端 ----------
  app.use(express.static(path.join(ROOT, 'src', 'web', 'public')));

  const { host, port } = cfg.web;
  await new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const url = `http://${host}:${port}`;
  logger.info(`✅ 本地面板已启动: ${url}`);
  return url;
}
