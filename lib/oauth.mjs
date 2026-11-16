// Etsy 开放平台凭证：应用（Seller app）的 keystring / shared secret，和每家店的授权（OAuth 2.0 + PKCE 换来的令牌）。
// Seller app 只能授权建它的那个 Etsy 账号自己的店，所以多家店时每家店有自己的应用密钥（shops.<ID>.app）；
// 顶层的 keystring / shared_secret 是默认应用（hubstudio.container_code 记着它属于哪家店）。
// 都放在本机一个 600 权限的 JSON 文件里（默认 ~/.config/etsy-seller-mcp/api-keys.json，可用 ETSY_API_KEYS 指定）：
//   { "keystring": "...", "shared_secret": "...", "hubstudio": { "container_code": "..." }, "redirect_uri": "https://...",
//     "shops": { "<HubStudio 环境 ID>": { "app": { "keystring": "...", "shared_secret": "..." }, "user_id": 1, "shop_id": 2,
//                "shop_name": "...", "refresh_token": "...", "refresh_token_expires_at": "...", "access_token": "...",
//                "access_token_expires_at": "...", "scopes": [...] } } }
// access_token 1 小时、refresh_token 90 天；每次换令牌 Etsy 都给新的 refresh_token，立刻写回文件。
// 换令牌在文件锁里做，并先看文件里有没有别的进程刚换好的令牌，避免两个进程拿同一个 refresh_token 各换一次。
// 令牌不写日志、不出现在报错里。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './fsutil.mjs';
import { withLock } from './lock.mjs';

export class AuthError extends Error {}

export const AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
export const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
/** 用到的全部权限：读（店铺、商品、订单和财务、本人资料和地址）和写（店铺设置、商品、删除商品、订单发货） */
export const READ_SCOPES = ['shops_r', 'listings_r', 'transactions_r', 'email_r', 'address_r'];
export const WRITE_SCOPES = ['shops_w', 'listings_w', 'listings_d', 'transactions_w'];
export const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES];
const REFRESH_TTL_MS = 90 * 24 * 3600_000;

export const defaultKeysFile = (env = process.env) => env.ETSY_API_KEYS || join(homedir(), '.config', 'etsy-seller-mcp', 'api-keys.json');

/** 授权命令怎么写：从本机路径运行（还没装成 npm 包）时给 node + 路径，否则给 npx */
const SELF = (() => {
  const entry = process.argv[1] ?? '';
  if (!/etsy-seller-mcp(\.mjs)?$/.test(entry) || /[\\/](_npx|node_modules)[\\/]/.test(entry)) return 'npx -y etsy-seller-mcp@latest';
  // 路径里有空格、引号、中文等就用单引号括起来（单引号本身转义成 '\''）
  return `node ${/^[\w@%+=:,./-]+$/.test(entry) ? entry : `'${entry.replace(/'/g, "'\\''")}'`}`;
})();
export const authHint = (code) => `${SELF} auth --container ${code ?? '<HubStudio 环境 ID>'}`;

