// 登录服务（开源版降级实现）。
//
// 私有版里这是「面板扫码登录抖音」的服务。本开源版不含采集与登录能力——
// 数据由 `npm run import` 注入，无需登录态。因此所有入口都返回明确提示，
// 不触发任何浏览器逻辑。

import { logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

const UNSUPPORTED = '开源版不含采集能力，无需登录。数据通过 npm run import 从私有采集环境注入。';

export function loginState() {
  return {
    running: false,
    loggedIn: false,
    message: UNSUPPORTED,
    qrDataUrl: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export async function startLogin() {
  logger.warn('[登录] 开源版不支持扫码登录：' + UNSUPPORTED);
  return { ok: false, error: UNSUPPORTED };
}

export function cancelLogin() {
  return { ok: true };
}

/** 登录态：开源版恒为未登录（无采集，无登录态）。 */
export async function authStatus({ force = false } = {}) {
  const cfg = loadConfig();
  return {
    loggedIn: false,
    checking: false,
    note: '开源版无需登录',
    message: UNSUPPORTED,
    passwordProtected: Boolean(cfg.web?.password),
  };
}