// 店铺授权（OAuth 2.0 授权码 + PKCE）：在这家店的 HubStudio 浏览器环境里新开标签页打开 Etsy 授权页，
// 店主点「Grant access」后 Etsy 跳回登记的回调地址；回跳请求在浏览器里就被拦下（CDP Fetch），从地址里取 code，
// 不需要真有一个回调服务。code 换成令牌后存进密钥文件。全程在店铺自己的环境（IP、指纹）里完成。
// Seller app 只能授权自己的店：这家店还没有应用密钥、默认应用又属于别的店时，从这家店环境里的 Your Apps 页读取。
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.mjs';
import { withLock } from './lock.mjs';
import { connectCdp, httpJson } from './cdp.mjs';
import { locatePort } from './hubstudio.mjs';
import {
  ALL_SCOPES, apiKeyHeader, AuthError, authorizeUrl, createPkce, defaultApp, loadKeys, requestToken, tokenFields, updateKeys, userIdOf,
} from './oauth.mjs';
import { API_BASE } from './etsy-api.mjs';

/** 默认回调地址：要在 Etsy Your Apps → Edit callback URLs 里登记一模一样的字符串 */
export const DEFAULT_REDIRECT_URI = 'https://localhost/etsy-seller-mcp/callback';
export const YOUR_APPS_URL = 'https://www.etsy.com/developers/your-apps';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CDP 地址匹配里 * ? \ 是通配符 / 转义 */
const escapePattern = (s) => s.replace(/[\\*?]/g, (c) => `\\${c}`);

/** 看回跳地址：拿到 code / 用户拒绝 / 不对 */
export function readRedirect(href, redirectUri, state) {
  let u;
  let base;
  try {
    u = new URL(href);
    base = new URL(redirectUri);
  } catch {
    return { status: 'error', reason: '回跳地址解析不了' };
  }
  if (u.origin !== base.origin || u.pathname !== base.pathname) return { status: 'other' };
  if (u.searchParams.get('state') !== state) return { status: 'error', reason: '授权回跳的 state 对不上，已放弃（请重新运行授权）' };
  const err = u.searchParams.get('error');
  if (err) return { status: 'error', reason: err === 'access_denied' ? '在授权页上点了拒绝，没有授权' : `Etsy 授权出错：${err} ${u.searchParams.get('error_description') ?? ''}`.trim() };
  const code = u.searchParams.get('code');
  if (!code) return { status: 'error', reason: '回跳地址里没有 code' };
  return { status: 'ok', code };
}

/**
 * 这家店授权用哪个应用：店自己存过的 → 用它；默认应用属于这家店（或还没归属、也没被别的店用）→ 用默认的；
 * 否则返回 null（要从这家店的 Your Apps 页读）。
 */
export function pickApp(keys, code) {
  const own = keys.shops?.[code]?.app;
  if (own?.keystring && own?.shared_secret) return { app: own, source: 'shop' };
  const def = defaultApp(keys);
  if (!def) return null;
  const owner = keys.hubstudio?.container_code ? String(keys.hubstudio.container_code) : null;
  if (owner === String(code)) return { app: def, source: 'default' };
  if (owner) return null;
  const usedByOther = Object.entries(keys.shops ?? {}).some(([c, g]) => c !== String(code) && g?.refresh_token && !g.app);
  return usedByOther ? null : { app: def, source: 'default' };
}

const htmlPage = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:48px;color:#222"><h2>${title}</h2><p>${msg}</p></body>`;

/** 新开一个标签页并连上它；返回 { tab, targetId } */
async function openTab(port, url = 'about:blank') {
  const { webSocketDebuggerUrl } = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 3000 });
  const browser = await connectCdp(webSocketDebuggerUrl);
  let targetId;
  try {
    ({ targetId } = await browser.send('Target.createTarget', { url, background: false }));
  } finally {
    browser.close();
  }
  const target = (await httpJson(`http://127.0.0.1:${port}/json/list`, { timeoutMs: 3000 })).find((t) => t.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new AuthError('新开的标签页连不上');
  return { tab: await connectCdp(target.webSocketDebuggerUrl), targetId };
}

async function closeTab(tab) {
  await tab.send('Page.close').catch(() => {});
  tab.close();
}

