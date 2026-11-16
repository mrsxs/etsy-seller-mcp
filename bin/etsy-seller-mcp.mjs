#!/usr/bin/env node
// Etsy 卖家 MCP（stdio）：Etsy Open API v3 全部 107 个接口（目录搜索、说明、调用），常用查询的组合工具，
// 写接口一律预检 → 用户确认 → 执行。店铺授权在这家店自己的 HubStudio 浏览器环境里完成；多家店各用各的 Seller app。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { authorizeShop, DEFAULT_REDIRECT_URI, finishManualAuth, startManualAuth } from '../lib/auth-flow.mjs';
import { ApiError, createApi } from '../lib/etsy-api.mjs';
import { HubStudioError } from '../lib/hubstudio.mjs';
import { LockBusyError } from '../lib/lock.mjs';
import { ALL_SCOPES, AuthError, authHint, createTokenProvider, defaultKeysFile, loadKeys, READ_SCOPES } from '../lib/oauth.mjs';
import { PRIVACY_NOTE, redact } from '../lib/privacy.mjs';
import { parseShops, resolveShop, ShopConfigError } from '../lib/shops.mjs';
import { describeOperation, getOperation, isWrite, loadSpec, searchCatalog, SpecError, validateCall } from '../lib/spec.mjs';
import { createWrites, createWriteStore, money, WriteError } from '../lib/writes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = process.env.ETSY_DATA_DIR || join(homedir(), '.etsy-seller-mcp');
const KEYS_FILE = defaultKeysFile();
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.ETSY_READ_ONLY ?? '');

class QueryError extends Error {}
const USER_ERRORS = [QueryError, SpecError, AuthError, ApiError, WriteError, ShopConfigError, HubStudioError, LockBusyError];
const isUserError = (e) => USER_ERRORS.some((C) => e instanceof C);

const spec = loadSpec();
const tokens = createTokenProvider({ file: KEYS_FILE });
// ETSY_API_BASE 只给测试用（指向本机假的 Etsy 服务）
const api = createApi({ tokens, userAgent: `etsy-seller-mcp/${VERSION}`, ...(process.env.ETSY_API_BASE ? { base: process.env.ETSY_API_BASE } : {}) });
const writes = createWrites({ spec, api, store: createWriteStore({ dir: DATA_DIR }), dataDir: DATA_DIR, readOnly: READ_ONLY });

// ---- 店铺 ----
function keysOrNull() {
  try {
    return loadKeys(KEYS_FILE);
  } catch {
    return null;
  }
}
const shopsNow = () => parseShops(process.env, keysOrNull());
const shopFor = (ref) => resolveShop(shopsNow(), ref);
/** 授权信息；密钥文件不存在、没授权时返回 null */
function grantOrNull(shop) {
  if (!shop) return null;
  try {
    return tokens.grantInfo(shop.code);
  } catch {
    return null;
  }
}
function grantFor(shop) {
  const g = tokens.grantInfo(shop.code);
  if (!g) throw new AuthError(`「${shop.name}」（HubStudio 环境 ${shop.code}）还没有授权 Etsy 接口：在终端运行「${authHint(shop.code)}」，在这家店的 HubStudio 浏览器里点 Grant access`);
  return g;
}

// ---- 调接口 ----
/** 路径里的 shop_id / user_id 不填时用这家店的；写操作只能改本店 */
function fillShopParams(op, params, shop, { write = false } = {}) {
  const p = { ...(params ?? {}) };
  const needs = (n) => op.path.includes(`{${n}}`);
  if (!needs('shop_id') && !needs('user_id') && !write) return { params: p, grant: null };
  const grant = grantFor(shop);
  if (needs('shop_id')) {
    if (p.shop_id === undefined || p.shop_id === '') p.shop_id = grant.shop_id;
    else if (write && Number(p.shop_id) !== Number(grant.shop_id)) throw new QueryError(`只能改本店（${grant.shop_name ?? shop.name}，shop_id ${grant.shop_id}）的数据`);
  }
  if (needs('user_id') && (p.user_id === undefined || p.user_id === '')) p.user_id = grant.user_id;
  return { params: p, grant };
}

/** 调一个查询接口，返回脱敏后的数据 */
async function getOp(id, shop, params = {}, { auth } = {}) {
  const op = getOperation(spec, id);
  const filled = fillShopParams(op, params, shop);
  const call = validateCall(op, { params: filled.params });
  const r = await api.call({ op, ...call, shopCode: shop?.code, auth });
  return redact(r.data, { ownUserId: (filled.grant ?? grantOrNull(shop))?.user_id ?? null }).data;
}

/** 按 limit / offset 翻页，从 start 开始最多 max 条（Etsy 的 offset 上限 12000） */
async function getAll(id, shop, params, max, start = 0) {
  const out = [];
  let count = null;
  for (let offset = start; out.length < max && offset <= 12000; offset += 100) {
    const page = await getOp(id, shop, { ...params, limit: Math.min(100, max - out.length), offset });
    count = page?.count ?? count;
    const rows = page?.results ?? [];
    out.push(...rows);
    if (rows.length < Math.min(100, max - out.length + rows.length)) break;
  }
  return { results: out, count };
}

