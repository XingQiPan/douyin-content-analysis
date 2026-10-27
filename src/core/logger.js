// 简单日志：控制台带时间戳，同时追加写入 data/logs/app.log
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = path.join(ROOT, 'data', 'logs');

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

function line(level, args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? String(v) : v)) ?? String(a)))
    .join(' ');
  const row = `[${ts}] [${level}] ${text}`;
  console.log(row);
  try {
    appendFileSync(path.join(LOG_DIR, 'app.log'), row + '\n');
  } catch {}
}

export const logger = {
  info: (...args) => line('INFO', args),
  warn: (...args) => line('WARN', args),
  error: (...args) => line('ERROR', args),
  debug: (...args) => {
    if (process.env.DEBUG) line('DEBUG', args);
  },
};
