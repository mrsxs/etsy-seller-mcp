import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from '../lib/etsy-api.mjs';
import { createTokenProvider } from '../lib/oauth.mjs';
import { getOperation, loadSpec, validateCall } from '../lib/spec.mjs';
import { createWrites, createWriteStore } from '../lib/writes.mjs';
import { APP, fakeFetch, grant, keysFile, noWait, tmp } from './helpers.mjs';

const spec = loadSpec();
const SHOP = { code: '1001', name: 'TestShop' };

/** 一个假的 Etsy：listing 状态放在 state 里，GET 读、PATCH 改 */
function setup({ handler, readOnly = false, scopes } = {}) {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant(scopes ? { scopes } : {}) } });
  const state = { listing: { listing_id: 5, title: 'Old', state: 'draft', price: { amount: 999, divisor: 100, currency_code: 'USD' }, views: 1 }, patched: 0 };
  const fetchImpl = fakeFetch(handler ?? ((url, init) => {
    if (url.endsWith('/v3/application/listings/5') && init.method === 'GET') return { json: state.listing };
    if (url.endsWith('/v3/application/shops/222/listings/5') && init.method === 'PATCH') {
      state.patched += 1;
      const body = new URLSearchParams(init.body);
      state.listing = { ...state.listing, title: body.get('title') ?? state.listing.title, state: body.get('state') ?? state.listing.state };
      return { json: state.listing };
    }
    return { status: 404, json: { error: 'not found' } };
  }));
  const tokens = createTokenProvider({ file, fetchImpl });
  const api = createApi({ tokens, fetchImpl, newLimiter: () => noWait });
  const store = createWriteStore({ dir: join(dir, 'data') });
  const writes = createWrites({ spec, api, store, dataDir: join(dir, 'data'), readOnly, fetchImpl });
  const grantOf = () => tokens.grantInfo('1001');
  const preview = (opId, params, body) => {
    const op = getOperation(spec, opId);
    return writes.preview({ op, call: validateCall(op, { params, body }), shop: SHOP, grant: tokens.grantInfo('1001') });
  };
  return { dir, state, fetchImpl, writes, store, preview, grantOf };
}

test('preview: reads the listing, shows before → after and the listing fee, changes nothing', async () => {
  const s = setup();
  const p = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New', state: 'active' });
  assert.match(p.preview_id, /^w[0-9a-f]{16}$/);
  assert.deepEqual(p.changes, [{ field: 'title', before: 'Old', after: 'New' }, { field: 'state', before: 'draft', after: 'active' }]);
  assert.ok(p.notes.some((n) => n.includes('0.20 美元')));
  assert.equal(p.before.price.amount, 9.99);
  assert.equal(s.state.patched, 0);
  assert.ok(s.fetchImpl.calls.every((c) => c.init.method === 'GET'));
});

test('apply: needs confirm: true; executes once; replay returns the stored result', async () => {
  const s = setup();
  const p = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New' });
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: false, grantOf: s.grantOf }), /confirm: true/);
  const r = await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf });
  assert.equal(r.applied, true);
  assert.equal(r.result.title, 'New');
  const again = await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf });
  assert.equal(again.already_applied, true);
  assert.equal(s.state.patched, 1);
  const log = readFileSync(join(s.dir, 'data', 'write-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => [l.operation, l.status, l.fields]), [['updateListing', 'done', ['title']]]);
});

test('apply: refuses when the listing changed after the preview (views changes are ignored)', async () => {
  const s = setup();
  const p = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New' });
  s.state.listing = { ...s.state.listing, views: 999 };
  const p2 = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New2' });
  s.state.listing = { ...s.state.listing, title: 'Changed elsewhere' };
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /在别处被改过/);
  await assert.rejects(s.writes.apply({ previewId: p2.preview_id, confirm: true, grantOf: s.grantOf }), /在别处被改过/);
  assert.equal(s.state.patched, 0);
  s.state.listing = { ...s.state.listing, title: 'Old', views: 5 };
  const p3 = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New3' });
  s.state.listing = { ...s.state.listing, views: 6, num_favorers: 3 };
  assert.equal((await s.writes.apply({ previewId: p3.preview_id, confirm: true, grantOf: s.grantOf })).applied, true);
});