/** 在页面里读 Your Apps 表格：只返回已批准的应用（keystring / secret 不打印） */
function readAppsTable() {
  const tok = /^[a-z0-9]{20,}$/;
  const rows = [...document.querySelectorAll('tr.apps-table-row')];
  if (!rows.length) return { state: /sign in|登录/i.test(document.body?.innerText ?? '') ? 'login' : 'none' };
  const apps = rows.map((row) => {
    const keyBtn = [...row.querySelectorAll('button.copy-to-clipboard')].find((b) => !b.closest('.secret-cell'));
    const secretBtn = row.querySelector('.secret-cell button.copy-to-clipboard');
    const cells = [...row.querySelectorAll('th, td')].filter((c) => !c.contains(keyBtn) && !c.classList.contains('secret-cell'));
    return {
      app_name: cells[0]?.innerText.trim() ?? '',
      status: cells[1]?.innerText.trim() ?? '',
      keystring: (keyBtn?.textContent ?? '').trim(),
      shared_secret: (secretBtn?.textContent ?? '').trim(),
    };
  }).filter((a) => /approved/i.test(a.status) && tok.test(a.keystring) && tok.test(a.shared_secret));
  return { state: 'ok', apps, application_id: document.querySelector('input[name=application_id]')?.value ?? null };
}

/** 从这家店环境里的 Etsy Your Apps 页读应用密钥 */
export async function readAppFromPage(port, { log = () => {} } = {}) {
  log('正在从这家店环境里的 Etsy Your Apps 页读取应用密钥…');
  const { tab } = await openTab(port, YOUR_APPS_URL);
  try {
    const deadline = Date.now() + 45_000;
    let r = { state: 'none' };
    while (Date.now() < deadline) {
      await sleep(1500);
      r = await tab.callInPage(readAppsTable).catch(() => ({ state: 'none' }));
      if (r.state === 'ok' || r.state === 'login') break;
    }
    if (r.state === 'login') throw new AuthError('这家店的环境里 Etsy 没有登录：先在 HubStudio 环境里登录 Etsy 卖家账号');
    if (r.state !== 'ok') throw new AuthError(`在 ${YOUR_APPS_URL} 没找到应用：先在这家店的环境里建一个 Seller app 并等它批准`);
    if (!r.apps.length) throw new AuthError('这家店的 Etsy 账号下还没有已批准的应用：等 Seller app 批准后再授权');
    if (r.apps.length > 1) log(`有 ${r.apps.length} 个已批准的应用，用第一个：${r.apps[0].app_name}`);
    const a = r.apps[0];
    return { keystring: a.keystring, shared_secret: a.shared_secret, app_name: a.app_name, application_id: r.application_id };
  } finally {
    await closeTab(tab);
  }
}

