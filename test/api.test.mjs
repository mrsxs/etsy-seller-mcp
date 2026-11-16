import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi, createLimiter, loadUpload } from '../lib/etsy-api.mjs';
import { createTokenProvider } from '../lib/oauth.mjs';
import { redact } from '../lib/privacy.mjs';
import { parseShops, resolveShop } from '../lib/shops.mjs';
import { getOperation, loadSpec } from '../lib/spec.mjs';
import { APP, fakeFetch, grant, keysFile, noWait, tmp } from './helpers.mjs';

const spec = loadSpec();
const setup = (handler, keys = { ...APP, shops: { 1001: grant() } }) => {
  const dir = tmp();
  const file = keysFile(dir, keys);
  const fetchImpl = fakeFetch(handler);
  const tokens = createTokenProvider({ file, fetchImpl });
  return { dir, file, fetchImpl, api: createApi({ tokens, fetchImpl, newLimiter: () => noWait }) };
};

test('call: x-api-key is keystring:shared_secret, Bearer token of the shop, path built from params', async () => {
  const { api, fetchImpl } = setup(() => ({ json: { shop_id: 222 }, headers: { 'x-remaining-today': '9990' } }));
  const r = await api.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 222 }, shopCode: '1001' });
  assert.equal(r.data.shop_id, 222);
  assert.equal(r.rate.remaining_today, '9990');
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.etsy.com/v3/application/shops/222');
  assert.equal(init.headers['x-api-key'], `${APP.keystring}:${APP.shared_secret}`);
  assert.equal(init.headers.Authorization, 'Bearer 111.access-ok');
});

test('call: each shop uses its own app keys', async () => {
  const own = { keystring: 'o'.repeat(24), shared_secret: 'p'.repeat(25) };
  const { api, fetchImpl } = setup(() => ({ json: {} }), { ...APP, shops: { 1001: grant(), 1002: grant({ app: own, access_token: '333.b' }) } });
  await api.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 1 }, shopCode: '1002' });
  assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], `${own.keystring}:${own.shared_secret}`);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer 333.b');
});

test('call: 401 → token dropped, refreshed and retried once', async () => {
  const { api, fetchImpl } = setup((url) => {
    if (url.includes('/oauth/token')) return { json: { access_token: '111.fresh', expires_in: 3600, refresh_token: '111.r2' } };
    return fetchImpl.calls.filter((c) => !c.url.includes('oauth')).length === 1 ? { status: 401, json: { error: 'invalid_token' } } : { json: { ok: 1 } };
  });
  const r = await api.call({ op: getOperation(spec, 'getMe'), shopCode: '1001' });
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(fetchImpl.calls.at(-1).init.headers.Authorization, 'Bearer 111.fresh');
});

test('call: 429 with long retry-after is reported as rate limit, not retried', async () => {
  const { api, fetchImpl } = setup(() => ({ status: 429, json: { error: 'too many' }, headers: { 'retry-after': '3600', 'x-remaining-today': '0' } }));
  await assert.rejects(api.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 1 }, shopCode: '1001' }), /限流.*还剩 0 次.*不要反复重试/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('call: Etsy error text is surfaced; network errors are flagged', async () => {
  const { api } = setup(() => ({ status: 400, json: { error: 'Invalid listing state' } }));
  await assert.rejects(api.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 1 }, shopCode: '1001' }), (e) => e.status === 400 && /Invalid listing state/.test(e.message));
  const { api: api2 } = setup(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(api2.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 1 }, shopCode: '1001' }), (e) => e.network === true);
});