test('apply: network failure → unknown; an idempotent change is resent on retry', async () => {
  let fail = true;
  const s2 = setup({
    handler: (url, init) => {
      if (init.method === 'GET') return { json: { listing_id: 5, title: 'Old', state: 'draft' } };
      if (fail) {
        fail = false;
        throw new TypeError('socket hang up');
      }
      return { json: { listing_id: 5, title: 'New' } };
    },
  });
  const q = await s2.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New' });
  await assert.rejects(s2.writes.apply({ previewId: q.preview_id, confirm: true, grantOf: s2.grantOf }), /结果不确定/);
  assert.equal(s2.store.load(q.preview_id).status, 'unknown');
  const r = await s2.writes.apply({ previewId: q.preview_id, confirm: true, grantOf: s2.grantOf });
  assert.equal(r.applied, true);
  assert.equal(s2.fetchImpl.calls.filter((c) => c.init.method === 'PATCH').length, 2);
});

test('apply: a create that may have gone through is not resent automatically', async () => {
  const s = setup({ handler: () => { throw new TypeError('socket hang up'); } });
  const body = { quantity: 1, title: 'T', description: 'D', price: 9.5, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 6450 };
  const p = await s.preview('createDraftListing', { shop_id: 222 }, body);
  assert.ok(p.notes.some((n) => n.includes('草稿')));
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /重发可能会重复/);
});

test('delete: preview refuses a missing object; retry after an uncertain delete reconciles via 404', async () => {
  const s = setup();
  await assert.rejects(s.preview('deleteShopSection', { shop_id: 222, shop_section_id: 77 }), /不存在/);
  let gone = false;
  let deletes = 0;
  const s2 = setup({
    handler: (url, init) => {
      if (init.method === 'GET') return gone ? { status: 404, json: { error: 'nope' } } : { json: { shop_section_id: 77, title: 'Kits' } };
      deletes += 1;
      gone = true;
      throw new TypeError('connection reset');
    },
  });
  const p = await s2.preview('deleteShopSection', { shop_id: 222, shop_section_id: 77 });
  assert.ok(p.notes.includes('删除不可恢复。'));
  await assert.rejects(s2.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s2.grantOf }), /结果不确定/);
  const r = await s2.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s2.grantOf });
  assert.equal(r.reconciled, true);
  assert.equal(deletes, 1);
});

test('upload: file content is pinned at preview; a changed file is refused', async () => {
  const s = setup({ handler: (url, init) => (init.method === 'GET' ? { json: { count: 0, results: [] } } : { status: 201, json: { listing_image_id: 1 } }) });
  const img = join(s.dir, 'a.jpg');
  writeFileSync(img, 'one');
  const p = await s.preview('uploadListingImage', { shop_id: 222, listing_id: 5 }, { image: img, rank: 1 });
  assert.match(p.changes[0].after, /上传 a\.jpg/);
  writeFileSync(img, 'two');
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /预检后变了/);
});

test('read-only mode and missing scopes block writes', async () => {
  const ro = setup({ readOnly: true });
  await assert.rejects(ro.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'x' }), /只读模式/);
  const noScope = setup({ scopes: ['listings_r'] });
  await assert.rejects(noScope.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'x' }), /listings_w/);
});

test('inventory preview shows every writable field: offerings, readiness_state_id and *_on_property', async () => {
  const s = setup({
    handler: () => ({ json: { price_on_property: [], products: [{ sku: 'A', property_values: [{ property_id: 200, property_name: 'Color', value_ids: [1], values: ['Red'] }], offerings: [{ price: { amount: 500, divisor: 100 }, quantity: 2, is_enabled: true, readiness_state_id: 1 }] }] } }),
  });
  const p = await s.preview('updateListingInventory', { listing_id: 5 }, {
    price_on_property: [200],
    products: [{ sku: 'A', property_values: [{ property_id: 200, value_ids: [1], values: ['Red'] }], offerings: [{ price: 5, quantity: 2, is_enabled: true, readiness_state_id: 99 }] }],
  });
  assert.deepEqual(p.changes.before.products[0].offerings, [{ price: 5, quantity: 2, enabled: true, readiness_state_id: 1 }]);
  assert.deepEqual(p.changes.after.products[0].offerings, [{ price: 5, quantity: 2, enabled: true, readiness_state_id: 99 }]);
  assert.deepEqual(p.changes.settings_changed, ['price_on_property']);
  assert.ok(p.notes.some((n) => n.includes('整组替换')));
});

