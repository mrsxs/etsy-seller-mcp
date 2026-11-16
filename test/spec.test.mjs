import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPath, describeOperation, encodeBody, getOperation, isWrite, loadSpec, searchCatalog, validateCall } from '../lib/spec.mjs';
import { isIdempotent, snapshotOperation } from '../lib/writes.mjs';

const spec = loadSpec();

test('spec: 107 operations with unique ids, no HTML left in descriptions', () => {
  assert.equal(spec.operations.length, 107);
  assert.equal(new Set(spec.operations.map((o) => o.id)).size, 107);
  assert.ok(!JSON.stringify(spec.operations).includes('wt-badge'));
  assert.equal(isWrite(getOperation(spec, 'tokenScopes')), false);
  assert.equal(spec.operations.filter(isWrite).length, 42);
});

test('catalog: Chinese keywords map to English, filters by write / tag', () => {
  const r = searchCatalog(spec, { query: '订单' });
  assert.ok(r.operations.some((o) => o.operation === 'getShopReceipts'));
  const w = searchCatalog(spec, { query: '库存', write: true });
  assert.deepEqual(w.operations.map((o) => o.operation), ['updateListingInventory']);
  assert.ok(searchCatalog(spec, { tag: 'shop section' }).operations.every((o) => o.tag === 'Shop Section'));
  assert.throws(() => getOperation(spec, 'getShopReceipt_'), /是不是/);
});

test('validateCall: coerces types, reports every problem at once', () => {
  const op = getOperation(spec, 'getShopReceipts');
  const ok = validateCall(op, { params: { shop_id: '222', limit: '50', was_paid: 'true' } });
  assert.deepEqual(ok.pathParams, { shop_id: 222 });
  assert.deepEqual(ok.query, { limit: 50, was_paid: true });
  assert.throws(() => validateCall(op, { params: { limit: 500, sort_on: 'x', nope: 1 } }), (e) => {
    assert.match(e.message, /nope 不是这个接口的参数/);
    assert.match(e.message, /limit 不能大于 100/);
    assert.match(e.message, /sort_on 只能是/);
    assert.match(e.message, /缺少参数 shop_id/);
    return true;
  });
});

test('validateCall: request body fields, required fields, commas in form arrays', () => {
  const op = getOperation(spec, 'createDraftListing');
  assert.throws(() => validateCall(op, { params: { shop_id: 1 } }), /缺少请求体 body.*title/);
  const body = { quantity: 1, title: 'T', description: 'D', price: 9.5, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 6450, tags: 'a, b' };
  const r = validateCall(op, { params: { shop_id: 1 }, body });
  assert.deepEqual(r.body.tags, ['a', 'b']);
  assert.throws(() => validateCall(op, { params: { shop_id: 1 }, body: { ...body, tags: ['a,b'] } }), /不能含英文逗号/);
  assert.throws(() => validateCall(op, { params: { shop_id: 1 }, body: { ...body, who_made: 'robot' } }), /who_made 只能是/);
  assert.throws(() => validateCall(op, { params: { shop_id: 1 }, body: { ...body, colour: 'red' } }), /colour 不是这个接口的字段/);
});

test('validateCall: nested JSON body (inventory products) is checked recursively', () => {
  const op = getOperation(spec, 'updateListingInventory');
  const good = { products: [{ sku: 'A', property_values: [], offerings: [{ price: 9.99, quantity: 3, is_enabled: true, readiness_state_id: 5 }] }] };
  assert.ok(validateCall(op, { params: { listing_id: 1 }, body: good }));
  assert.throws(() => validateCall(op, { params: { listing_id: 1 }, body: { products: [{ offerings: [{ price: 'cheap' }] }] } }), /products\[0\]\.offerings\[0\]\.price 应是数字/);
});

test('buildPath / encodeBody: path escaping, arrays joined with commas, booleans as text', () => {
  const op = getOperation(spec, 'getListingsByListingIds');
  assert.equal(buildPath(op, { query: { listing_ids: [1, 2], includes: ['Images'] } }), '/v3/application/listings/batch?listing_ids=1%2C2&includes=Images');
  const t = getOperation(spec, 'getListingTranslation');
  assert.equal(buildPath(t, { pathParams: { shop_id: 1, listing_id: 2, language: 'a/b' } }), '/v3/application/shops/1/listings/2/translations/a%2Fb');
  const form = encodeBody(getOperation(spec, 'updateListing'), { tags: ['x', 'y'], is_supply: false });
  assert.equal(form.payload, 'tags=x%2Cy&is_supply=false');
  assert.match(form.contentType, /x-www-form-urlencoded/);
  assert.equal(encodeBody(getOperation(spec, 'updateListingInventory'), { products: [] }).contentType, 'application/json');
  assert.equal(encodeBody(getOperation(spec, 'uploadListingImage'), { image: '/a.jpg' }).multipart, true);
});

test('every PUT / PATCH / DELETE has a snapshot query whose path params it can supply', () => {
  for (const op of spec.operations.filter((o) => isWrite(o) && o.method !== 'POST')) {
    const snap = snapshotOperation(spec, op);
    assert.ok(snap, `${op.id} 没有改前快照`);
    const have = new Set([...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    for (const m of snap.path.matchAll(/\{(\w+)\}/g)) assert.ok(have.has(m[1]), `${op.id} → ${snap.id} 缺 ${m[1]}`);
    assert.ok(isIdempotent(op));
  }
  assert.equal(isIdempotent(getOperation(spec, 'createDraftListing')), false);
});

test('describeOperation tells how to call reads and writes', () => {
  assert.match(describeOperation(getOperation(spec, 'getShop')).how_to_call, /etsy_api_call/);
  const d = describeOperation(getOperation(spec, 'updateListing'));
  assert.match(d.how_to_call, /etsy_write_preview/);
  assert.ok(d.body.fields.title);
});
