import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { pickApp, readRedirect } from '../lib/auth-flow.mjs';
import { appFor, authorizeUrl, createPkce, createTokenProvider, userIdOf } from '../lib/oauth.mjs';
import { APP, fakeFetch, grant, keysFile, tmp } from './helpers.mjs';

test('PKCE: challenge is the S256 of the verifier, base64url without padding', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expect = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expect);
});

test('authorizeUrl carries client_id, scopes, state and the S256 challenge', () => {
  const u = new URL(authorizeUrl(APP, { redirectUri: 'https://localhost/cb', state: 'st', challenge: 'ch', scopes: ['shops_r', 'listings_w'] }));
  assert.equal(u.origin + u.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(u.searchParams.get('client_id'), APP.keystring);
  assert.equal(u.searchParams.get('scope'), 'shops_r listings_w');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://localhost/cb');
  assert.equal(userIdOf('12345.abc'), 12345);
  assert.equal(userIdOf('abc'), null);
});

test('appFor: a shop\'s own app wins, then the default app; missing both explains how to fix', () => {
  const own = { keystring: 'o'.repeat(24), shared_secret: 'p'.repeat(25) };
  const keys = { ...APP, shops: { 1001: { app: own }, 1002: {} } };
  assert.equal(appFor(keys, '1001'), own);
  assert.equal(appFor(keys, '1002').keystring, APP.keystring);
  assert.throws(() => appFor({ shops: {} }, '1003'), /没有 Etsy 应用密钥.*auth --container 1003/);
});

test('pickApp: the default app is only reused by the shop it belongs to', () => {
  const own = { keystring: 'o'.repeat(24), shared_secret: 'p'.repeat(25) };
  assert.equal(pickApp({ ...APP, hubstudio: { container_code: '1001' } }, '1001').source, 'default');
  assert.equal(pickApp({ ...APP, hubstudio: { container_code: '1001' } }, '1002'), null);
  assert.equal(pickApp({ ...APP }, '1002').source, 'default');
  assert.equal(pickApp({ ...APP, shops: { 1001: grant() } }, '1002'), null);
  assert.equal(pickApp({ ...APP, shops: { 1002: { app: own } } }, '1002').source, 'shop');
  assert.equal(pickApp({}, '1002'), null);
});

test('readRedirect: code with matching state; denial; foreign urls are ignored', () => {
  const r = 'https://localhost/etsy-seller-mcp/callback';
  assert.deepEqual(readRedirect(`${r}?code=abc&state=s1`, r, 's1'), { status: 'ok', code: 'abc' });
  assert.equal(readRedirect(`${r}?code=abc&state=bad`, r, 's1').status, 'error');
  assert.match(readRedirect(`${r}?error=access_denied&state=s1`, r, 's1').reason, /拒绝/);
  assert.equal(readRedirect('https://www.etsy.com/oauth/connect?x=1', r, 's1').status, 'other');
});

test('token provider: a valid stored access token is used without any request', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant() } });
  const fetchImpl = fakeFetch(() => assert.fail('不该请求'));
  const p = createTokenProvider({ file, fetchImpl });
  assert.equal(await p.userToken('1001'), '111.access-ok');
  assert.equal(p.grantInfo('1001').shop_id, 222);
  assert.equal(p.grantInfo('1001').refresh_token, undefined);
});

test('token provider: expired access token → one refresh for concurrent callers, rotated refresh token saved (600)', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant({ access_token_expires_at: '2000-01-01T00:00:00Z' }) } });
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url, 'https://api.etsy.com/v3/public/oauth/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), '111.refresh-old');
    assert.equal(body.get('client_id'), APP.keystring);
    assert.equal(init.headers['x-api-key'], `${APP.keystring}:${APP.shared_secret}`);
    return { json: { access_token: '111.access-new', expires_in: 3600, refresh_token: '111.refresh-new' } };
  });
  const p = createTokenProvider({ file, fetchImpl });
  const [a, b] = await Promise.all([p.userToken('1001'), p.userToken('1001')]);
  assert.equal(a, '111.access-new');
  assert.equal(b, '111.access-new');
  assert.equal(fetchImpl.calls.length, 1);
  const saved = JSON.parse(readFileSync(file, 'utf8')).shops['1001'];
  assert.equal(saved.refresh_token, '111.refresh-new');
  assert.equal(saved.access_token, '111.access-new');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600); // Windows 没有 Unix 权限位
  // 另一个进程（新的提供者）直接用文件里换好的令牌
  const p2 = createTokenProvider({ file, fetchImpl: fakeFetch(() => assert.fail('不该再换')) });
  assert.equal(await p2.userToken('1001'), '111.access-new');
});