async function etsyGet(app, token, path, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    headers: { 'x-api-key': apiKeyHeader(app), Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new AuthError(`授权成功，但读取店铺信息失败（HTTP ${res.status}${json?.error ? `：${String(json.error).slice(0, 200)}` : ''}）`);
  return json;
}

/** 在授权页上看有没有回调地址不对之类的错误（Etsy 不会跳回，只在页面上提示） */
function readAuthPageError() {
  const t = document.body?.innerText ?? '';
  if (/redirect_uri|callback url/i.test(t) && /invalid|not (a )?valid|does not match|mismatch|error/i.test(t)) return 'redirect';
  if (/invalid client|client_id/i.test(t) && /invalid|error/i.test(t)) return 'client';
  return null;
}

/**
 * 授权一家店。code：HubStudio 环境 ID。appFromPage：强制从 Your Apps 页重新读应用密钥。
 * 返回 { user_id, shop_id, shop_name, scopes, expires_at, app_source, duplicate_of }
 */
export async function authorizeShop({ code, file, scopes = ALL_SCOPES, redirectUri, appFromPage = false, log = () => {}, timeoutMs = 10 * 60_000, fetchImpl = fetch }) {
  code = String(code);
  let keys;
  try {
    keys = loadKeys(file);
  } catch (err) {
    if (!/还没有配置/.test(err.message)) throw err;
    keys = {};
  }
  const redirect = (redirectUri || keys.redirect_uri || DEFAULT_REDIRECT_URI).trim();
  if (!/^https:\/\/[^\s?#]+$/.test(redirect)) throw new AuthError('回调地址必须以 https:// 开头，且不能带 ? 或 #（要和 Etsy 应用里登记的完全一致）');

  log(`正在定位 HubStudio 环境 ${code} 的浏览器…`);
  const port = await locatePort(code, { log, fetchImpl });

  let picked = appFromPage ? null : pickApp(keys, code);
  let pageApp = null;
  if (!picked) {
    pageApp = await readAppFromPage(port, { log });
    picked = { app: { keystring: pageApp.keystring, shared_secret: pageApp.shared_secret }, source: 'page' };
    const clash = Object.entries(keys.shops ?? {}).find(([c, g]) => c !== code && (g?.app?.keystring ?? (g?.refresh_token && !g?.app ? keys.keystring : null)) === pageApp.keystring);
    if (clash) throw new AuthError(`这个环境里登录的 Etsy 账号的应用和 HubStudio 环境 ${clash[0]} 的是同一个：确认这两个环境登录的是不是同一家店`);
  }
  const { app } = picked;

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('hex');
  const url = authorizeUrl(app, { redirectUri: redirect, state, challenge, scopes });
  const { tab } = await openTab(port);

  let authCode;
  try {
    authCode = await new Promise((resolve, reject) => {
      let done = false;
      let off = () => {};
      let poll = null;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        off();
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new AuthError('10 分钟内没有完成授权，请重新运行')), timeoutMs);
      off = tab.on((method, params) => {
        if (method === '__closed__' || method === 'Inspector.detached') {
          finish(reject, new AuthError('授权标签页被关掉了，没有完成授权'));
          return;
        }
        if (method !== 'Fetch.requestPaused') return;
        const r = readRedirect(params.request?.url ?? '', redirect, state);
        if (r.status === 'other') {
          tab.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
          return;
        }
        const html = r.status === 'ok' ? htmlPage('授权已完成', '可以关掉这个标签页，回到终端看结果。') : htmlPage('授权没有完成', r.reason);
        tab.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(html).toString('base64'),
        }).catch(() => {});
        if (r.status === 'ok') finish(resolve, r.code);
        else finish(reject, new AuthError(r.reason));
      });
      tab.send('Fetch.enable', { patterns: [{ urlPattern: `${escapePattern(redirect)}*`, requestStage: 'Request' }] })
        .then(() => tab.send('Page.navigate', { url }))
        .then(() => {
          log('已在 HubStudio 浏览器里打开 Etsy 授权页：请在那个窗口确认是这家店的账号，点「Grant access」。最多等 10 分钟…');
          poll = setInterval(() => {
            tab.callInPage(readAuthPageError).then((e) => {
              if (e === 'redirect') finish(reject, new AuthError(`Etsy 提示回调地址不对：在这家店的 Your Apps → Edit callback URLs 里登记「${redirect}」后重试`));
              if (e === 'client') finish(reject, new AuthError('Etsy 提示应用无效：检查这家店的 Seller app 是否已批准（可加 --app-from-page 重新读取密钥）'));
            }, () => {});
          }, 3000);
        })
        .catch((err) => finish(reject, new AuthError(`打开授权页失败：${err.message}`)));
    });
  } finally {
    await sleep(1500);
    await closeTab(tab);
  }

  return exchangeAndSave({ code, file, app, source: picked.source, appName: pageApp?.app_name, redirect, authCode, verifier, scopes, fetchImpl });
}

/** 用授权码换令牌，读店铺信息，存进密钥文件（店自己的应用密钥保留原样） */
async function exchangeAndSave({ code, file, app, source, appName, redirect, authCode, verifier, scopes, fetchImpl }) {
  const t = await requestToken(app, { grant_type: 'authorization_code', redirect_uri: redirect, code: authCode, code_verifier: verifier }, { fetchImpl });
  if (!t.refresh_token) throw new AuthError('Etsy 没有返回 refresh_token，请重新授权');
  const me = await etsyGet(app, t.access_token, '/v3/application/users/me', fetchImpl);
  const userId = Number(me?.user_id ?? userIdOf(t.access_token));
  const shopId = Number(me?.shop_id);
  if (!shopId) throw new AuthError('授权的 Etsy 账号下没有店铺（users/me 没有 shop_id）');
  const shop = await etsyGet(app, t.access_token, `/v3/application/shops/${shopId}`, fetchImpl);
  const grant = {
    user_id: userId,
    shop_id: shopId,
    shop_name: shop?.shop_name ?? null,
    currency_code: shop?.currency_code ?? null,
    ...tokenFields(t),
    scopes,
    authorized_at: new Date().toISOString(),
  };
  let duplicate = null;
  await updateKeys(file, (k) => {
    k.redirect_uri = redirect;
    k.shops = k.shops && typeof k.shops === 'object' ? k.shops : {};
    for (const [c, g] of Object.entries(k.shops)) if (c !== code && Number(g?.shop_id) === shopId) duplicate = c;
    if (source === 'default' && !k.hubstudio?.container_code) k.hubstudio = { ...(k.hubstudio ?? {}), container_code: code };
    const ownApp = source === 'page'
      ? { keystring: app.keystring, shared_secret: app.shared_secret, ...(appName ? { app_name: appName } : {}) }
      : k.shops[code]?.app;
    k.shops[code] = { ...(ownApp ? { app: ownApp } : {}), ...grant };
    return k;
  });
  return { user_id: userId, shop_id: shopId, shop_name: grant.shop_name, scopes, expires_at: grant.refresh_token_expires_at, app_source: source, duplicate_of: duplicate };
}

