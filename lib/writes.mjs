// 写操作两步走：预检（校验参数、读改前状态、算出改前 → 改后和费用提示，不改平台上的东西）→ 用户确认 → 执行。
// 执行前重新读一遍改前状态，和预检时的指纹不一样（被别处改过）就拒绝；上传的文件内容变了也拒绝。
// 网络中断、服务器 5xx 等结果不确定时记为 unknown：同一个 preview_id 再执行会先对账——现状还是改前就重发、已经是改后就记成功、
// 都不是就拒绝；创建 / 上传类不自动重发，要先人工确认。同一家店的写操作跨进程串行（读现状 → 比较 → 发送 → 记录 在一把锁里）。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.mjs';
import { withLock } from './lock.mjs';
import { binaryFields } from './spec.mjs';
import { loadUpload } from './etsy-api.mjs';
import { redact } from './privacy.mjs';

export class WriteError extends Error {}

const PREVIEW_TTL_MS = 24 * 3600_000;
const KEEP_MS = 7 * 24 * 3600_000;
const UNRESOLVED = new Set(['sending', 'unknown']);
const ID = /^w[0-9a-f]{16}$/;
const MAX_SNAPSHOT_ITEMS = 2000;
/** 对象不存在时也是合法的写（新增或修改） */
const UPSERT = new Set(['updateListingProperty']);
/** 查询接口总能返回、要看内容才知道「对象还在不在」的 */
const PRESENT = {
  getListingPersonalization: (d) => (d?.personalization_questions ?? []).length > 0,
};

/** 改前状态用哪个查询接口读（路径和写接口不同的）；没列的 PUT / PATCH / DELETE 用同路径的 GET；POST 创建类不读 */
const SNAPSHOT = {
  updateListing: 'getListing',
  deleteListing: 'getListing',
  deleteListingImage: 'getListingImage',
  deleteListingVideo: 'getListingVideo',
  deleteListingProperty: 'getListingProperties',
  updateListingProperty: 'getListingProperties',
  updateListingPersonalization: 'getListingPersonalization',
  deleteListingPersonalization: 'getListingPersonalization',
  updateVariationImages: 'getListingVariationImages',
  createListingTranslation: 'getListingTranslation',
  createReceiptShipment: 'getShopReceipt',
  updateHolidayPreferences: 'getHolidayPreferences',
  updateShopShippingProfileDestination: 'getShopShippingProfileDestinationsByShippingProfile',
  deleteShopShippingProfileDestination: 'getShopShippingProfileDestinationsByShippingProfile',
  updateShopShippingProfileUpgrade: 'getShopShippingProfileUpgrades',
  deleteShopShippingProfileUpgrade: 'getShopShippingProfileUpgrades',
  uploadListingImage: 'getListingImages',
  uploadListingVideo: 'getListingVideos',
  // 给实体商品关联文件会把它变成数字商品（去掉运费和规格库存）：改前状态见 COMPOSITE（商品 + 库存 + 运费模板）
  uploadListingFile: 'getListing',
  consolidateShopReturnPolicies: 'getShopReturnPolicies',
};

/** 重复发送结果一样的写操作（结果不确定时可以安全重发） */
const IDEMPOTENT_POST = new Set(['updateListingPersonalization', 'updateVariationImages']);
export const isIdempotent = (op) => ['PUT', 'PATCH', 'DELETE'].includes(op.method) || IDEMPOTENT_POST.has(op.id);

export function snapshotOperation(spec, op) {
  if (SNAPSHOT[op.id]) return spec.byId.get(SNAPSHOT[op.id]) ?? null;
  if (op.method === 'POST') return null;
  return spec.operations.find((o) => o.method === 'GET' && o.path === op.path) ?? null;
}

/** 浏览量、收藏数这类随时在变、又不能通过接口写的字段不算进指纹 */
const VOLATILE = new Set(['views', 'num_favorers']);

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) out[k] = stable(v[k]);
  return out;
}
export const fingerprint = (data) => createHash('sha256').update(JSON.stringify(stable(data ?? null))).digest('hex');