const date = (ts) => (Number.isFinite(Number(ts)) && ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : null);
const amount = (m) => (m && typeof m === 'object' ? money(m).amount : m);
const nowSec = () => Math.floor(Date.now() / 1000);
const round2 = (x) => Math.round(x * 100) / 100;

// ---- 工具实现 ----
function shops() {
  const list = shopsNow();
  return {
    read_only: READ_ONLY,
    keys_file: KEYS_FILE,
    shops: list.map((s) => {
      const grant = grantOrNull(s);
      return {
        name: s.name,
        hubstudio_container: s.code,
        default: s.isDefault,
        authorized: Boolean(grant),
        ...(grant ? { shop_id: grant.shop_id, shop_name: grant.shop_name, scopes: grant.scopes, authorization_expires: grant.refresh_token_expires_at?.slice(0, 10) } : { how_to_authorize: authHint(s.code) }),
      };
    }),
  };
}

async function shopOverview({ shop: ref }) {
  const shop = shopFor(ref);
  const s = await getOp('getShop', shop);
  const [sections, profiles, returns] = await Promise.allSettled([
    getOp('getShopSections', shop),
    getOp('getShopShippingProfiles', shop),
    getOp('getShopReturnPolicies', shop),
  ]);
  const ok = (r, f) => (r.status === 'fulfilled' ? f(r.value) : { error: r.reason?.message });
  return {
    shop: {
      shop_id: s.shop_id, shop_name: s.shop_name, title: s.title, url: s.url, currency: s.currency_code, created: s.create_date ? date(s.create_date) : date(s.created_timestamp),
      active_listings: s.listing_active_count, digital_listings: s.digital_listing_count, sold: s.transaction_sold_count, favorites: s.num_favorers,
      review_average: s.review_average, review_count: s.review_count, is_vacation: s.is_vacation, vacation_message: s.vacation_message || undefined,
      ships_from: s.shipping_from_country_iso, languages: s.languages, announcement: s.announcement ? String(s.announcement).slice(0, 300) : undefined,
    },
    sections: ok(sections, (v) => (v.results ?? []).map((x) => ({ id: x.shop_section_id, title: x.title, active_listings: x.active_listing_count }))),
    shipping_profiles: ok(profiles, (v) => (v.results ?? []).map((x) => ({
      id: x.shipping_profile_id, title: x.title, origin: x.origin_country_iso, processing_days: [x.min_processing_days ?? x.processing_days_display_label, x.max_processing_days].filter((y) => y !== undefined && y !== null).join('–') || undefined,
      destinations: (x.shipping_profile_destinations ?? []).length,
    }))),
    return_policies: ok(returns, (v) => (v.results ?? []).map((x) => ({ id: x.return_policy_id, accepts_returns: x.accepts_returns, accepts_exchanges: x.accepts_exchanges, deadline_days: x.return_deadline }))),
  };
}

/** Etsy 返回的标题里有 HTML 实体（&quot; &amp; 等） */
const ENTITIES = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const unescape = (s) => (typeof s === 'string' ? s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
}) : s);

const listingRow = (l) => ({
  listing_id: l.listing_id, title: unescape(l.title), state: l.state, price: amount(l.converted_price ?? l.price), currency: (l.converted_price ?? l.price)?.currency_code, quantity: l.quantity,
  favorites: l.num_favorers, sku: l.skus?.length ? l.skus : undefined, tags: l.tags, section_id: l.shop_section_id ?? undefined,
  taxonomy_id: l.taxonomy_id, has_variations: l.has_variations, created: date(l.created_timestamp), updated: date(l.updated_timestamp), expires: date(l.ending_timestamp), url: l.url,
});

async function listings({ shop: ref, state = 'active', keyword, limit = 25, offset = 0, sort_on = 'created', sort_order = 'desc' }) {
  const shop = shopFor(ref);
  if (keyword) {
    const all = await getAll('getListingsByShop', shop, { state, sort_on, sort_order }, 1000);
    const k = keyword.toLowerCase();
    const hit = all.results.filter((l) => `${l.title} ${(l.tags ?? []).join(' ')} ${(l.skus ?? []).join(' ')}`.toLowerCase().includes(k));
    return { state, keyword, scanned: all.results.length, total_in_state: all.count, matched: hit.length, listings: hit.slice(offset, offset + limit).map(listingRow) };
  }
  const page = await getOp('getListingsByShop', shop, { state, limit, offset, sort_on, sort_order });
  return { state, total: page.count, offset, listings: (page.results ?? []).map(listingRow) };
}

const inventoryRows = (inv) => (inv?.products ?? []).map((p) => ({
  product_id: p.product_id, sku: p.sku || undefined,
  variation: (p.property_values ?? []).map((v) => `${v.property_name}=${(v.values ?? []).join('/')}`).join('; ') || undefined,
  offerings: (p.offerings ?? []).map((o) => ({ price: amount(o.price), quantity: o.quantity, enabled: o.is_enabled })),
}));