test('uncertain retry: changed elsewhere in between → refused; already at target → reconciled without resending', async () => {
  let listing = { listing_id: 5, title: 'Old', state: 'draft' };
  let patches = 0;
  const s = setup({
    handler: (url, init) => {
      if (init.method === 'GET') return { json: listing };
      patches += 1;
      throw new TypeError('socket hang up');
    },
  });
  const p = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New' });
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  listing = { ...listing, title: 'Someone else' };
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /既不是改前也不是改后/);
  listing = { ...listing, title: 'New' };
  const r = await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf });
  assert.equal(r.reconciled, true);
  assert.equal(patches, 1);
});

test('response body lost after Etsy accepted the write, or a 5xx, is recorded as unknown (not failed)', async () => {
  const broken = () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 201 });
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant() } });
  const fetchImpl = async () => broken();
  const tokens = createTokenProvider({ file, fetchImpl });
  const api = createApi({ tokens, fetchImpl, newLimiter: () => noWait });
  const store = createWriteStore({ dir: join(dir, 'd') });
  const writes = createWrites({ spec, api, store, dataDir: join(dir, 'd'), fetchImpl });
  const op = getOperation(spec, 'createShopSection');
  const p = await writes.preview({ op, call: validateCall(op, { params: { shop_id: 222 }, body: { title: 'Kits' } }), shop: SHOP, grant: tokens.grantInfo('1001') });
  await assert.rejects(writes.apply({ previewId: p.preview_id, confirm: true, grantOf: () => tokens.grantInfo('1001') }), /结果不确定/);
  assert.equal(store.load(p.preview_id).status, 'unknown');

  const s5 = setup({ handler: () => ({ status: 503, json: { error: 'upstream' } }) });
  const q = await s5.preview('createShopSection', { shop_id: 222 }, { title: 'Kits' });
  await assert.rejects(s5.writes.apply({ previewId: q.preview_id, confirm: true, grantOf: s5.grantOf }), /结果不确定/);
  assert.equal(s5.store.load(q.preview_id).status, 'unknown');
});

test('two previews of the same listing applied in parallel: the second sees the first and is refused', async () => {
  const s = setup();
  const a = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'A' });
  const b = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'B' });
  const results = await Promise.allSettled([
    s.writes.apply({ previewId: a.preview_id, confirm: true, grantOf: s.grantOf }),
    s.writes.apply({ previewId: b.preview_id, confirm: true, grantOf: s.grantOf }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /在别处被改过/);
  assert.equal(s.state.patched, 1);
});

test('list snapshots are read page by page and compared on the target item only', async () => {
  const dests = Array.from({ length: 130 }, (_, i) => ({ shipping_profile_destination_id: i + 1, primary_cost: { amount: 100, divisor: 100 } }));
  const s = setup({
    handler: (url, init) => {
      if (init.method === 'GET') {
        const u = new URL(url);
        const off = Number(u.searchParams.get('offset') ?? 0);
        return { json: { count: dests.length, results: dests.slice(off, off + Number(u.searchParams.get('limit') ?? 25)) } };
      }
      return { json: {} };
    },
  });
  const params = { shop_id: 222, shipping_profile_id: 9, shipping_profile_destination_id: 126 };
  const p = await s.preview('updateShopShippingProfileDestination', params, { primary_cost: 2 });
  assert.deepEqual(p.changes, [{ field: 'primary_cost', before: { amount: 1, currency: undefined }, after: 2 }]);
  dests[3] = { ...dests[3], primary_cost: { amount: 999, divisor: 100 } }; // 别的目的地变了：不影响
  assert.equal((await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf })).applied, true);
  const q = await s.preview('updateShopShippingProfileDestination', params, { primary_cost: 3 });
  dests[125] = { ...dests[125], primary_cost: { amount: 500, divisor: 100 } }; // 目标（第 2 页）变了：拒绝
  await assert.rejects(s.writes.apply({ previewId: q.preview_id, confirm: true, grantOf: s.grantOf }), /在别处被改过/);
  await assert.rejects(s.preview('updateShopShippingProfileDestination', { ...params, shipping_profile_destination_id: 999 }, { primary_cost: 2 }), /不存在/);
});

