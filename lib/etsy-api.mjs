// Etsy Open API v3 请求：带应用身份（x-api-key）和店铺令牌（Bearer），本进程内限速，429 按 retry-after 等一次，
// 401 时作废令牌重换一次；上传类接口（图片 / 视频 / 文件）读本机文件或下载 https 地址后用 multipart 发送。
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { binaryFields, buildPath, encodeBody, SpecError } from './spec.mjs';
import { apiKeyHeader, appFor } from './oauth.mjs';

export const API_BASE = 'https://api.etsy.com';

export class ApiError extends Error {
  constructor(message, { status, operation } = {}) {
    super(message);
    this.status = status;
    this.operation = operation;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本进程限速（每个应用一个）：应用总额度 10 次 / 秒，留一半给同时运行的其他进程 */
export function createLimiter({ perSecond = 5, now = () => Date.now(), wait = sleep } = {}) {
  const stamps = [];
  let chain = Promise.resolve();
  return () => {
    const turn = chain.then(async () => {
      for (;;) {
        const t = now();
        while (stamps.length && t - stamps[0] >= 1000) stamps.shift();
        if (stamps.length < perSecond) {
          stamps.push(t);
          return;
        }
        await wait(1000 - (t - stamps[0]) + 5);
      }
    });
    chain = turn.catch(() => {});
    return turn;
  };
}

const MAX_UPLOAD = { image: 20 * 1024 * 1024, file: 20 * 1024 * 1024, video: 100 * 1024 * 1024 };

/** 读一个要上传的文件：本机绝对路径或 https 地址；返回 { name, bytes, sha256 } */
export async function loadUpload(ref, field, { fetchImpl = fetch } = {}) {
  const limit = MAX_UPLOAD[field] ?? 20 * 1024 * 1024;
  if (/^https:\/\//i.test(ref)) {
    let res;
    try {
      res = await fetchImpl(ref, { signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new SpecError(`下载不了 ${field}：${ref}`);
    }
    if (!res.ok) throw new SpecError(`下载 ${field} 失败（HTTP ${res.status}）：${ref}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > limit) throw new SpecError(`${field} 超过 ${limit / 1024 / 1024} MB`);
    const name = decodeURIComponent(new URL(ref).pathname.split('/').pop() || field);
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  if (!isAbsolute(ref)) throw new SpecError(`${field} 要用本机文件的绝对路径或 https 地址`);
  let st;
  try {
    st = await stat(ref);
  } catch {
    throw new SpecError(`找不到文件：${ref}`);
  }
  if (!st.isFile()) throw new SpecError(`不是文件：${ref}`);
  if (st.size > limit) throw new SpecError(`${field} 超过 ${limit / 1024 / 1024} MB：${ref}`);
  const bytes = await readFile(ref);
  return { name: basename(ref), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Etsy 报错里常见的说明字段 */
function errorText(json, raw) {
  const msg = json?.error_description || json?.error || json?.message || raw;
  return String(msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * 创建 API 客户端。
 * tokens: createTokenProvider() 的返回；call 时传 shopCode 就带这家店的令牌。
 */
export function createApi({ tokens, fetchImpl = fetch, newLimiter = () => createLimiter(), base = API_BASE, userAgent = 'etsy-seller-mcp' } = {}) {
  const limiters = new Map();
  const limiterFor = (keystring) => {
    if (!limiters.has(keystring)) limiters.set(keystring, newLimiter());
    return limiters.get(keystring);
  };
  /**
   * 调一个接口。call({ op, pathParams, query, body, shopCode, auth })
   * auth: 'required'（接口要 OAuth 权限）/ 'optional'（有授权就带上）/ 'none'
   * 返回 { status, data, rate }
   */
  async function call({ op, pathParams = {}, query = {}, body, shopCode, auth = op.scopes.length ? 'required' : 'optional', uploads }) {
    const path = buildPath(op, { pathParams, query });
    const app = appFor(tokens.keys(), shopCode);
    const enc = encodeBody(op, body);
    let attempt401 = false;
    let attempt429 = false;
    for (;;) {
      const headers = { 'x-api-key': apiKeyHeader(app), Accept: 'application/json', 'User-Agent': userAgent };
      if (shopCode && auth !== 'none') {
        try {
          headers.Authorization = `Bearer ${await tokens.userToken(shopCode)}`;
        } catch (err) {
          if (auth === 'required') throw err;
        }
      }
      let payload;
      if (enc.multipart) {
        const form = new FormData();
        const files = new Set(binaryFields(op));
        for (const [k, v] of Object.entries(body ?? {})) {
          if (v === undefined || v === null) continue;
          if (files.has(k)) {
            const up = uploads?.[k] ?? (await loadUpload(v, k, { fetchImpl }));
            form.set(k, new Blob([up.bytes]), up.name);
          } else form.set(k, typeof v === 'boolean' ? String(v) : String(v));
        }
        payload = form; // Content-Type（含 boundary）由 fetch 生成
      } else if (enc.payload !== undefined) {
        headers['Content-Type'] = enc.contentType;
        payload = enc.payload;
      }
      await limiterFor(app.keystring)();
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method: op.method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(enc.multipart ? 300_000 : 60_000),
        });
      } catch (err) {
        throw Object.assign(new ApiError(`连不上 Etsy 接口（${err?.name === 'TimeoutError' ? '超时' : '网络问题'}）`, { operation: op.id }), { network: true });
      }
      const rate = {
        remaining_today: res.headers.get('x-remaining-today') ?? undefined,
        limit_per_day: res.headers.get('x-limit-per-day') ?? undefined,
      };
      let raw;
      try {
        raw = await res.text();
      } catch (err) {
        // 收到响应头后读正文时断线：请求可能已经生效
        throw Object.assign(new ApiError(`读取 Etsy 返回时连接中断（${err?.name === 'TimeoutError' ? '超时' : '网络问题'}）`, { status: res.status, operation: op.id }), { network: true });
      }
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw.slice(0, 2000);
        }
      }
      if (res.ok) return { status: res.status, data, rate };

      if (res.status === 401 && shopCode && headers.Authorization && !attempt401) {
        attempt401 = true;
        await tokens.forget(shopCode).catch(() => {});
        continue;
      }
      if (res.status === 429 && !attempt429) {
        const wait = Number(res.headers.get('retry-after'));
        if (Number.isFinite(wait) && wait <= 10) {
          attempt429 = true;
          await sleep(Math.max(1, wait) * 1000);
          continue;
        }
      }
      const detail = errorText(data, raw);
      if (res.status === 429) {
        throw new ApiError(`Etsy 接口限流（应用额度 10 次/秒、1 万次/天，${rate.remaining_today !== undefined ? `今天还剩 ${rate.remaining_today} 次` : '额度用完了'}）：稍后再试，不要反复重试`, { status: 429, operation: op.id });
      }
      if (res.status === 401) throw new ApiError(`Etsy 拒绝了这个请求（401 未授权${detail ? `：${detail}` : ''}）`, { status: 401, operation: op.id });
      if (res.status === 403) {
        throw new ApiError(`没有权限（403${detail ? `：${detail}` : ''}）。如果是缺少授权范围，重新运行 auth 授权`, { status: 403, operation: op.id });
      }
      if (res.status === 404) throw new ApiError(`找不到（404${detail ? `：${detail}` : ''}）`, { status: 404, operation: op.id });
      if (res.status >= 500) {
        // 服务器出错时请求可能已经部分生效，写操作要按「结果不确定」处理
        throw Object.assign(new ApiError(`Etsy 服务器出错（HTTP ${res.status}${detail ? `：${detail}` : ''}）`, { status: res.status, operation: op.id }), { uncertain: true });
      }
      throw new ApiError(`Etsy 接口出错（HTTP ${res.status}${detail ? `：${detail}` : ''}）`, { status: res.status, operation: op.id });
    }
  }

  return { call };
}