// ---- 手动授权：工具不碰浏览器。生成授权网址 → 用户自己在这家店的 HubStudio 浏览器里打开、点 Grant access →
// 把跳转后（打不开的 https://localhost/...）地址栏里的完整地址交回来完成授权。PKCE verifier 只存在本机（600），30 分钟有效。
const PENDING_TTL_MS = 30 * 60_000;
const pendingPath = (dataDir, code) => join(dataDir, 'pending-auth', `${code}.json`);

const pendingLock = (dataDir, code, fn) => withLock(dataDir, fn, {
  key: `pending-auth-${code}`, what: '这家店的授权', waitMs: 60_000, owner: `etsy-seller-mcp auth ${process.pid}`,
});

/** 生成授权网址（和完成授权共用一把锁：不会在别的进程核对 state 和删除记录之间被覆盖） */
export function startManualAuth({ code, file, dataDir, scopes = ALL_SCOPES, redirectUri, now = Date.now() }) {
  code = String(code);
  return pendingLock(dataDir, code, async () => startLocked({ code, file, dataDir, scopes, redirectUri, now }));
}

function startLocked({ code, file, dataDir, scopes, redirectUri, now }) {
  const keys = loadKeys(file);
  const redirect = (redirectUri || keys.redirect_uri || DEFAULT_REDIRECT_URI).trim();
  if (!/^https:\/\/[^\s?#]+$/.test(redirect)) throw new AuthError('回调地址必须以 https:// 开头，且不能带 ? 或 #（要和 Etsy 应用里登记的完全一致）');
  const picked = pickApp(keys, code);
  if (!picked) throw new AuthError(`HubStudio 环境 ${code} 还没有应用密钥：先在这家店的环境里建 Seller app，再读取密钥（auth --container ${code} --app-from-page）`);
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('hex');
  const url = authorizeUrl(picked.app, { redirectUri: redirect, state, challenge, scopes });
  writeFileAtomic(pendingPath(dataDir, code), JSON.stringify({
    code, state, verifier, redirect, scopes, keystring: picked.app.keystring, source: picked.source, created_at: new Date(now).toISOString(),
  }));
  return { url, redirect, expires_at: new Date(now + PENDING_TTL_MS).toISOString() };
}

export async function finishManualAuth({ code, file, dataDir, redirectedUrl, fetchImpl = fetch, now = Date.now() }) {
  code = String(code);
  // 同一家店的完成授权串行：同一个授权码不会被换两次，也不会误删重新生成的那一轮
  return pendingLock(dataDir, code, () => finishLocked({ code, file, dataDir, redirectedUrl, fetchImpl, now }));
}

async function finishLocked({ code, file, dataDir, redirectedUrl, fetchImpl, now }) {
  let p;
  try {
    p = JSON.parse(readFileSync(pendingPath(dataDir, code), 'utf8'));
  } catch {
    throw new AuthError(`HubStudio 环境 ${code} 没有待完成的手动授权：先运行 auth --container ${code} --manual 生成授权网址`);
  }
  if (now - Date.parse(p.created_at) > PENDING_TTL_MS) throw new AuthError('授权网址已超过 30 分钟，请重新生成（auth --manual）');
  const r = readRedirect(String(redirectedUrl ?? '').trim(), p.redirect, p.state);
  if (r.status === 'other') throw new AuthError(`这不是授权后跳转的地址：应该以 ${p.redirect}?code= 开头`);
  if (r.status !== 'ok') throw new AuthError(r.reason);
  const keys = loadKeys(file);
  const picked = pickApp(keys, code);
  if (!picked || picked.app.keystring !== p.keystring) throw new AuthError('生成授权网址后这家店的应用密钥变了，请重新生成授权网址');
  const result = await exchangeAndSave({ code, file, app: picked.app, source: picked.source, redirect: p.redirect, authCode: r.code, verifier: p.verifier, scopes: p.scopes, fetchImpl });
  try {
    // 只删本轮的：换令牌期间又重新生成过网址的，留着新的那份
    const cur = JSON.parse(readFileSync(pendingPath(dataDir, code), 'utf8'));
    if (cur.state === p.state) unlinkSync(pendingPath(dataDir, code));
  } catch {
    // 已经没了
  }
  return result;
}