async function listingDetail({ shop: ref, listing_id }) {
  const shop = shopFor(ref);
  const l = await getOp('getListing', shop, { listing_id, includes: ['Images', 'Videos', 'Translations', 'Personalization'] });
  let inventory;
  try {
    inventory = inventoryRows(await getOp('getListingInventory', shop, { listing_id }));
  } catch (err) {
    inventory = { error: err.message };
  }
  return {
    ...listingRow(l),
    description: l.description,
    materials: l.materials, styles: l.style, who_made: l.who_made, when_made: l.when_made, is_supply: l.is_supply,
    shipping_profile_id: l.shipping_profile_id, return_policy_id: l.return_policy_id, processing_days: [l.processing_min, l.processing_max],
    weight: l.item_weight ? `${l.item_weight} ${l.item_weight_unit}` : undefined,
    dimensions: l.item_length ? `${l.item_length}×${l.item_width}×${l.item_height} ${l.item_dimensions_unit}` : undefined,
    is_personalizable: l.is_personalizable, should_auto_renew: l.should_auto_renew, language: l.language,
    images: (l.images ?? []).map((i) => ({ listing_image_id: i.listing_image_id, rank: i.rank, url: i.url_570xN, alt_text: i.alt_text || undefined })),
    videos: (l.videos ?? []).map((v) => ({ video_id: v.video_id, state: v.video_state, url: v.video_url })),
    // translations 是按语言代码索引的对象（也兼容数组）
    translations: Array.isArray(l.translations) ? l.translations.map((t) => t.language) : Object.keys(l.translations ?? {}),
    inventory,
  };
}

async function inventory({ shop: ref, listing_ids }) {
  const shop = shopFor(ref);
  if (!listing_ids.length || listing_ids.length > 100) throw new QueryError('listing_ids 要 1~100 个');
  const r = await getOp('getListingsInventoryByListingIds', shop, { listing_ids });
  return { listings: (r.results ?? []).map((x) => ({ listing_id: x.listing_id, products: inventoryRows(x.inventory ?? x) })) };
}

async function orders({ shop: ref, days = 30, was_paid, was_shipped, was_canceled, max_receipts = 300 }) {
  const shop = shopFor(ref);
  const params = { min_created: nowSec() - days * 86400, max_created: nowSec(), sort_on: 'created', sort_order: 'desc' };
  if (was_paid !== undefined) params.was_paid = was_paid;
  if (was_shipped !== undefined) params.was_shipped = was_shipped;
  if (was_canceled !== undefined) params.was_canceled = was_canceled;
  const all = await getAll('getShopReceipts', shop, params, max_receipts);
  const totals = {};
  const items = new Map();
  let paid = 0;
  let shipped = 0;
  let canceled = 0;
  const rows = all.results.map((r) => {
    const cur = r.grandtotal?.currency_code ?? '?';
    totals[cur] ??= { orders: 0, grandtotal: 0, subtotal: 0, shipping: 0, tax: 0, discount: 0 };
    const t = totals[cur];
    t.orders += 1;
    t.grandtotal += amount(r.grandtotal) ?? 0;
    t.subtotal += amount(r.subtotal) ?? 0;
    t.shipping += amount(r.total_shipping_cost) ?? 0;
    t.tax += amount(r.total_tax_cost) ?? 0;
    t.discount += amount(r.discount_amt) ?? 0;
    if (r.is_paid) paid += 1;
    if (r.is_shipped) shipped += 1;
    if (/cancel/i.test(r.status ?? '')) canceled += 1;
    for (const tx of r.transactions ?? []) {
      const k = tx.listing_id;
      const it = items.get(k) ?? { listing_id: k, title: tx.title, quantity: 0, receipts: new Set() };
      it.quantity += tx.quantity ?? 0;
      it.receipts.add(r.receipt_id); // 同一单买了同一商品的几个规格只算一单
      items.set(k, it);
    }
    return {
      receipt_id: r.receipt_id, created: date(r.created_timestamp), status: r.status, paid: r.is_paid, shipped: r.is_shipped, country: r.country_iso,
      items: (r.transactions ?? []).map((tx) => ({
        listing_id: tx.listing_id, title: tx.title, quantity: tx.quantity, price: amount(tx.price), sku: tx.sku || undefined,
        variations: (tx.variations ?? []).map((v) => `${v.formatted_name}: ${v.formatted_value}`).join('; ') || undefined,
      })),
      subtotal: amount(r.subtotal), shipping: amount(r.total_shipping_cost), tax: amount(r.total_tax_cost), discount: amount(r.discount_amt), grandtotal: amount(r.grandtotal), currency: cur,
      shipments: (r.shipments ?? []).map((s) => ({ carrier: s.carrier_name, shipped: date(s.shipment_notification_timestamp), has_tracking: Boolean(s.tracking_code) })),
      refunds: (r.refunds ?? []).length ? (r.refunds ?? []).map((x) => ({ amount: amount(x.amount), reason: x.reason, date: date(x.created_timestamp) })) : undefined,
    };
  });
  for (const t of Object.values(totals)) for (const k of Object.keys(t)) if (k !== 'orders') t[k] = round2(t[k]);
  return {
    days, fetched: rows.length, total_matching: all.count, truncated: all.count > rows.length || undefined,
    summary: { paid, shipped, canceled, by_currency: totals },
    top_listings: [...items.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10)
      .map(({ receipts, ...it }) => ({ ...it, orders: receipts.size })),
    orders: rows,
    privacy: PRIVACY_NOTE,
  };
}

