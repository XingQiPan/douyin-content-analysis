// 全局任务队列：串行执行（浏览器 profile 锁也要求串行），排队/进度/ETA 全可见。
import { logger } from './logger.js';

const jobs = []; // 新的在前的展示列表（截断保留 60 条）
const queue = [];
let running = null;
let processing = false;
let seq = 0;

export function enqueueJob({ type, label, bloggerId, run }) {
  const job = {
    id: ++seq,
    type, // 'check' | 'scheduled' | 'video' | 'download'
    label,
    bloggerId: bloggerId ?? null,
    status: 'queued', // queued | running | done | error
    enqueuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    stage: '排队中',
    current: 0,
    total: 0,
    detail: '',
    etaSec: null,
    error: null,
  };
  jobs.unshift(job);
  if (jobs.length > 60) jobs.length = 60;
  job._run = run;
  queue.push(job);
  pump();
  return job.id;
}

async function pump() {
  if (processing) return;
  const job = queue.shift();
  if (!job) return;
  processing = true;
  running = job;
  job.status = 'running';
  job.startedAt = Date.now();
  try {
    await job._run((step) => reportStep(job, step));
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    logger.error(`[任务#${job.id}] ${job.label} 失败: ${e.message}`);
  } finally {
    if (job.status === 'running') job.status = 'done';
    job.finishedAt = Date.now();
    running = null;
    processing = false;
    setImmediate(pump);
  }
}

function reportStep(job, { stage, current, total, detail, etaSec } = {}) {
  if (stage !== undefined) job.stage = stage;
  if (current !== undefined) job.current = current;
  if (total !== undefined) job.total = total;
  if (detail !== undefined) job.detail = detail;
  job.etaSec = etaSec ?? null;
}

/** 排队位置：queued 状态任务在队列中的序号（0 = 下一个）。 */
export function jobQueuePosition(job) {
  if (job.status !== 'queued') return -1;
  return queue.indexOf(job);
}

export function listJobs() {
  return jobs.map((j) => ({
    id: j.id,
    type: j.type,
    label: j.label,
    bloggerId: j.bloggerId,
    status: j.status,
    enqueuedAt: j.enqueuedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    stage: j.stage,
    current: j.current,
    total: j.total,
    detail: j.detail,
    etaSec: j.etaSec,
    error: j.error,
    queuePos: jobQueuePosition(j),
    runningNow: running === j,
  }));
}

export function queueStats() {
  return { queued: queue.length, running: processing ? 1 : 0 };
}
