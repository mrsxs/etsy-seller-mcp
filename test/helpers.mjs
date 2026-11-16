import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmp = (prefix = 'etsy-mcp-') => mkdtempSync(join(tmpdir(), prefix));

/** 写一个测试用密钥文件（600） */
export function keysFile(dir, data) {
  const f = join(dir, 'api-keys.json');
  writeFileSync(f, JSON.stringify(data), { mode: 0o600 });
  return f;
}

export const APP = { keystring: 'k'.repeat(24), shared_secret: 's'.repeat(25) };

/** 已授权的店：access_token 还有效 */
export const grant = (extra = {}) => ({
  user_id: 111, shop_id: 222, shop_name: 'TestShop',
  refresh_token: '111.refresh-old', refresh_token_expires_at: '2099-01-01T00:00:00Z',
  access_token: '111.access-ok', access_token_expires_at: '2099-01-01T00:00:00Z',
  scopes: ['shops_r', 'listings_r', 'transactions_r', 'email_r', 'address_r', 'shops_w', 'listings_w', 'listings_d', 'transactions_w'],
  ...extra,
});

/** 假 fetch：handler(url, init) 返回 { status, json, headers } 或抛错；记录每次调用 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init, calls.length);
    const headers = new Headers(r.headers ?? {});
    const body = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
    return new Response(body, { status: r.status ?? 200, headers });
  };
  fn.calls = calls;
  return fn;
}

export const noWait = () => Promise.resolve();