test('uncertain inventory retry: reconciled only when settings and every variation match the request', async () => {
  let inv = { price_on_property: [], products: [{ sku: 'A', property_values: [{ property_id: 200, values: ['Red'] }], offerings: [{ price: { amount: 500, divisor: 100 }, quantity: 2, is_enabled: true, readiness_state_id: 1 }] }] };
  const s = setup({ handler: (url, init) => (init.method === 'GET' ? { json: inv } : (() => { throw new TypeError('reset'); })()) });
  const body = { price_on_property: [200], products: [{ sku: 'A', property_values: [{ property_id: 200, value_ids: [9], values: ['Red'] }], offerings: [{ price: 6, quantity: 2, is_enabled: true, readiness_state_id: 1 }] }] };
  const p = await s.preview('updateListingInventory', { listing_id: 5 }, body);
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  // 价格变了但 price_on_property 没变、规格值也不同：不能算成功
  inv = { ...inv, products: [{ ...inv.products[0], property_values: [{ property_id: 200, values: ['Blue'] }], offerings: [{ price: { amount: 600, divisor: 100 }, quantity: 2, is_enabled: true, readiness_state_id: 1 }] }] };
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /既不是改前也不是改后/);
  inv = { price_on_property: [200], products: [{ sku: 'A', property_values: [{ property_id: 200, property_name: 'Color', value_ids: [9], values: ['Red'] }], offerings: [{ price: { amount: 600, divisor: 100 }, quantity: 2, is_enabled: true, readiness_state_id: 1 }] }] };
  assert.equal((await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf })).reconciled, true);
});

test('uncertain retry: a money field already at the requested amount counts as done', async () => {
  let dest = { shipping_profile_destination_id: 7, primary_cost: { amount: 100, divisor: 100, currency_code: 'USD' } };
  const s = setup({
    handler: (url, init) => (init.method === 'GET' ? { json: { count: 1, results: [dest] } } : (() => { throw new TypeError('reset'); })()),
  });
  const p = await s.preview('updateShopShippingProfileDestination', { shop_id: 222, shipping_profile_id: 9, shipping_profile_destination_id: 7 }, { primary_cost: 2 });
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  dest = { ...dest, primary_cost: { amount: 200, divisor: 100, currency_code: 'USD' } };
  assert.equal((await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf })).reconciled, true);
});

test('personalization: empty question list means nothing to delete / delete already done', async () => {
  let questions = [{ question_id: 1, question_text: 'Name?' }];
  const s = setup({
    handler: (url, init) => (init.method === 'GET' ? { json: { personalization_questions: questions } } : (() => { questions = []; throw new TypeError('reset'); })()),
  });
  const p = await s.preview('deleteListingPersonalization', { shop_id: 222, listing_id: 5 });
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  assert.equal((await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf })).reconciled, true);
  await assert.rejects(s.preview('deleteListingPersonalization', { shop_id: 222, listing_id: 5 }), /不存在/);
});

test('featured_rank changes are part of the concurrency check; null cannot be sent in form bodies', async () => {
  const s = setup();
  const p = await s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { title: 'New' });
  s.state.listing = { ...s.state.listing, featured_rank: 3 };
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /在别处被改过/);
  await assert.rejects(async () => s.preview('updateListing', { shop_id: 222, listing_id: 5 }, { shop_section_id: null }), /不能用 null 清空/);
});

