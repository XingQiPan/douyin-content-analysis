// 视频转文字：ffmpeg 抽音轨（长视频截断）→ whisper CLI 转写。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');
const TRANSCRIPT_DIR = path.join(ROOT, 'data', 'transcripts');

function run(cmd, args, { timeoutMs = 3600000, shell = process.platform === 'win32' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} 超时`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let cudaCache;
/** 检测本机 torch 是否支持 CUDA（有 NVIDIA GPU 且装了 cu 版 torch 时返回 true）。 */
async function hasCuda() {
  if (cudaCache !== undefined) return cudaCache;
  try {
    const { code, stdout } = await run('python', ['-c', 'import torch; print(int(torch.cuda.is_available()))'], { timeoutMs: 60000, shell: false });
    cudaCache = code === 0 && stdout.trim().endsWith('1');
  } catch {
    cudaCache = false;
  }
  return cudaCache;
}

/**
 * 转写视频为文字。
 * @returns {{text: string, txtPath: string}}
 */
export async function transcribeVideo(videoPath, name, { model = 'small', maxMinutes = 15, device = 'auto' } = {}) {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const txtPath = path.join(TRANSCRIPT_DIR, `${name}.txt`);
  if (existsSync(txtPath)) {
    const text = readFileSync(txtPath, 'utf8').trim();
    if (text) {
      logger.info(`转写稿已存在，跳过: ${txtPath}`);
      return { text, txtPath };
    }
  }

  // 1. 抽音轨（16k 单声道 wav；长视频默认只取前 maxMinutes 分钟）
  const wavPath = path.join(TMP_DIR, `${name}.wav`);
  const maxSec = Math.round(maxMinutes * 60);
  logger.info(`ffmpeg 抽音轨: ${path.basename(videoPath)}`);
  const ff = await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', videoPath,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    ...(maxSec > 0 ? ['-t', String(maxSec)] : []),
    wavPath,
  ]);
  if (ff.code !== 0) throw new Error(`ffmpeg 失败: ${ff.stderr.slice(-300)}`);

  // 2. whisper 转写（GPU 可用时走 CUDA fp16，秒级完成；否则 CPU）
  const deviceFinal = device === 'auto' ? ((await hasCuda()) ? 'cuda' : 'cpu') : device;
  const useFp16 = deviceFinal === 'cuda';
  logger.info(`whisper(${model}, device=${deviceFinal}, fp16=${useFp16}) 转写中...`);
  const wp = await run('whisper', [
    wavPath,
    '--model', model,
    '--language', 'zh',
    '--output_format', 'txt',
    '--output_dir', TRANSCRIPT_DIR,
    '--device', deviceFinal,
    '--fp16', useFp16 ? 'True' : 'False',
  ], { timeoutMs: 7200000 });
  if (wp.code !== 0) throw new Error(`whisper 失败: ${wp.stderr.slice(-300)}`);

  const text = readFileSync(txtPath, 'utf8').trim();
  if (!text) throw new Error('转写结果为空');
  logger.info(`转写完成: ${text.length} 字 → ${txtPath}`);
  return { text, txtPath };
}
