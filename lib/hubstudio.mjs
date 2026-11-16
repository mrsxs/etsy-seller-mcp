// HubStudio 本地接口（客户端开着并登录时监听 127.0.0.1:6873）：查环境状态、打开环境、找到环境浏览器的调试端口。
import { execFile } from 'node:child_process';
import { httpJson } from './cdp.mjs';

export class HubStudioError extends Error {}

export const HUBSTUDIO_API = () => (process.env.HUBSTUDIO_API || 'http://127.0.0.1:6873').replace(/\/+$/, '');

async function post(path, body, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${HUBSTUDIO_API()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HubStudioError('连不上 HubStudio 客户端（127.0.0.1:6873）：请打开 HubStudio 并登录');
  }
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) throw new HubStudioError(`HubStudio 接口出错：${json?.msg ?? `HTTP ${res.status}`}`);
  return json.data ?? {};
}

/** 已打开的环境：[{ containerCode, pid }] */
export async function openContainers(opts) {
  const data = await post('/api/v1/browser/all-browser-status', {}, opts);
  return (data.containers ?? []).map((c) => ({ containerCode: String(c.containerCode), pid: Number(c.pid) || null, status: c.status }));
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });

/** 某个进程在 127.0.0.1 上监听的端口 */
export async function listeningPorts(pid, platform = process.platform) {
  if (!pid) return [];
  if (platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    return [...out.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gim)].filter((m) => Number(m[2]) === pid).map((m) => Number(m[1]));
  }
  const out = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
  return [...out.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
}

/** 这个端口是不是 Chrome 调试端口 */
async function isDevtools(port) {
  try {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 2000 });
    return Boolean(v?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/**
 * 找到环境浏览器的调试端口：已打开就从它的进程找；没打开就通过 HubStudio 打开（不碰已打开环境的标签页）。
 */
export async function locatePort(containerCode, { log = () => {}, fetchImpl = fetch } = {}) {
  const code = String(containerCode);
  const open = (await openContainers({ fetchImpl })).find((c) => c.containerCode === code);
  if (open) {
    for (const port of await listeningPorts(open.pid)) if (await isDevtools(port)) return port;
    throw new HubStudioError(`HubStudio 环境 ${code} 已打开，但找不到它的浏览器调试端口：在 HubStudio 里关掉这个环境后重试（会自动重新打开）`);
  }
  log(`正在打开 HubStudio 环境 ${code}（先确认小火箭等代理已开，否则环境代理连不上）…`);
  const data = await post('/api/v1/browser/start', { containerCode: code }, { fetchImpl, timeoutMs: 120_000 });
  const port = Number(data.debuggingPort);
  if (!port) throw new HubStudioError('HubStudio 打开了环境，但没有返回调试端口');
  return port;
}