const isMoney = (v) => v && typeof v === 'object' && 'amount' in v && 'divisor' in v;
export const money = (v) => (isMoney(v) ? { amount: v.amount / (v.divisor || 1), currency: v.currency_code } : v);

const amt = (v) => (isMoney(v) ? money(v).amount : v);

/** 运费模板展开成可读的样子：每个目的地的首件 / 续件运费、承运方式、时效，每个加急选项的价格 */
export function shippingView(sp) {
  if (!sp) return null;
  return {
    shipping_profile_id: sp.shipping_profile_id, title: sp.title, origin: sp.origin_country_iso,
    processing_days: [sp.min_processing_days, sp.max_processing_days].filter((x) => x !== undefined && x !== null).join('–') || undefined,
    destinations: (sp.shipping_profile_destinations ?? []).map((d) => ({
      to: d.destination_country_iso || d.destination_region || 'everywhere else',
      first_item: amt(d.primary_cost), each_additional: amt(d.secondary_cost), currency: d.primary_cost?.currency_code,
      mail_class: d.mail_class ?? undefined, delivery_days: [d.min_delivery_days, d.max_delivery_days].filter((x) => x !== undefined && x !== null).join('–') || undefined,
    })),
    upgrades: (sp.shipping_profile_upgrades ?? []).map((u) => ({
      name: u.upgrade_name, type: u.type, price: amt(u.price), each_additional: amt(u.secondary_price), currency: u.price?.currency_code,
    })),
  };
}

/** 结果里只留标量字段（长文本截断），给预检展示用 */
function brief(v, max = 40) {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return { count: v.length, first: v.slice(0, 3).map((x) => brief(x, 12)) };
  if (Array.isArray(v.results)) return { count: v.count ?? v.results.length, results: v.results.slice(0, 10).map((x) => brief(x, 12)) };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (Object.keys(out).length >= max) break;
    if (isMoney(x)) out[k] = money(x);
    else if (typeof x === 'string') out[k] = x.length > 200 ? `${x.slice(0, 199)}…` : x;
    else if (x === null || typeof x !== 'object') out[k] = x;
  }
  return out;
}

const INVENTORY_SETTINGS = ['price_on_property', 'quantity_on_property', 'sku_on_property', 'readiness_state_on_property'];

/** 库存（规格）的全部可写内容整理成可比较的样子：哪些属性决定价格 / 数量 / SKU / 处理时间，每个规格的 SKU、规格值、价格、数量、是否在售、处理时间配置 */
export function inventoryView(inv) {
  const settings = {};
  for (const k of INVENTORY_SETTINGS) if (inv?.[k] !== undefined) settings[k] = [...(inv[k] ?? [])].map(Number).sort((a, b) => a - b);
  const products = (inv?.products ?? []).map((p) => ({
    sku: p.sku ?? '',
    variation: (p.property_values ?? []).map((pv) => {
      const vals = pv.value_ids?.length ? pv.value_ids.join('/') : (pv.values ?? []).join('/');
      return `${pv.property_id}${pv.property_name ? `(${pv.property_name})` : ''}=${vals}${pv.scale_id ? `@scale${pv.scale_id}` : ''}`;
    }).join('; '),
    offerings: (p.offerings ?? []).map((o) => ({
      price: isMoney(o.price) ? money(o.price).amount : o.price, quantity: o.quantity, enabled: o.is_enabled, readiness_state_id: o.readiness_state_id,
    })),
  }));
  return { settings, products };
}

/**
 * 对账用的库存内容：*_on_property（只比请求里给了的）+ 每个规格（SKU、属性 ID 和规格值文字、scale）对应的 offerings。
 * 规格值按文字比（请求里 values 必填，value_ids 可能没给）。
 */