const ledgerOrder = (a, b) => (b.created_timestamp - a.created_timestamp) || ((b.sequence_number ?? 0) - (a.sequence_number ?? 0));

async function finance({ shop: ref, days = 30, max_entries = 1000 }) {
  const shop = shopFor(ref);
  const window = { min_created: nowSec() - days * 86400, max_created: nowSec() };
  const ID = 'getShopPaymentAccountLedgerEntries';
  // 账本按时间分页（官方是从早到晚）；超过 max_entries 时取最新的那一段，余额和「最近」才对
  const head = await getOp(ID, shop, { ...window, limit: 1, offset: 0 });
  const total = head?.count ?? 0;
  let start = 0;
  if (total > max_entries) {
    const tail = await getOp(ID, shop, { ...window, limit: 1, offset: Math.min(total - 1, 12000) });
    const first = head.results?.[0];
    const last = tail.results?.[0];
    if (first && last && ledgerOrder(first, last) >= 0) start = total - max_entries; // 从早到晚：取尾部
  }
  // Etsy 的 offset 最大 12000（每页 100 条），最新的流水在这之外就拿不到当前余额
  const tooMany = () => new QueryError(`这段时间有 ${total} 笔流水，最新的超出了 Etsy 能翻到的范围（offset ≤ 12000）：把 days 调小`);
  if (start > 0 && total - 1 > 12000 + 99) throw tooMany();
  const all = await getAll(ID, shop, window, max_entries, start);
  if (total && start + all.results.length < Math.min(total, start + max_entries)) throw tooMany();
  all.results.sort(ledgerOrder);
  const byType = {};
  const latest = all.results[0] ?? null;
  for (const e of all.results) {
    const k = `${e.ledger_type ?? e.reference_type ?? '?'}|${e.currency}`;
    byType[k] ??= { type: e.ledger_type ?? e.reference_type, description: e.description, currency: e.currency, count: 0, credit: 0, debit: 0, net: 0 };
    const t = byType[k];
    const a = (e.amount ?? 0) / 100;
    t.count += 1;
    if (a >= 0) t.credit += a;
    else t.debit += a;
    t.net += a;
  }
  const rows = Object.values(byType).map((t) => ({ ...t, credit: round2(t.credit), debit: round2(t.debit), net: round2(t.net) })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const net = {};
  for (const t of rows) net[t.currency] = round2((net[t.currency] ?? 0) + t.net);
  return {
    days, entries: all.results.length, total_matching: total, truncated: total > all.results.length ? `只汇总了最新的 ${all.results.length} 笔（共 ${total} 笔）` : undefined,
    balance_now: latest ? { amount: latest.balance / 100, currency: latest.currency, as_of: date(latest.created_timestamp) } : null,
    net_by_currency: net,
    by_type: rows,
    recent: all.results.slice(0, 20).map((e) => ({ date: date(e.created_timestamp), type: e.ledger_type, description: e.description, amount: (e.amount ?? 0) / 100, currency: e.currency, reference: e.reference_type ? `${e.reference_type} ${e.reference_id ?? ''}`.trim() : undefined })),
    note: '账本金额按最小货币单位记，已除以 100（如 -20 = -0.20 美元刊登费）。',
  };
}

async function reviews({ shop: ref, days = 90, limit = 30 }) {
  const shop = shopFor(ref);
  const all = await getAll('getReviewsByShop', shop, { min_created: nowSec() - days * 86400, max_created: nowSec() }, 1000);
  all.results.sort((a, b) => (b.created_timestamp ?? 0) - (a.created_timestamp ?? 0));
  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  for (const r of all.results) {
    dist[r.rating] = (dist[r.rating] ?? 0) + 1;
    sum += r.rating ?? 0;
  }
  const n = all.results.length;
  return {
    days, count: n, average: n ? round2(sum / n) : null, distribution: dist,
    low_ratings: all.results.filter((r) => r.rating <= 3).slice(0, 20).map((r) => ({ rating: r.rating, listing_id: r.listing_id, date: date(r.created_timestamp), review: r.review ? String(r.review).slice(0, 400) : '' })),
    recent: all.results.slice(0, limit).map((r) => ({ rating: r.rating, listing_id: r.listing_id, date: date(r.created_timestamp), language: r.language, review: r.review ? String(r.review).slice(0, 400) : '' })),
  };
}

let taxonomyCache = null;
async function categorySearch({ query, limit = 20 }) {
  if (!taxonomyCache || Date.now() - taxonomyCache.at > 24 * 3600_000) {
    let shop = null;
    try {
      shop = shopFor();
    } catch {
      // 没配店也能查类目（用默认应用）
    }
    const r = await getOp('getSellerTaxonomyNodes', shop);
    const flat = [];
    const walk = (nodes, path) => {
      for (const n of nodes ?? []) {
        const p = [...path, n.name];
        flat.push({ taxonomy_id: n.id, name: n.name, path: p.join(' > '), leaf: !(n.children ?? []).length });
        walk(n.children, p);
      }
    };
    walk(r.results, []);
    taxonomyCache = { at: Date.now(), flat };
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = taxonomyCache.flat.filter((n) => words.every((w) => n.path.toLowerCase().includes(w)));
  hits.sort((a, b) => Number(b.leaf) - Number(a.leaf) || a.path.length - b.path.length);
  return { total: hits.length, categories: hits.slice(0, limit), hint: '刊登要用叶子类目（leaf: true）；类目属性用 etsy_api_call 调 getPropertiesByTaxonomyId' };
}

async function marketSearch({ keywords, limit = 25, offset = 0, sort_on = 'score', min_price, max_price, taxonomy_id, shop_location, currency = 'USD' }) {
  let shop = null;
  try {
    shop = shopFor();
  } catch {
    // 公开接口，没配店也能查
  }
  const params = { keywords, limit, offset, sort_on, sort_order: 'desc', currency };
  if (min_price !== undefined) params.min_price = min_price;
  if (max_price !== undefined) params.max_price = max_price;
  if (taxonomy_id !== undefined) params.taxonomy_id = taxonomy_id;
  if (shop_location) params.shop_location = shop_location;
  const r = await getOp('findAllListingsActive', shop, params, { auth: 'none' });
  const rows = (r.results ?? []).map(listingRow);
  const prices = rows.filter((x) => x.currency === currency && typeof x.price === 'number').map((x) => x.price).sort((a, b) => a - b);
  return {
    keywords, total: r.count, offset,
    price: prices.length ? { min: prices[0], median: prices[Math.floor(prices.length / 2)], max: prices.at(-1), currency, of: prices.length } : null,
    listings: rows.map(({ sku, section_id, ...x }) => ({ ...x, shop_id: (r.results ?? []).find((l) => l.listing_id === x.listing_id)?.shop_id })),
  };
}

function catalog({ query, tag, write, limit = 120 }) {
  return searchCatalog(spec, { query, tag, write, limit });
}

function describe({ operation }) {
  return describeOperation(getOperation(spec, operation));
}

const MAX_RESULT_CHARS = 150_000;

async function apiCall({ operation, params = {}, shop: ref }) {
  const op = getOperation(spec, operation);
  if (isWrite(op)) throw new QueryError(`${op.id} 是写操作：先用 etsy_write_preview 预检，用户确认后用 etsy_write_apply 执行`);
  let shop = null;
  try {
    shop = shopFor(ref);
  } catch (err) {
    if (ref !== undefined || op.scopes.length || /\{(shop_id|user_id)\}/.test(op.path)) throw err;
  }
  let data;
  if (op.id === 'tokenScopes') {
    // 查这家店当前令牌有哪些权限（令牌本身不出现在结果里）
    if (!shop) throw new QueryError('tokenScopes 要指定已授权的店铺');
    grantFor(shop);
    const r = await api.call({ op, body: { token: await tokens.userToken(shop.code) }, shopCode: shop.code });
    data = r.data;
  } else {
    data = await getOp(op.id, shop, params);
  }
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESULT_CHARS) return { operation: op.id, data };
  if (Array.isArray(data?.results)) {
    let n = data.results.length;
    while (n > 1 && JSON.stringify(data.results.slice(0, n)).length > MAX_RESULT_CHARS) n = Math.floor(n / 2);
    return { operation: op.id, data: { ...data, results: data.results.slice(0, n) }, truncated: `结果太大，只返回前 ${n} 条（共 ${data.results.length} 条）；用 limit / offset 分页` };
  }
  return { operation: op.id, truncated: '结果太大，已截断', data_preview: text.slice(0, MAX_RESULT_CHARS) };
}

async function writePreview({ operation, params = {}, body, shop: ref }) {
  const op = getOperation(spec, operation);
  if (!isWrite(op)) throw new QueryError(`${op.id} 是查询接口，用 etsy_api_call`);
  const shop = shopFor(ref);
  const filled = fillShopParams(op, params, shop, { write: true });
  const call = validateCall(op, { params: filled.params, body });
  return writes.preview({ op, call, shop, grant: filled.grant });
}

async function writeApply({ preview_id, confirm }) {
  return writes.apply({ previewId: preview_id, confirm, grantOf: (code) => tokens.grantInfo(code) });
}

// ---- 工具定义 ----
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const shopArg = { type: 'string', description: '店铺名或 HubStudio 环境 ID（不填 = 默认店；etsy_shops 查看）' };
const RO = { readOnlyHint: true, openWorldHint: true };
const LOCAL_RO = { readOnlyHint: true, openWorldHint: false };
const enumOf = (opId, name) => getOperation(spec, opId).params.find((p) => p.name === name)?.enum;

const TOOLS = [
  { name: 'etsy_shops', description: '列出已配置的 Etsy 店铺（名称、HubStudio 环境 ID、是否默认、授权状态和有效期、shop_id）和是否只读模式。', annotations: LOCAL_RO, inputSchema: obj({}), run: shops },
  {
    name: 'etsy_shop_overview',
    description: '店铺概况：店名、币种、在售商品数、累计销量、收藏数、评分和评价数、休假状态，以及分区、运费模板、退货政策。',
    annotations: RO, inputSchema: obj({ shop: shopArg }), run: shopOverview,
  },
  {
    name: 'etsy_listings',
    description: '本店商品列表（按状态：在售 / 下架 / 售罄 / 草稿 / 过期），每条：标题、价格、库存、收藏数、SKU、标签、类目、创建 / 更新 / 到期日期、链接。传 keyword 时在标题、标签、SKU 里查找（最多扫 1000 条）。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg,
      state: { type: 'string', enum: enumOf('getListingsByShop', 'state'), default: 'active' },
      keyword: { type: 'string', description: '在标题 / 标签 / SKU 里查找' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      offset: { type: 'integer', minimum: 0, default: 0 },
      sort_on: { type: 'string', enum: enumOf('getListingsByShop', 'sort_on'), default: 'created' },
      sort_order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
    }),
    run: listings,
  },
  {
    name: 'etsy_listing_detail',
    description: '单个商品详情：标题、描述、价格、库存、标签、材质、类目、运费 / 退货模板、处理时间、尺寸重量、图片、视频、翻译，以及每个规格（SKU、规格值、价格、数量）。',
    annotations: RO, inputSchema: obj({ shop: shopArg, listing_id: { type: 'integer', minimum: 1 } }, ['listing_id']), run: listingDetail,
  },
  {
    name: 'etsy_inventory',
    description: '批量查商品规格库存：每个商品的每个规格（SKU、规格值、价格、数量、是否在售）。一次最多 100 个商品。',
    annotations: RO, inputSchema: obj({ shop: shopArg, listing_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100 } }, ['listing_ids']), run: inventory,
  },
  {
    name: 'etsy_orders',
    description: '最近 N 天订单：按币种汇总订单数、销售额、运费、税、折扣，已付款 / 已发货 / 已取消数，卖得最多的商品；以及每单的商品、金额、收货国家、发货情况、退款。不返回买家姓名、地址、邮箱、留言。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg,
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      was_paid: { type: 'boolean' }, was_shipped: { type: 'boolean' }, was_canceled: { type: 'boolean' },
      max_receipts: { type: 'integer', minimum: 1, maximum: 2000, default: 300, description: '最多取多少单（每 100 单一次请求）' },
    }),
    run: orders,
  },
  {
    name: 'etsy_finance',
    description: '支付账户流水（最近 N 天）：当前余额、各类收支（销售、手续费、刊登费、广告费、退款、提现等）的笔数和金额、净额，以及最近 20 笔。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, days: { type: 'integer', minimum: 1, maximum: 365, default: 30 }, max_entries: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 } }),
    run: finance,
  },
  {
    name: 'etsy_reviews',
    description: '店铺评价（最近 N 天）：平均分、各星级分布、差评（3 星及以下）原文、最近评价。',
    annotations: RO, inputSchema: obj({ shop: shopArg, days: { type: 'integer', minimum: 1, maximum: 3650, default: 90 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }), run: reviews,
  },
  {
    name: 'etsy_category_search',
    description: '搜索 Etsy 卖家类目（英文关键词，如 "model kit"、"miniature"），返回类目 ID 和完整路径；刊登用叶子类目。',
    annotations: RO, inputSchema: obj({ query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, ['query']), run: categorySearch,
  },
  {
    name: 'etsy_market_search',
    description: 'Etsy 前台在售商品搜索（公开数据，看竞品）：按关键词、价格区间、类目、店铺所在地筛选，返回价格分布（最低 / 中位 / 最高）和每条的标题、价格、收藏数、标签、链接、店铺 ID。没有销量数据。',
    annotations: RO,
    inputSchema: obj({
      keywords: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      offset: { type: 'integer', minimum: 0, default: 0 },
      sort_on: { type: 'string', enum: enumOf('findAllListingsActive', 'sort_on'), default: 'score' },
      min_price: { type: 'number', minimum: 0 }, max_price: { type: 'number', minimum: 0 },
      taxonomy_id: { type: 'integer', minimum: 1 },
      shop_location: { type: 'string', description: '店铺所在地，如 China、United States' },
      currency: { type: 'string', default: 'USD', description: '价格换算成哪种货币（ISO 4217，如 USD、EUR）' },
    }, ['keywords']),
    run: marketSearch,
  },
  {
    name: 'etsy_api_catalog',
    description: `搜索 Etsy Open API v3 全部 ${spec.operations.length} 个接口：按关键词（中英文都行，如「订单」「库存」「shipping profile」）、分类、读 / 写筛选；返回接口名、方法、路径、所需权限、说明。先搜到接口，再用 etsy_api_describe 看参数。`,
    annotations: LOCAL_RO,
    inputSchema: obj({
      query: { type: 'string', description: '关键词，多个词用空格分开（都要命中）' },
      tag: { type: 'string', description: '分类，如 ShopListing、Shop Receipt' },
      write: { type: 'boolean', description: 'true 只看写接口，false 只看查询接口' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 120 },
    }),
    run: catalog,
  },
  {
    name: 'etsy_api_describe',
    description: '某个接口的完整说明：路径参数、查询参数（类型、枚举、默认值、范围）、请求体字段（必填、类型、说明）、所需权限，以及怎么调用。',
    annotations: LOCAL_RO, inputSchema: obj({ operation: { type: 'string', description: '接口名，如 getShopReceipts、updateListingInventory' } }, ['operation']), run: describe,
  },
  {
    name: 'etsy_api_call',
    description: '调用任意 Etsy 查询接口（GET）：params 里放路径参数和查询参数，shop_id / user_id 不填时自动用当前店铺的。按接口规格校验参数；结果去掉买家个人信息；太大时截断并提示分页。写接口要用 etsy_write_preview。',
    annotations: RO,
    inputSchema: obj({ operation: { type: 'string' }, params: { type: 'object', description: '路径参数 + 查询参数，如 {"listing_id": 123, "includes": ["Images"]}' }, shop: shopArg }, ['operation']),
    run: apiCall,
  },
  {
    name: 'etsy_write_preview',
    description: '写操作预检（不改平台上的东西）：任意 Etsy 写接口（建草稿、改商品、改价改库存、传图片 / 视频 / 文件、删除、改运费 / 退货模板、分区、加运单等）。按规格校验参数，读出改前状态，给出改前 → 改后、费用和风险提示，返回 preview_id。'
      + '上传类字段（image / video / file）填本机文件绝对路径或 https 地址。必须把结果给用户确认后，再用 etsy_write_apply 执行。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: obj({
      operation: { type: 'string', description: '写接口名，如 updateListing、updateListingInventory、createDraftListing' },
      params: { type: 'object', description: '路径参数 + 查询参数（shop_id 不填自动用本店）' },
      body: { type: 'object', description: '请求体字段（etsy_api_describe 看有哪些）' },
      shop: shopArg,
    }, ['operation']),
    run: writePreview,
  },
  {
    name: 'etsy_write_apply',
    description: '执行一条已预检的写操作。只有用户明确同意预检结果后才能调用，confirm 必须是 true。执行前会重新读改前状态，被别处改过就拒绝；同一个 preview_id 重复执行不会重复修改。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: obj({ preview_id: { type: 'string' }, confirm: { type: 'boolean', description: '用户已确认' } }, ['preview_id', 'confirm']),
    run: writeApply,
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = `Etsy 卖家工具（Etsy Open API v3，${spec.operations.length} 个接口）。
- 常见问题先用组合工具：etsy_shop_overview、etsy_listings、etsy_listing_detail、etsy_inventory、etsy_orders、etsy_finance、etsy_reviews、etsy_market_search、etsy_category_search。
- 其他需求：etsy_api_catalog 搜接口 → etsy_api_describe 看参数 → 查询用 etsy_api_call。
- 所有改动（改价改库存、改商品、上新、删除、发货等）必须两步：etsy_write_preview 预检 → 把改前 → 改后和费用提示给用户看、用户明确同意 → etsy_write_apply(confirm=true)。不要替用户确认。
- 多家店时用 shop 参数指定（etsy_shops 查看）。遇到「限流」不要反复重试，告诉用户官方额度（10 次/秒、1 万次/天）。
- 结果里买家个人信息已隐藏，不要试图通过其他接口获取。`;

/** 按 inputSchema 做参数检查：未知参数、必填、类型、枚举、范围 */
function checkArgs(tool, args) {
  const { properties, required = [] } = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new QueryError('arguments 必须是对象。');
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new QueryError(`未知参数：${key}`);
  for (const key of required) if (args[key] === undefined || args[key] === '') throw new QueryError(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const s = properties[key];
    if (value === undefined) continue;
    if (s.type === 'integer' && !Number.isInteger(value)) throw new QueryError(`${key} 必须是整数。`);
    if (s.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) throw new QueryError(`${key} 必须是数字。`);
    if (s.type === 'string' && typeof value !== 'string') throw new QueryError(`${key} 必须是字符串。`);
    if (s.type === 'boolean' && typeof value !== 'boolean') throw new QueryError(`${key} 必须是 true / false。`);
    if (s.type === 'array' && !Array.isArray(value)) throw new QueryError(`${key} 必须是数组。`);
    if (s.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new QueryError(`${key} 必须是对象。`);
    if (s.enum && !s.enum.includes(value)) throw new QueryError(`${key} 只能是：${s.enum.join('、')}`);
    if (s.minimum !== undefined && value < s.minimum) throw new QueryError(`${key} 不能小于 ${s.minimum}。`);
    if (s.maximum !== undefined && value > s.maximum) throw new QueryError(`${key} 不能大于 ${s.maximum}。`);
    if (s.minLength !== undefined && value.length < s.minLength) throw new QueryError(`${key} 不能为空。`);
    if (s.type === 'array' && s.maxItems !== undefined && value.length > s.maxItems) throw new QueryError(`${key} 最多 ${s.maxItems} 项。`);
    if (s.type === 'array' && s.items?.type === 'integer' && !value.every((x) => Number.isInteger(x) && x >= (s.items.minimum ?? -Infinity))) throw new QueryError(`${key} 里每一项都必须是正整数。`);
  }
}

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    const input = args ?? {};
    checkArgs(tool, input);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(input)) }] };
  } catch (error) {
    if (!isUserError(error)) process.stderr.write(`[etsy-seller-mcp] ${error?.stack ?? error}\n`);
    return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
  }
}