/** 读密钥文件；文件不存在 / 缺字段时说明怎么配置 */
export function loadKeys(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new AuthError(`还没有配置 Etsy 应用密钥（${file}）：运行「${authHint()}」，会从这家店环境里的 Your Apps 页读取`);
    throw new AuthError(`Etsy 密钥文件 ${file} 读不了或不是合法 JSON`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError(`Etsy 密钥文件 ${file} 应是 JSON 对象`);
  return data;
}

const usable = (a) => typeof a?.keystring === 'string' && a.keystring.trim() && typeof a?.shared_secret === 'string' && a.shared_secret.trim();

/** 顶层默认应用（没有就是 null） */
export const defaultApp = (keys) => (usable(keys) ? { keystring: keys.keystring, shared_secret: keys.shared_secret } : null);

/** 这家店用哪个应用的密钥：店自己的，否则顶层默认的；都没有时报错 */
export function appFor(keys, code) {
  const own = code ? keys.shops?.[code]?.app : null;
  if (usable(own)) return own;
  const def = defaultApp(keys);
  if (def) return def;
  throw new AuthError(`没有 Etsy 应用密钥${code ? `（HubStudio 环境 ${code}）` : ''}：运行「${authHint(code)}」，会从这家店环境里的 Your Apps 页读取`);
}

/** 写回密钥文件：跨进程加锁，锁内读最新内容再改（两家店同时授权不会互相覆盖），原子替换，保持 600 */
export function updateKeys(file, mutate) {
  return withLock(dirname(file), async () => {
    const current = existsSync(file) ? loadKeys(file) : {};
    const next = (await mutate(structuredClone(current))) ?? current;
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }, { key: 'keys-file', what: 'Etsy 密钥文件', waitMs: 30_000, owner: `etsy-seller-mcp ${process.pid}` });
}

/** 所有 v3 请求都要带的应用身份：keystring:shared_secret */
export const apiKeyHeader = (app) => `${app.keystring.trim()}:${app.shared_secret.trim()}`;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE：随机 verifier 和它的 S256 challenge */
export function createPkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(app, { redirectUri, state, challenge, scopes = ALL_SCOPES }) {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: app.keystring.trim(),
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;
}

/** 令牌里点号前面是 Etsy 用户 ID */
export const userIdOf = (token) => {
  const m = /^(\d+)\./.exec(String(token ?? ''));
  return m ? Number(m[1]) : null;
};

/** 调令牌接口；出错时只给分类后的说明（不带令牌） */
export async function requestToken(app, params, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-api-key': apiKeyHeader(app), Accept: 'application/json' },
      body: new URLSearchParams({ client_id: app.keystring.trim(), ...params }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AuthError('连不上 Etsy 授权接口（网络问题），稍后再试');
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.access_token) return json;
  const code = String(json.error ?? '');
  if (code === 'invalid_client' || res.status === 401) throw new AuthError('Etsy 应用密钥无效（keystring / shared secret 不对，或应用被停用）：到 etsy.com/developers/your-apps 检查');
  if (code === 'invalid_grant') throw Object.assign(new AuthError('店铺授权已失效或被撤销'), { grant: true });
  if (code === 'invalid_scope') throw Object.assign(new AuthError('授权里没有这项权限'), { scope: true });
  throw new AuthError(`Etsy 授权接口出错（HTTP ${res.status}${code ? ` ${code}` : ''}${json.error_description ? `：${String(json.error_description).slice(0, 200)}` : ''}）`);
}

/** 把令牌接口的返回整理成存进文件的字段 */
export function tokenFields(t, now = Date.now()) {
  return {
    access_token: t.access_token,
    access_token_expires_at: new Date(now + Number(t.expires_in || 3600) * 1000).toISOString(),
    // 没返回新的 refresh_token 时沿用旧的（连同旧的有效期）
    ...(t.refresh_token ? { refresh_token: t.refresh_token, refresh_token_expires_at: new Date(now + REFRESH_TTL_MS).toISOString() } : {}),
  };
}

/**
 * 访问令牌提供者：按店（HubStudio 环境 ID）拿用户令牌。
 * 文件里的 access_token 还有 2 分钟以上就直接用；否则在文件锁里用 refresh_token 换新的并写回。
 */
export function createTokenProvider({ file = defaultKeysFile(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  const memo = new Map();
  const inflight = new Map();
  const valid = (g) => g?.access_token && Date.parse(g.access_token_expires_at ?? '') - 120_000 > now();

  function grantOf(keys, code) {
    const g = keys.shops?.[code];
    if (!g?.refresh_token) throw new AuthError(`这家店（HubStudio 环境 ${code}）还没有授权 Etsy 接口：在终端运行「${authHint(code)}」，在这家店的 HubStudio 浏览器里点 Grant access`);
    const exp = Date.parse(g.refresh_token_expires_at ?? '');
    if (Number.isFinite(exp) && exp <= now()) throw new AuthError(`这家店的 Etsy 授权已过期（90 天）：运行「${authHint(code)}」重新授权`);
    return g;
  }

  async function refresh(code) {
    let fresh;
    await updateKeys(file, async (keys) => {
      const g = grantOf(keys, code);
      if (valid(g)) {
        fresh = g; // 别的进程刚换好
        return undefined;
      }
      let t;
      try {
        t = await requestToken(appFor(keys, code), { grant_type: 'refresh_token', refresh_token: g.refresh_token }, { fetchImpl });
      } catch (err) {
        if (err.grant) throw new AuthError(`这家店的 Etsy 授权已失效或被撤销：运行「${authHint(code)}」重新授权`);
        throw err;
      }
      Object.assign(g, tokenFields(t, now()), { refreshed_at: new Date(now()).toISOString() });
      fresh = g;
      return keys;
    });
    return { access_token: fresh.access_token, access_token_expires_at: fresh.access_token_expires_at };
  }

  async function userToken(code) {
    const hit = memo.get(code);
    if (valid(hit)) return hit.access_token;
    const keys = loadKeys(file);
    const g = grantOf(keys, code);
    if (valid(g)) {
      memo.set(code, g);
      return g.access_token;
    }
    if (inflight.has(code)) return inflight.get(code);
    const p = refresh(code).then((g2) => {
      memo.set(code, g2);
      return g2.access_token;
    });
    inflight.set(code, p);
    try {
      return await p;
    } finally {
      inflight.delete(code);
    }
  }

  return {
    userToken,
    keys: () => loadKeys(file),
    /** 这家店的授权信息（不含令牌） */
    grantInfo(code) {
      const g = loadKeys(file).shops?.[code];
      if (!g?.refresh_token) return null;
      return {
        user_id: g.user_id ?? null,
        shop_id: g.shop_id ?? null,
        shop_name: g.shop_name ?? null,
        scopes: g.scopes ?? [],
        refresh_token_expires_at: g.refresh_token_expires_at ?? null,
        authorized_at: g.authorized_at ?? null,
      };
    },
    /** 令牌被 Etsy 拒绝（401）后作废：内存和文件里的 access_token 都不再用 */
    async forget(code) {
      memo.delete(code);
      await updateKeys(file, (keys) => {
        const g = keys.shops?.[code];
        if (!g) return undefined;
        g.access_token_expires_at = new Date(0).toISOString();
        return keys;
      });
    },
  };
}