const inventoryCore = (inv, settingKeys, namedIds = new Set()) => {
  const settings = {};
  for (const k of settingKeys) settings[k] = [...(inv?.[k] ?? [])].map(Number).sort((a, b) => a - b);
  const products = (inv?.products ?? []).map((p) => ({
    sku: p.sku ?? '',
    // 请求里给了规格名（自定义规格）的属性，名字也要对得上
    variation: (p.property_values ?? []).map((pv) => [Number(pv.property_id), (pv.values ?? []).map(String), pv.scale_id ?? null,
      namedIds.has(Number(pv.property_id)) ? String(pv.property_name ?? '') : null])
      .sort((a, b) => a[0] - b[0]),
    offerings: (p.offerings ?? []).map((o) => ({
      price: String(isMoney(o.price) ? money(o.price).amount : o.price), quantity: o.quantity ?? null, enabled: o.is_enabled ?? null, readiness_state_id: o.readiness_state_id ?? null,
    })),
  })).map((p) => JSON.stringify(p)).sort();
  return JSON.stringify({ settings, products });
};

const norm = (v) => {
  if (isMoney(v)) return String(money(v).amount);
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v;
};

/** 现状是不是已经是改后（结果不确定后对账用）；判断不了就当不是 */
export function reachedTarget(op, current, body) {
  if (!current || !body) return false;
  if (op.id === 'updateListingInventory') {
    const keys = INVENTORY_SETTINGS.filter((k) => body[k] !== undefined);
    const named = new Set((body.products ?? []).flatMap((p) => (p.property_values ?? []).filter((pv) => pv.property_name).map((pv) => Number(pv.property_id))));
    return inventoryCore(current, keys, named) === inventoryCore(body, keys, named);
  }
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((k) => k in current && JSON.stringify(norm(current[k])) === JSON.stringify(norm(body[k])));
}

/** 改前 → 改后：请求体里每个字段对应改前的值 */
function diffOf(op, before, body, uploads) {
  if (op.id === 'updateListingInventory') {
    const b = inventoryView(before);
    const a = inventoryView(body);
    const settingsChanged = INVENTORY_SETTINGS.filter((k) => body?.[k] !== undefined && JSON.stringify(a.settings[k]) !== JSON.stringify(b.settings[k]));
    return {
      before: b, after: a,
      ...(settingsChanged.length ? { settings_changed: settingsChanged } : {}),
      note: '整组替换：没写进 products 的规格会被删除；readiness_state_id 是处理时间配置，*_on_property 决定价格 / 数量 / SKU / 处理时间按哪个规格属性区分',
    };
  }
  const rows = [];
  for (const [k, after] of Object.entries(body ?? {})) {
    if (uploads?.[k]) {
      rows.push({ field: k, after: `上传 ${uploads[k].name}（${(uploads[k].size / 1024).toFixed(0)} KB）` });
      continue;
    }
    const prev = before && typeof before === 'object' && !Array.isArray(before) && k in before ? money(before[k]) : undefined;
    const same = prev !== undefined && JSON.stringify(prev) === JSON.stringify(after);
    rows.push({ field: k, ...(prev !== undefined ? { before: prev } : {}), after, ...(same ? { unchanged: true } : {}) });
  }
  return rows;
}

/** 费用和风险提示 */
function notesOf(op, before, body) {
  const n = [];
  if (op.id === 'createDraftListing') n.push('创建的是草稿，不收费；以后发布（state 改成 active）时 Etsy 收 0.20 美元刊登费。');
  if (op.id === 'updateListing' && body?.state === 'active' && before?.state !== 'active') n.push(`商品从 ${before?.state ?? '未知状态'} 改成在售：Etsy 收 0.20 美元刊登费（有效 4 个月）。`);
  if (op.id === 'updateListing' && body?.state === 'inactive') n.push('商品下架（inactive），买家看不到；之后重新上架不另收费（未过期时）。');
  if (op.method === 'DELETE') n.push('删除不可恢复。');
  if (op.id === 'deleteListing') n.push('已售出过的商品通常不能删除，只能下架。');
  if (op.id === 'createReceiptShipment') n.push('添加运单后订单会被标为已发货，Etsy 会通知买家。');
  if (op.id === 'updateListingInventory') n.push('库存 / 价格 / 规格是整组替换：要保留的规格必须全部写上。');
  if (op.id === 'uploadListingImage' && body?.overwrite) n.push(`会替换第 ${body.rank ?? 1} 张图片。`);
  if (op.id === 'updateShop') n.push('改的是店铺对外展示的信息。');
  if (op.id === 'uploadListingFile' && before?.listing && before.listing.listing_type !== 'download') {
    const l = before.listing;
    const sp = before.shipping_profile;
    const products = before.inventory?.products ?? [];
    n.push(`这是${l.listing_type === 'both' ? '实体 + 数字' : '实体'}商品：关联数字文件会把它变成数字商品，不能撤销。会去掉：`
      + `运费${sp ? `（运费模板「${sp.title}」，${(sp.shipping_profile_destinations ?? []).length} 个目的地、${(sp.shipping_profile_upgrades ?? []).length} 个加急选项）` : '（没有运费模板）'}；`
      + `规格库存（${products.length} 个规格${l.has_variations ? '，含多规格' : ''}）。`);
  }
  if (op.id === 'updateShopReceipt') n.push('改的是订单状态，可能影响买家看到的进度。');
  return n;
}