const listed = TOOLS.map(({ run, ...tool }) => tool);

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'etsy-seller-mcp', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listed };
    case 'tools/call':
      return callTool(params?.name, params?.arguments);
    default:
      if (id === undefined) return undefined; // 通知（如 notifications/initialized）不回复
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`etsy-seller-mcp ${VERSION}
Etsy 卖家 MCP（stdio）：Etsy Open API v3 全部 ${spec.operations.length} 个接口，常用查询组合工具，写操作预检 → 确认后执行。

命令：
  etsy-seller-mcp                                  启动 MCP 服务（stdio）
  etsy-seller-mcp auth --container <环境 ID>        授权店铺：在这家店的 HubStudio 浏览器环境里打开 Etsy 授权页，点 Grant access 后保存授权
  etsy-seller-mcp auth --shop <店铺名>              同上，按 ETSY_SHOPS 里的店铺名
    --manual               手动授权：只生成授权网址，你自己在这家店的浏览器里打开、点 Grant access（推荐，工具不碰浏览器）
    --finish <跳转后的地址> 手动授权第二步：把跳转后地址栏里的完整地址交回来完成授权
    --app-from-page        重新从这家店环境里的 Etsy Your Apps 页读取应用密钥（换了应用 / 轮换了 secret 时用）
    --redirect-uri <URL>   回调地址（默认 ${DEFAULT_REDIRECT_URI}，要和应用里登记的完全一致）
    --read-only            只申请读权限

环境变量：
  ETSY_SHOPS           店铺数组 JSON，如 [{"name":"美国店","container_code":"1111111111","default":true},{"name":"二店","container_code":"2222222222"}]
  ETSY_CONTAINER_CODE  只有一家店时可以只设 HubStudio 环境 ID；都不设时用密钥文件里已授权的店
  ETSY_API_KEYS        应用密钥和店铺授权文件（默认 ~/.config/etsy-seller-mcp/api-keys.json）
  ETSY_DATA_DIR        预检记录、执行日志、锁（默认 ~/.etsy-seller-mcp）
  ETSY_READ_ONLY       true = 只读，不允许任何写操作
  HUBSTUDIO_API        HubStudio 本地接口（默认 http://127.0.0.1:6873）
`);
  process.exit(0);
}