test('linking a file to a physical listing: snapshot covers listing, inventory and shipping profile; a change in any is caught', async () => {
  let profile = {
    shipping_profile_id: 77, title: 'Std',
    shipping_profile_destinations: [{ id: 1, destination_country_iso: 'US', primary_cost: { amount: 500, divisor: 100, currency_code: 'USD' }, secondary_cost: { amount: 200, divisor: 100, currency_code: 'USD' } }],
    shipping_profile_upgrades: [{ upgrade_name: 'Express', type: 0, price: { amount: 1000, divisor: 100, currency_code: 'USD' }, secondary_price: { amount: 300, divisor: 100 } }],
  };
  const s = setup({
    handler: (url, init) => {
      if (init.method !== 'GET') return { json: {} };
      if (url.endsWith('/listings/5')) return { json: { listing_id: 5, listing_type: 'physical', shipping_profile_id: 77, has_variations: true } };
      if (url.endsWith('/listings/5/inventory')) return { json: { products: [{ sku: 'A', offerings: [] }, { sku: 'B', offerings: [] }] } };
      if (url.endsWith('/shipping-profiles/77')) return { json: profile };
      return { status: 404, json: {} };
    },
  });
  const p = await s.preview('uploadListingFile', { shop_id: 222, listing_id: 5 }, { listing_file_id: 3 });
  assert.match(p.notes.join(' '), /变成数字商品.*运费模板「Std」，1 个目的地.*2 个规格/);
  assert.equal(p.before.inventory.products.length, 2);
  assert.deepEqual(p.before.shipping_profile.destinations, [{ to: 'US', first_item: 5, each_additional: 2, currency: 'USD', mail_class: undefined, delivery_days: undefined }]);
  assert.deepEqual(p.before.shipping_profile.upgrades, [{ name: 'Express', type: 0, price: 10, each_additional: 3, currency: 'USD' }]);
  profile = { ...profile, shipping_profile_destinations: [{ ...profile.shipping_profile_destinations[0], primary_cost: { amount: 900, divisor: 100, currency_code: 'USD' } }] };
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /在别处被改过/);
});

test('uncertain inventory retry: a custom variation name that did not change blocks reconciliation', async () => {
  const mk = (name, cents) => ({ products: [{ sku: 'A', property_values: [{ property_id: 513, property_name: name, value_ids: [1], values: ['Oak'] }], offerings: [{ price: { amount: cents, divisor: 100 }, quantity: 1, is_enabled: true, readiness_state_id: 1 }] }] });
  let inv = mk('Material', 500);
  const s = setup({ handler: (url, init) => (init.method === 'GET' ? { json: inv } : (() => { throw new TypeError('reset'); })()) });
  const body = { products: [{ sku: 'A', property_values: [{ property_id: 513, property_name: 'Finish', value_ids: [1], values: ['Oak'] }], offerings: [{ price: 6, quantity: 1, is_enabled: true, readiness_state_id: 1 }] }] };
  const p = await s.preview('updateListingInventory', { listing_id: 5 }, body);
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /结果不确定/);
  inv = mk('Material', 600);
  await assert.rejects(s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf }), /既不是改前也不是改后/);
  inv = mk('Finish', 600);
  assert.equal((await s.writes.apply({ previewId: p.preview_id, confirm: true, grantOf: s.grantOf })).reconciled, true);
});

test('one Etsy shop authorized under two HubStudio environments shares one write lock', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant(), 1002: grant() } });
  let listing = { listing_id: 5, title: 'Old' };
  const fetchImpl = fakeFetch(async (url, init) => {
    if (init.method === 'GET') return { json: listing };
    await new Promise((r) => setTimeout(r, 30));
    listing = { ...listing, title: new URLSearchParams(init.body).get('title') };
    return { json: listing };
  });
  const tokens = createTokenProvider({ file, fetchImpl });
  const api = createApi({ tokens, fetchImpl, newLimiter: () => noWait });
  const store = createWriteStore({ dir: join(dir, 'd') });
  const writes = createWrites({ spec, api, store, dataDir: join(dir, 'd'), fetchImpl });
  const op = getOperation(spec, 'updateListing');
  const mk = (code, title) => writes.preview({ op, call: validateCall(op, { params: { shop_id: 222, listing_id: 5 }, body: { title } }), shop: { code, name: code }, grant: tokens.grantInfo(code) });
  const a = await mk('1001', 'A');
  const b = await mk('1002', 'B');
  const grantOf = (c) => tokens.grantInfo(c);
  const results = await Promise.allSettled([writes.apply({ previewId: a.preview_id, confirm: true, grantOf }), writes.apply({ previewId: b.preview_id, confirm: true, grantOf })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});