export function createWriteStore({ dir, now = () => Date.now() }) {
  const root = join(dir, 'write-previews');
  const path = (id) => join(root, `${id}.json`);
  const cleanup = () => {
    let files = [];
    try {
      files = readdirSync(root);
    } catch {
      return;
    }
    for (const f of files) {
      const p = join(root, f);
      try {
        const age = now() - statSync(p).mtimeMs;
        if (f.endsWith('.tmp')) {
          if (age > 24 * 3600_000) unlinkSync(p);
          continue;
        }
        if (!f.endsWith('.json') || age <= KEEP_MS) continue;
        const rec = JSON.parse(readFileSync(p, 'utf8'));
        if (UNRESOLVED.has(rec?.status)) continue; // 结果不确定的留着对账
        unlinkSync(p);
      } catch {
        // 读不了的不动
      }
    }
  };
  const load = (id) => {
    if (!ID.test(String(id ?? ''))) throw new WriteError('preview_id 格式不对（用 etsy_write_preview 返回的 preview_id）');
    try {
      return JSON.parse(readFileSync(path(id), 'utf8'));
    } catch {
      throw new WriteError(`找不到预检记录 ${id}（可能已超过 7 天被清理），请重新预检`);
    }
  };
  return {
    root,
    save(rec) {
      cleanup();
      writeFileAtomic(path(rec.id), JSON.stringify(rec));
      return rec;
    },
    load,
    update(id, patch) {
      const rec = { ...load(id), ...patch };
      writeFileAtomic(path(id), JSON.stringify(rec));
      return rec;
    },
  };
}

/**
 * spec / api / store：见 spec.mjs、etsy-api.mjs、createWriteStore。
 * dataDir：锁和执行日志放这里。readOnly：只读模式下预检和执行都拒绝。
 */