test('token provider: revoked grant / missing grant / expired grant give a re-auth hint, never the token', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant({ access_token_expires_at: '2000-01-01T00:00:00Z' }), 1002: grant({ refresh_token_expires_at: '2000-01-01T00:00:00Z' }) } });
  const p = createTokenProvider({ file, fetchImpl: fakeFetch(() => ({ status: 400, json: { error: 'invalid_grant' } })) });
  await assert.rejects(p.userToken('1001'), (e) => /已失效或被撤销.*auth --container 1001/.test(e.message) && !e.message.includes('refresh-old'));
  await assert.rejects(p.userToken('1002'), /已过期/);
  await assert.rejects(p.userToken('1003'), /还没有授权/);
});

test('token provider: forget() makes the next call refresh', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant() } });
  const fetchImpl = fakeFetch(() => ({ json: { access_token: '111.after-forget', expires_in: 3600, refresh_token: '111.r2' } }));
  const p = createTokenProvider({ file, fetchImpl });
  assert.equal(await p.userToken('1001'), '111.access-ok');
  await p.forget('1001');
  assert.equal(await p.userToken('1001'), '111.after-forget');
});

test('manual auth: URL with PKCE now, finish later with the pasted redirect address; app keys of the shop are kept', async () => {
  const { startManualAuth, finishManualAuth } = await import('../lib/auth-flow.mjs');
  const own = { keystring: 'o'.repeat(24), shared_secret: 'p'.repeat(25), app_name: 'shop-manager', application_id: '1' };
  const dir = tmp();
  const file = keysFile(dir, { ...APP, hubstudio: { container_code: '1001' }, shops: { 1002: { app: own } } });
  const m = await startManualAuth({ code: '1002', file, dataDir: dir });
  const u = new URL(m.url);
  assert.equal(u.searchParams.get('client_id'), own.keystring);
  const state = u.searchParams.get('state');
  const fetchImpl = fakeFetch((url, init) => {
    if (url.endsWith('/oauth/token')) {
      const b = new URLSearchParams(init.body);
      assert.equal(b.get('code'), 'C1');
      assert.equal(createHash('sha256').update(b.get('code_verifier')).digest('base64url'), u.searchParams.get('code_challenge'));
      assert.equal(init.headers['x-api-key'], `${own.keystring}:${own.shared_secret}`);
      return { json: { access_token: '555.a', refresh_token: '555.r', expires_in: 3600 } };
    }
    if (url.endsWith('/users/me')) return { json: { user_id: 555, shop_id: 777 } };
    return { json: { shop_name: 'GI', currency_code: 'USD' } };
  });
  await assert.rejects(finishManualAuth({ code: '1002', file, dataDir: dir, redirectedUrl: 'https://www.etsy.com/x', fetchImpl }), /不是授权后跳转的地址/);
  await assert.rejects(finishManualAuth({ code: '1002', file, dataDir: dir, redirectedUrl: `${m.redirect}?code=C1&state=wrong`, fetchImpl }), /state 对不上/);
  const r = await finishManualAuth({ code: '1002', file, dataDir: dir, redirectedUrl: `${m.redirect}?code=C1&state=${state}`, fetchImpl });
  assert.equal(r.shop_id, 777);
  const saved = JSON.parse(readFileSync(file, 'utf8')).shops['1002'];
  assert.deepEqual(saved.app, own);
  assert.equal(saved.refresh_token, '555.r');
  await assert.rejects(finishManualAuth({ code: '1002', file, dataDir: dir, redirectedUrl: `${m.redirect}?code=C1&state=${state}`, fetchImpl }), /没有待完成/);
  await assert.rejects(startManualAuth({ code: '1003', file, dataDir: dir }), /还没有应用密钥/);
});

test('manual auth: regenerating the URL while the previous round is exchanging keeps the new pending round', async () => {
  const { startManualAuth, finishManualAuth } = await import('../lib/auth-flow.mjs');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = tmp();
  const file = keysFile(dir, { ...APP, hubstudio: { container_code: '1001' } });
  const m = await startManualAuth({ code: '1001', file, dataDir: dir });
  const state = new URL(m.url).searchParams.get('state');
  let regenerated = null;
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/oauth/token')) {
      regenerated = startManualAuth({ code: '1001', file, dataDir: dir }); // 换令牌期间又生成了一轮（等完成授权放锁后才写入）
      return { json: { access_token: '1.a', refresh_token: '1.r', expires_in: 3600 } };
    }
    if (url.endsWith('/users/me')) return { json: { user_id: 1, shop_id: 2 } };
    return { json: { shop_name: 'S' } };
  });
  await finishManualAuth({ code: '1001', file, dataDir: dir, redirectedUrl: `${m.redirect}?code=C&state=${state}`, fetchImpl });
  assert.ok(regenerated);
  await regenerated;
  assert.ok(existsSync(join(dir, 'pending-auth', '1001.json')), '新一轮的待完成记录还在');
});
