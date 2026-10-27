// 定时调度：cron 可在运行期修改/暂停，状态持久化到 meta 表，面板可见下次运行时间。
import cron from 'node-cron';
import { getMeta, setMeta, listBloggers } from './db.js';
import { loadConfig } from './config.js';
import { enqueueJob } from './jobs.js';
import { logger } from './logger.js';

let task = null;

export function schedulerCron() {
  return getMeta('scheduler_cron') || loadConfig().monitor.cron || '0 9 * * *';
}

export function schedulerEnabled() {
  return getMeta('scheduler_enabled') !== '0';
}

export function initScheduler() {
  register(schedulerCron());
}

function register(cronExpr) {
  if (task) {
    try { task.stop(); } catch {}
    task = null;
  }
  if (!cron.validate(cronExpr)) {
    logger.error(`[调度] 无效 cron: ${cronExpr}，保留原调度`);
    return false;
  }
  task = cron.schedule(cronExpr, () => triggerScheduled('定时触发'));
  setMeta('scheduler_cron', cronExpr);
  if (!schedulerEnabled()) {
    try { task.stop(); } catch {}
  }
  logger.info(`[调度] 已注册: ${cronExpr}${schedulerEnabled() ? '' : '（暂停中）'}`);
  return true;
}

function triggerScheduled(reason) {
  if (!schedulerEnabled()) return;
  const allBloggers = listBloggers({ enabledOnly: true });
  const bloggers = allBloggers.filter((b) => b.blogger_type !== 'competitor');
  const competitors = allBloggers.filter((b) => b.blogger_type === 'competitor');
  if (!bloggers.length && !competitors.length) {
    logger.info('[调度] 没有启用的博主，跳过');
    return;
  }
  logger.info(`⏰ ${reason}：${bloggers.length} 个博主已入队`);
  for (const b of bloggers) {
    enqueueJob({
      type: 'scheduled',
      label: `定时检查 · ${b.nickname || b.sec_uid.slice(0, 10)}`,
      bloggerId: b.id,
      run: async (report) => {
        const { checkBlogger } = await import('../pipeline/monitor.js');
        await checkBlogger(b, { onProgress: report });
      },
    });
  }
  
  // 竞品也检查（轻量模式：只抓元数据+快照）
  for (const b of competitors) {
    enqueueJob({
      type: 'scheduled',
      label: `竞品检查 · ${b.nickname || b.sec_uid.slice(0, 10)}`,
      bloggerId: b.id,
      run: async (report) => {
        const { checkBlogger } = await import('../pipeline/monitor.js');
        await checkBlogger(b, { onProgress: report });
      },
    });
  }

  // 每日简报（每天 9 点生成）
  if (reason === '定时触发') {
    enqueueJob({
      type: 'briefing',
      label: '每日赛道简报',
      run: async (report) => {
        const { generateDailyBriefing } = await import('../pipeline/briefing.js');
        const date = new Date().toISOString().slice(0, 10);
        report({ stage: '生成简报', detail: date });
        await generateDailyBriefing(null, date);
      },
    });
  }
}

export function runNow() {
  triggerScheduled('手动一键监控');
}

export function setScheduler({ enabled, cron: cronExpr } = {}) {
  if (cronExpr !== undefined) {
    if (!register(cronExpr)) throw new Error(`无效的 cron 表达式: ${cronExpr}`);
  }
  if (enabled !== undefined) {
    setMeta('scheduler_enabled', enabled ? '1' : '0');
    if (task) {
      if (enabled) task.start();
      else task.stop();
    }
    logger.info(`[调度] 定时监控已${enabled ? '启用' : '暂停'}`);
  }
}

/** 计算下次运行时间（支持星号、步进、数字、列表、区间；向前搜索 48 小时）。 */
export function nextRunAt(cronExpr = schedulerCron()) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mm, hh, dom, mon, dow] = parts;
  const fieldMatch = (expr, val, lo, hi) => {
    if (expr === '*') return true;
    for (const part of expr.split(',')) {
      let step = 1;
      let base = part;
      if (part.startsWith('*/')) { step = Number(part.slice(2)) || 1; base = '*'; }
      let a = lo, b = hi;
      if (base !== '*') {
        const rng = base.split('-');
        a = Number(rng[0]); b = rng[1] !== undefined ? Number(rng[1]) : a;
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
      }
      if (val >= a && val <= b && (val - a) % step === 0) return true;
    }
    return false;
  };
  const d = new Date();
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 48; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (!fieldMatch(mm, d.getMinutes(), 0, 59)) continue;
    if (!fieldMatch(hh, d.getHours(), 0, 23)) continue;
    if (!fieldMatch(mon, d.getMonth() + 1, 1, 12)) continue;
    const domOk = fieldMatch(dom, d.getDate(), 1, 31);
    const dowOk = fieldMatch(dow, (d.getDay() + 7) % 7 || 7, 1, 7); // 0/7 都当周日
    const domRestricted = dom !== '*';
    const dowRestricted = dow !== '*';
    if (domRestricted && dowRestricted) { if (!(domOk || dowOk)) continue; }
    else if (!domOk || !dowOk) continue;
    return d.getTime();
  }
  return null;
}