export function createWrites({ spec, api, store, dataDir, readOnly = false, now = () => Date.now(), fetchImpl = fetch }) {
  const guard = () => {
    if (readOnly) throw new WriteError('现在是只读模式（ETSY_READ_ONLY=true），不能改店铺数据');
  };

  const pathNames = (o) => [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const paged = (o) => o.params.some((p) => p.name === 'limit') && o.params.some((p) => p.name === 'offset');

  /** 读快照接口；分页的列表全部翻完（最多 MAX_SNAPSHOT_ITEMS 条） */
  async function readAll(snapOp, picked, shopCode) {
    if (!paged(snapOp)) return (await api.call({ op: snapOp, pathParams: picked, shopCode, auth: 'optional' })).data;
    const results = [];
    let count = null;
    for (let offset = 0; offset < MAX_SNAPSHOT_ITEMS; offset += 100) {
      const r = await api.call({ op: snapOp, pathParams: picked, query: { limit: 100, offset }, shopCode, auth: 'optional' });
      const rows = r.data?.results ?? [];
      count = r.data?.count ?? count;
      results.push(...rows);
      if (rows.length < 100 || (count !== null && results.length >= count)) return { count: count ?? results.length, results };
    }
    throw new WriteError(`改前状态的列表超过 ${MAX_SNAPSHOT_ITEMS} 条，无法完整核对，请到 Etsy 后台操作`);
  }

  /**
   * 读改前状态。快照接口是列表（如运费模板的目的地）而写接口针对其中一项时，只取那一项来比较；
   * 返回 { operation, path_params, target, exists, data, fingerprint }，没有可用的查询接口时返回 null。
   */
  /** 一次写会影响多个对象的，改前状态由几次查询拼成 */
  const COMPOSITE = {
    // 关联文件：商品本身、它的规格库存、它用的运费模板（含目的地和加急选项），这些都可能被删掉
    async uploadListingFile({ pathParams, shopCode }) {
      const get = async (id, params) => {
        try {
          return (await api.call({ op: spec.byId.get(id), pathParams: params, shopCode, auth: 'optional' })).data;
        } catch (err) {
          if (err.status === 404) return null;
          throw err;
        }
      };
      const listing = await get('getListing', { listing_id: pathParams.listing_id });
      if (!listing) return { operation: 'getListing', path_params: { listing_id: pathParams.listing_id }, exists: false, data: null, fingerprint: fingerprint(null) };
      const inventory = listing.listing_type === 'download' ? null : await get('getListingInventory', { listing_id: pathParams.listing_id });
      const shippingProfile = listing.listing_type !== 'download' && listing.shipping_profile_id
        ? await get('getShopShippingProfile', { shop_id: pathParams.shop_id, shipping_profile_id: listing.shipping_profile_id })
        : null;
      const data = { listing, inventory, shipping_profile: shippingProfile };
      return { operation: 'getListing+getListingInventory+getShopShippingProfile', path_params: { listing_id: pathParams.listing_id }, exists: true, data, fingerprint: fingerprint(data) };
    },
  };

  async function readSnapshot(op, { pathParams, shopCode }) {
    if (COMPOSITE[op.id]) return COMPOSITE[op.id]({ pathParams, shopCode });
    const snapOp = snapshotOperation(spec, op);
    if (!snapOp) return null;
    const names = pathNames(snapOp);
    if (names.some((n) => pathParams[n] === undefined)) return null;
    if (snapOp.params.some((p) => p.required && p.in === 'query')) return null;
    const picked = Object.fromEntries(names.map((n) => [n, pathParams[n]]));
    // 写接口比快照接口多出来的路径参数（shop_id 除外）就是列表里的目标项，如运费目的地 ID
    const targetKeys = pathNames(op).filter((n) => !names.includes(n) && n !== 'shop_id');
    const target = targetKeys.length ? Object.fromEntries(targetKeys.map((k) => [k, pathParams[k]])) : null;
    const base = { operation: snapOp.id, path_params: picked, ...(target ? { target } : {}) };
    let data;
    try {
      data = await readAll(snapOp, picked, shopCode);
    } catch (err) {
      if (err.status === 404) return { ...base, exists: false, data: null, fingerprint: fingerprint(null) };
      throw err;
    }
    const list = Array.isArray(data) ? data : data?.results;
    if (target && Array.isArray(list)) {
      const item = list.find((x) => x && targetKeys.every((k) => String(x[k]) === String(target[k]))) ?? null;
      return { ...base, exists: Boolean(item), data: item, fingerprint: fingerprint(item) };
    }
    const present = PRESENT[snapOp.id] ? PRESENT[snapOp.id](data) : true;
    return { ...base, exists: present, data: present ? data : null, fingerprint: fingerprint(present ? data : null) };
  }

  async function loadUploads(op, body) {
    const out = {};
    for (const f of binaryFields(op)) {
      if (body?.[f] === undefined || body[f] === null) continue;
      const up = await loadUpload(body[f], f, { fetchImpl });
      out[f] = { ref: body[f], name: up.name, size: up.bytes.length, sha256: up.sha256, bytes: up.bytes };
    }
    return out;
  }

  /** 预检。call：validateCall 的结果；shop：{ code, name }；grant：这家店的授权信息（scopes、user_id） */
  async function preview({ op, call, shop, grant }) {
    guard();
    const missing = op.scopes.filter((s) => !(grant?.scopes ?? []).includes(s));
    if (missing.length) throw new WriteError(`这家店的授权里没有 ${missing.join('、')} 权限：重新运行 auth 授权这家店`);
    const uploads = await loadUploads(op, call.body);
    const snap = await readSnapshot(op, { pathParams: call.pathParams, shopCode: shop.code });
    if (op.method === 'DELETE' && snap && !snap.exists) throw new WriteError('要删除的对象不存在（可能已经删掉了）');
    if (op.method !== 'POST' && !UPSERT.has(op.id) && snap && !snap.exists) throw new WriteError('要修改的对象不存在，检查 ID');
    const ownUserId = grant?.user_id ?? null;
    const before = snap?.exists ? redact(snap.data, { ownUserId }).data : null;
    const id = `w${randomBytes(8).toString('hex')}`;
    const rec = {
      id,
      created_at: new Date(now()).toISOString(),
      status: 'previewed',
      shop: { code: shop.code, name: shop.name, shop_id: grant?.shop_id ?? null },
      operation: op.id,
      method: op.method,
      path_params: call.pathParams,
      query: call.query,
      body: call.body ?? null,
      uploads: Object.fromEntries(Object.entries(uploads).map(([k, u]) => [k, { ref: u.ref, name: u.name, size: u.size, sha256: u.sha256 }])),
      snapshot: snap ? { operation: snap.operation, path_params: snap.path_params, target: snap.target ?? null, exists: snap.exists, fingerprint: snap.fingerprint } : null,
      changes: diffOf(op, before, call.body, uploads),
      notes: notesOf(op, before, call.body),
    };
    store.save(rec);
    return {
      preview_id: id,
      shop: shop.name,
      operation: op.id,
      request: `${op.method} ${op.path}`,
      path_params: call.pathParams,
      ...(Object.keys(call.query ?? {}).length ? { query: call.query } : {}),
      changes: rec.changes,
      ...(before ? { before: before.listing && 'inventory' in before
        ? { listing: brief(before.listing), inventory: inventoryView(before.inventory), shipping_profile: shippingView(before.shipping_profile) }
        : brief(before) } : {}),
      notes: rec.notes,
      next: '把改动（和 notes 里的费用 / 风险）给用户看，用户明确同意后调用 etsy_write_apply({ preview_id, confirm: true })；24 小时内有效。',
    };
  }

  function logLine(rec, status, extra = {}) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dataDir, 'write-log.jsonl'), `${JSON.stringify({
        at: new Date(now()).toISOString(), preview_id: rec.id, shop: rec.shop.code, operation: rec.operation, path_params: rec.path_params,
        fields: Object.keys(rec.body ?? {}), status, ...extra,
      })}\n`, { mode: 0o600 });
    } catch {
      // 日志写不了不影响执行结果
    }
  }

  /** 执行。返回 { applied: true, result } */
  async function apply({ previewId, confirm, grantOf }) {
    guard();
    if (confirm !== true) throw new WriteError('执行前要用户确认：传 confirm: true（先把 etsy_write_preview 的结果给用户看）');
    const first = store.load(previewId);
    // 同一家 Etsy 店的写操作跨进程串行（按 shop_id，同一家店授权在多个环境下也是同一把锁）：
    // 两条预检改同一个商品时，后一条会看到前一条的结果（指纹对不上）而拒绝
    const lockShop = first.shop.shop_id ?? grantOf(first.shop.code)?.shop_id ?? first.shop.code;
    return withLock(dataDir, async () => {
      let rec = store.load(previewId);
      if (rec.status === 'done') return { already_applied: true, ...rec.result };
      if (rec.status === 'failed') throw new WriteError(`这条预检执行失败过：${rec.error}。改好后重新预检`);
      if (now() - Date.parse(rec.created_at) > PREVIEW_TTL_MS) throw new WriteError('预检已超过 24 小时，请重新预检');
      const op = spec.byId.get(rec.operation);
      if (!op) throw new WriteError(`接口 ${rec.operation} 不在当前版本的接口目录里，请重新预检`);
      const grant = grantOf(rec.shop.code);
      const missing = op.scopes.filter((s) => !(grant?.scopes ?? []).includes(s));
      if (missing.length) throw new WriteError(`这家店的授权里没有 ${missing.join('、')} 权限：重新运行 auth 授权这家店`);

      const reconciled = (note) => {
        rec = store.update(rec.id, { status: 'done', result: { applied: true, reconciled: true, operation: op.id, shop: rec.shop.name, note }, applied_at: new Date(now()).toISOString() });
        logLine(rec, 'done', { reconciled: true });
        return rec.result;
      };
      const retry = UNRESOLVED.has(rec.status);
      if (retry) {
        if (!isIdempotent(op)) {
          throw new WriteError('上次执行结果不确定（网络中断或 Etsy 服务器出错）；这类操作（创建 / 上传 / 加运单）重发可能会重复：请先用查询工具或 Etsy 后台确认是否已生效，没生效再重新预检');
        }
        const snap = rec.snapshot ? await readSnapshot(op, { pathParams: rec.path_params, shopCode: rec.shop.code }) : null;
        if (!snap) throw new WriteError('上次执行结果不确定，又读不到现状无法对账：请先用查询工具确认，再重新预检');
        const unchanged = snap.fingerprint === rec.snapshot.fingerprint;
        if (op.method === 'DELETE') {
          if (!snap.exists) return reconciled('对账：对象已不存在，上次删除已生效');
          if (!unchanged) throw new WriteError('上次删除结果不确定，而且这项数据在别处被改过：请先查询确认，再重新预检');
        } else if (!unchanged) {
          if (reachedTarget(op, snap.data, rec.body)) return reconciled('对账：现状已经是改后的内容，上次修改已生效');
          throw new WriteError('上次执行结果不确定，现在的状态既不是改前也不是改后（可能在别处被改过）：请先查询确认，再重新预检');
        }
        // 现状还是改前：上次没生效，重发
      } else if (rec.snapshot) {
        const snap = await readSnapshot(op, { pathParams: rec.path_params, shopCode: rec.shop.code });
        if (!snap || snap.fingerprint !== rec.snapshot.fingerprint) {
          throw new WriteError('预检之后这项数据在别处被改过（或有新订单 / 库存变化），为避免覆盖已拒绝执行：请重新预检，确认后再执行');
        }
      }

      const uploads = {};
      for (const [k, u] of Object.entries(rec.uploads ?? {})) {
        const cur = await loadUpload(u.ref, k, { fetchImpl });
        if (cur.sha256 !== u.sha256) throw new WriteError(`要上传的 ${k}（${u.name}）在预检后变了，请重新预检`);
        uploads[k] = cur;
      }

      rec = store.update(rec.id, { status: 'sending', attempt_at: new Date(now()).toISOString() });
      let res;
      try {
        res = await api.call({ op, pathParams: rec.path_params, query: rec.query ?? {}, body: rec.body ?? undefined, shopCode: rec.shop.code, auth: 'required', uploads });
      } catch (err) {
        if (retry && op.method === 'DELETE' && err.status === 404) return reconciled('对账：对象已不存在，上次删除已生效');
        if (err.network || err.uncertain) {
          store.update(rec.id, { status: 'unknown', error: err.message });
          logLine(rec, 'unknown', { http: err.status });
          throw new WriteError(`${err.message}，结果不确定。用同一个 preview_id 再执行一次会先对账（修改 / 删除类会核对现状再决定；创建 / 上传类请先查询确认）`);
        }
        store.update(rec.id, { status: 'failed', error: err.message });
        logLine(rec, 'failed', { http: err.status });
        throw err;
      }
      const data = redact(res.data, { ownUserId: grant?.user_id ?? null }).data;
      const result = { applied: true, operation: op.id, shop: rec.shop.name, result: brief(data) };
      store.update(rec.id, { status: 'done', result, applied_at: new Date(now()).toISOString() });
      logLine(rec, 'done');
      return result;
    }, { key: `shop-writes-${lockShop}`, what: '这家店的写操作', waitMs: 120_000, owner: `etsy-seller-mcp ${process.pid}` });
  }

  return { preview, apply };
}