test('call: scope-protected endpoint without authorization fails before any request', async () => {
  const { api, fetchImpl } = setup(() => ({ json: {} }), { ...APP, shops: {} });
  await assert.rejects(api.call({ op: getOperation(spec, 'getShopReceipts'), pathParams: { shop_id: 1 }, shopCode: '1001' }), /还没有授权/);
  assert.equal(fetchImpl.calls.length, 0);
  await api.call({ op: getOperation(spec, 'getShop'), pathParams: { shop_id: 1 }, shopCode: '1001' });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test('call: multipart upload sends the file bytes with its name', async () => {
  const dir = tmp();
  const img = join(dir, 'pic.jpg');
  writeFileSync(img, Buffer.from([1, 2, 3]));
  const { api, fetchImpl } = setup(() => ({ status: 201, json: { listing_image_id: 9 } }));
  await api.call({ op: getOperation(spec, 'uploadListingImage'), pathParams: { shop_id: 222, listing_id: 5 }, body: { image: img, rank: 1 }, shopCode: '1001' });
  const form = fetchImpl.calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('rank'), '1');
  assert.equal(form.get('image').name, 'pic.jpg');
  assert.equal(form.get('image').size, 3);
  await assert.rejects(loadUpload('relative.jpg', 'image'), /绝对路径/);
  await assert.rejects(loadUpload(join(dir, 'missing.jpg'), 'image'), /找不到文件/);
});

test('limiter: at most N starts per second', async () => {
  let t = 0;
  const waits = [];
  const limit = createLimiter({ perSecond: 2, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
  await Promise.all([limit(), limit(), limit()]);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 1000);
});

test('privacy: buyer name / address / email / messages / personalization hidden, country and totals kept', () => {
  const receipt = {
    receipt_id: 1, buyer_user_id: 9, buyer_email: 'b@x.com', name: 'Jane Doe', first_line: '1 Main St', city: 'X', zip: '1', country_iso: 'US',
    message_from_buyer: 'hi', gift_message: 'love', grandtotal: { amount: 1000, divisor: 100, currency_code: 'USD' },
    transactions: [{ variations: [{ formatted_name: 'Personalization', formatted_value: 'JANE' }, { formatted_name: 'Color', formatted_value: 'Red' }] }],
  };
  const { data, hidden } = redact({ results: [receipt] });
  const r = data.results[0];
  for (const k of ['buyer_email', 'name', 'first_line', 'city', 'zip', 'message_from_buyer', 'gift_message']) assert.equal(r[k], '[已隐藏]', k);
  assert.equal(r.country_iso, 'US');
  assert.equal(r.grandtotal.amount, 1000);
  assert.equal(r.transactions[0].variations[0].formatted_value, '[已隐藏]');
  assert.equal(r.transactions[0].variations[1].formatted_value, 'Red');
  assert.ok(hidden.includes('buyer_email'));
  assert.equal(receipt.name, 'Jane Doe', '不改原对象');
  // 卖家自定义的个性化问题名（property_id 54）和新版个性化问题（question_id）也要隐藏
  const custom = redact({ variations: [{ property_id: 54, formatted_name: 'Engraving name', formatted_value: 'JANE' }, { property_id: 0, question_id: 7, formatted_name: 'Your photo', formatted_value: 'https://x/upload.png' }, { property_id: 200, formatted_name: 'Size', formatted_value: 'L' }] }).data;
  assert.deepEqual(custom.variations.map((v) => v.formatted_value), ['[已隐藏]', '[已隐藏]', 'L']);
  assert.equal(redact({ user_id: 5, primary_email: 'me@x' }, { ownUserId: 5 }).data.primary_email, 'me@x');
  assert.equal(redact({ user_id: 6, primary_email: 'you@x' }, { ownUserId: 5 }).data.primary_email, '[已隐藏]');
});

test('shops: ETSY_SHOPS array, single container, fallback to authorized shops in the keys file', () => {
  const env = { ETSY_SHOPS: JSON.stringify([{ name: '美国店', container_code: '1111111111', default: true }, { name: '二店', container_code: '2222222222' }]) };
  const shops = parseShops(env);
  assert.equal(resolveShop(shops).code, '1111111111');
  assert.equal(resolveShop(shops, '二店').code, '2222222222');
  assert.equal(resolveShop(shops, '2222222222').name, '二店');
  assert.throws(() => resolveShop(shops, '三店'), /没有这家店/);
  assert.throws(() => parseShops({ ETSY_SHOPS: '[{"name":"a","container_code":"x"}]' }), /container_code/);
  assert.throws(() => parseShops({ ETSY_SHOPS: '[{"name":"a","container_code":"1111"},{"name":"a","container_code":"2222"}]' }), /重复/);
  assert.throws(() => resolveShop(parseShops({ ETSY_SHOPS: '[{"name":"a","container_code":"1111"},{"name":"b","container_code":"2222"}]' })), /有多家店/);
  assert.deepEqual(parseShops({ ETSY_CONTAINER_CODE: '1234' }), [{ name: '1234', code: '1234', isDefault: true }]);
  const fromKeys = parseShops({}, { shops: { 1001: grant(), 1002: { app: APP } } });
  assert.deepEqual(fromKeys.map((s) => [s.name, s.code]), [['TestShop', '1001']]);
  assert.throws(() => resolveShop([]), /还没有配置 Etsy 店铺/);
});
