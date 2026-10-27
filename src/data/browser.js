// 开源版浏览器适配层 —— 本文件不含任何浏览器自动化逻辑。
//
// 本开源版不采集平台数据，也就没有可用的浏览器会话。这里的函数仅为兼容上层
// 登录/采集相关入口而存在，触发即返回"不支持"，给出明确提示。

/** 无浏览器可用：任何实质操作立即失败，并给出可读提示。 */
async function unsupported() {
  const e = new Error('浏览器采集在开源版不可用。本版聚焦数据分析可视化，数据通过 `npm run import` 从私有采集版导入。');
  e.code = 'OPENSOURCE_NO_BROWSER';
  throw e;
}

export const launchBrowser = () => unsupported();
export const isLoggedIn = () => unsupported(); // 桩：开源版无账号会话
export const closeBrowser = () => Promise.resolve();
export const acquireBrowserLock = async () => () => {};
export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export const randomDelay = (min, max) => Math.floor(min + Math.random() * (max - min));
export const humanScroll = () => Promise.resolve();