if (process.argv[2] === 'auth') {
  const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const run = async () => {
    const codeArg = argOf('--container');
    let code;
    if (codeArg !== undefined) {
      if (!/^\d{4,20}$/.test(codeArg)) throw new QueryError('--container 应是 HubStudio 环境 ID（数字）');
      code = codeArg;
    } else {
      code = shopFor(argOf('--shop')).code;
    }
    const scopes = process.argv.includes('--read-only') ? READ_SCOPES : ALL_SCOPES;
    if (process.argv.includes('--manual')) {
      const m = await startManualAuth({ code, file: KEYS_FILE, dataDir: DATA_DIR, scopes, redirectUri: argOf('--redirect-uri') });
      process.stdout.write(`手动授权（工具不操作浏览器）：
1. 在 HubStudio 里打开这家店的环境（环境 ID ${code}），确认 Etsy 登录的是这家店的账号
2. 在地址栏打开下面这个网址，点「Grant access」：

${m.url}

3. 页面会跳到一个打不开的 ${m.redirect}?code=… 地址，把地址栏里的完整地址复制下来，运行：
   ${authHint(code)} --finish '<完整地址>'
（30 分钟内有效，到 ${m.expires_at.slice(11, 16)} UTC）
`);
      return;
    }
    const finishUrl = argOf('--finish');
    if (finishUrl !== undefined) {
      const r = await finishManualAuth({ code, file: KEYS_FILE, dataDir: DATA_DIR, redirectedUrl: finishUrl });
      process.stdout.write(`授权成功：${r.shop_name ?? '（店名未知）'}（shop_id ${r.shop_id}），有效期到 ${r.expires_at.slice(0, 10)}（90 天，期间用工具会自动续期）。授权保存在 ${KEYS_FILE}\n`);
      if (r.duplicate_of) process.stdout.write(`注意：这家店之前也授权在 HubStudio 环境 ${r.duplicate_of} 下，两个环境登录的是同一家店？\n`);
      return;
    }
    const r = await authorizeShop({
      code,
      file: KEYS_FILE,
      scopes,
      redirectUri: argOf('--redirect-uri'),
      appFromPage: process.argv.includes('--app-from-page'),
      log: (m) => process.stderr.write(`${m}\n`),
    });
    process.stdout.write(`授权成功：${r.shop_name ?? '（店名未知）'}（shop_id ${r.shop_id}），有效期到 ${r.expires_at.slice(0, 10)}（90 天，期间用工具会自动续期）。授权保存在 ${KEYS_FILE}\n`);
    if (r.duplicate_of) process.stdout.write(`注意：这家店之前也授权在 HubStudio 环境 ${r.duplicate_of} 下，两个环境登录的是同一家店？\n`);
  };
  run().then(() => process.exit(0), (err) => {
    process.stderr.write(`授权失败：${err?.message ?? err}\n`);
    process.exit(1);
  });
} else {
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ id: null, error: { code: -32600, message: '请求必须是 JSON 对象' } });
      return;
    }
    try {
      const result = await handle(message);
      if (message.id !== undefined && result !== undefined) send({ id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } });
    }
  }).on('close', () => process.exit(0));
}
