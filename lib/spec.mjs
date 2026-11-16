// Etsy Open API v3 接口目录（spec/operations.json，由 scripts/build-spec.mjs 从官方 OpenAPI 生成）：
// 搜索、说明、按规格校验参数和请求体、拼请求地址和请求体。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class SpecError extends Error {}

const SPEC_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'operations.json');

export function loadSpec(file = SPEC_FILE) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(spec.operations.map((op) => [op.id, op]));
  return { ...spec, byId };
}

/** 写接口：除了 GET 都是；tokenScopes 虽是 POST，只是查令牌权限 */
export const isWrite = (op) => op.method !== 'GET' && op.id !== 'tokenScopes';

// 中文关键词 → 接口里的英文词（搜索目录用）
const ALIASES = {
  订单: 'receipt', 收据: 'receipt', 交易: 'transaction', 商品: 'listing', 产品: 'listing', 刊登: 'listing', 草稿: 'draft',
  库存: 'inventory', 价格: 'inventory', 规格: 'inventory', 变体: 'variation', 图片: 'image', 视频: 'video', 文件: 'file',
  运费: 'shipping', 物流: 'shipping', 发货: 'tracking', 运单: 'tracking', 退货: 'return', 退款: 'return', 评价: 'review',
  评论: 'review', 财务: 'ledger', 流水: 'ledger', 账单: 'ledger', 付款: 'payment', 收款: 'payment', 类目: 'taxonomy',
  分类: 'taxonomy', 属性: 'propert', 店铺: 'shop', 分区: 'section', 翻译: 'translation', 个性化: 'personalization',
  假期: 'holiday', 生产: 'production', 备货: 'readiness', 处理时间: 'readiness', 用户: 'user', 地址: 'address',
  经营者: 'economic', 承运商: 'carrier',
};

/** 搜索接口：query 里每个词（中文先换成英文）都要命中 id / 路径 / 分类 / 说明之一 */
export function searchCatalog(spec, { query = '', tag, write, limit = 120 } = {}) {
  const words = String(query)
    .split(/[\s,，、]+/)
    .filter(Boolean)
    .map((w) => (ALIASES[w] ?? w).toLowerCase());
  const rows = [];
  for (const op of spec.operations) {
    if (tag && op.tag.toLowerCase() !== String(tag).toLowerCase()) continue;
    if (write !== undefined && isWrite(op) !== write) continue;
    const hay = `${op.id} ${op.path} ${op.tag} ${op.summary ?? ''}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    rows.push({
      operation: op.id,
      method: op.method,
      path: op.path,
      tag: op.tag,
      write: isWrite(op),
      needs_shop_auth: op.scopes.length > 0,
      scopes: op.scopes,
      summary: op.summary,
      ...(op.release ? { release: op.release } : {}),
    });
  }
  return { total: rows.length, operations: rows.slice(0, limit), tags: [...new Set(spec.operations.map((o) => o.tag))] };
}

export function getOperation(spec, id) {
  const op = spec.byId.get(String(id ?? ''));
  if (!op) {
    const q = String(id ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const near = q ? spec.operations.filter((o) => {
      const k = o.id.toLowerCase();
      return k.includes(q) || q.includes(k) || k.startsWith(q.slice(0, Math.max(6, q.length - 3)));
    }).slice(0, 5).map((o) => o.id) : [];
    throw new SpecError(`没有接口 ${id}${near.length ? `，是不是：${near.join('、')}` : '；先用 etsy_api_catalog 搜索'}`);
  }
  return op;
}

const typeName = (s) => (s.type === 'array' ? `${s.items?.type ?? 'any'}[]` : s.type ?? 'any');

/** 校验单个值并做温和的转换（数字字符串 → 整数、"true" → true、逗号字符串 → 数组）；返回转换后的值 */
function coerce(value, s, label, errors) {
  if (value === null) {
    if (s.nullable) return null;
    errors.push(`${label} 不能为 null`);
    return value;
  }
  switch (s.type) {
    case 'integer': {
      const v = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (!Number.isSafeInteger(v)) errors.push(`${label} 应是整数`);
      else checkRange(v, s, label, errors);
      return v;
    }
    case 'number': {
      const v = typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label} 应是数字`);
      else checkRange(v, s, label, errors);
      return v;
    }
    case 'boolean': {
      const v = value === 'true' ? true : value === 'false' ? false : value;
      if (typeof v !== 'boolean') errors.push(`${label} 应是 true / false`);
      return v;
    }
    case 'string': {
      if (s.format === 'binary') {
        if (typeof value !== 'string' || !value.trim()) errors.push(`${label} 应是本机文件的绝对路径或 https 图片地址`);
        return value;
      }
      const v = typeof value === 'number' ? String(value) : value;
      if (typeof v !== 'string') errors.push(`${label} 应是字符串`);
      else {
        if (s.enum && !s.enum.includes(v)) errors.push(`${label} 只能是：${s.enum.join('、')}`);
        if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${label} 最长 ${s.maxLength} 个字符`);
      }
      return v;
    }
    case 'array': {
      const arr = typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : value;
      if (!Array.isArray(arr)) {
        errors.push(`${label} 应是数组`);
        return value;
      }
      if (s.minItems !== undefined && arr.length < s.minItems) errors.push(`${label} 至少 ${s.minItems} 项`);
      if (s.maxItems !== undefined && arr.length > s.maxItems) errors.push(`${label} 最多 ${s.maxItems} 项`);
      return arr.map((x, i) => (s.items ? coerce(x, s.items, `${label}[${i}]`, errors) : x));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${label} 应是对象`);
        return value;
      }
      return s.properties ? coerceObject(value, s, label, errors) : value;
    }
    default:
      return value;
  }
}

function checkRange(v, s, label, errors) {
  if (s.enum && !s.enum.includes(v)) errors.push(`${label} 只能是：${s.enum.join('、')}`);
  if (s.minimum !== undefined && v < s.minimum) errors.push(`${label} 不能小于 ${s.minimum}`);
  if (s.maximum !== undefined && v > s.maximum) errors.push(`${label} 不能大于 ${s.maximum}`);
}

function coerceObject(obj, s, label, errors) {
  const out = {};
  const props = s.properties ?? {};
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(props, key)) {
      errors.push(`${label ? `${label}.` : ''}${key} 不是这个接口的字段（可用：${Object.keys(props).join('、') || '无'}）`);
      continue;
    }
    if (obj[key] === undefined) continue;
    out[key] = coerce(obj[key], props[key], label ? `${label}.${key}` : key, errors);
  }
  for (const key of s.required ?? []) {
    if (obj[key] === undefined || obj[key] === '') errors.push(`缺少字段 ${label ? `${label}.` : ''}${key}`);
  }
  return out;
}

/**
 * 按规格校验一次调用：params 放路径参数和查询参数，body 放请求体字段。
 * 返回 { pathParams, query, body }（已转换类型）；有问题时抛 SpecError，一次列出全部问题。
 */
export function validateCall(op, { params = {}, body } = {}) {
  const errors = [];
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new SpecError('params 应是对象');
  const known = new Map(op.params.map((p) => [p.name, p]));
  const pathParams = {};
  const query = {};
  for (const [k, v] of Object.entries(params)) {
    const p = known.get(k);
    if (!p) {
      errors.push(`${k} 不是这个接口的参数（可用：${op.params.map((x) => x.name).join('、') || '无'}${op.body ? '；请求体字段放 body' : ''}）`);
      continue;
    }
    if (v === undefined) continue;
    const c = coerce(v, p, k, errors);
    if (p.in === 'path') pathParams[k] = c;
    else if (p.in === 'query') query[k] = c;
  }
  for (const p of op.params) {
    if (p.required && (params[p.name] === undefined || params[p.name] === '')) errors.push(`缺少参数 ${p.name}（${typeName(p)}）`);
  }
  let outBody;
  if (op.body) {
    if (body === undefined || body === null) {
      if (op.body.required?.length) errors.push(`缺少请求体 body（必填字段：${op.body.required.join('、')}）`);
    } else if (typeof body !== 'object' || Array.isArray(body)) {
      errors.push('body 应是对象');
    } else {
      outBody = coerceObject(body, op.body, '', errors);
      if (op.body.contentType !== 'application/json') {
        for (const [k, v] of Object.entries(outBody)) {
          if (v === null) errors.push(`${k}: 这个接口是表单提交，不能用 null 清空（要清空请看 etsy_api_describe 里这个字段的说明，有的用 0 或空字符串）`);
        }
      }
      if (op.body.contentType === 'application/x-www-form-urlencoded') {
        for (const [k, v] of Object.entries(outBody)) {
          if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.includes(','))) errors.push(`${k} 里的每一项不能含英文逗号（Etsy 用逗号分隔多个值）`);
        }
      }
    }
  } else if (body !== undefined && body !== null && Object.keys(body).length) {
    errors.push('这个接口没有请求体，参数都放 params');
  }
  if (errors.length) throw new SpecError(`参数不对（${op.id}）：\n- ${errors.join('\n- ')}`);
  return { pathParams, query, body: outBody };
}

const scalar = (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

/** 拼请求路径（不含域名）：路径参数编码进地址，数组用逗号拼 */
export function buildPath(op, { pathParams = {}, query = {} }) {
  const path = op.path.replace(/\{(\w+)\}/g, (_, k) => {
    if (pathParams[k] === undefined) throw new SpecError(`缺少路径参数 ${k}`);
    return encodeURIComponent(String(pathParams[k]));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    qs.set(k, Array.isArray(v) ? v.map(scalar).join(',') : scalar(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** 表单 / JSON 请求体；multipart 由调用方读文件后组装（见 etsy-api.mjs） */
export function encodeBody(op, body) {
  if (!op.body || body === undefined) return {};
  if (op.body.contentType === 'application/json') return { contentType: 'application/json', payload: JSON.stringify(body) };
  if (op.body.contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      form.set(k, Array.isArray(v) ? v.map(scalar).join(',') : scalar(v));
    }
    return { contentType: 'application/x-www-form-urlencoded; charset=utf-8', payload: form.toString() };
  }
  return { contentType: op.body.contentType, multipart: true };
}

/** 请求体里哪些字段是要上传的文件 */
export const binaryFields = (op) => Object.entries(op.body?.properties ?? {}).filter(([, s]) => s.format === 'binary').map(([k]) => k);

/** 给 AI 看的接口说明 */
export function describeOperation(op) {
  const param = (p) => ({
    name: p.name,
    in: p.in,
    required: p.required,
    type: typeName(p),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.items?.enum ? { enum: p.items.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
    ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
    description: p.description,
  });
  return {
    operation: op.id,
    method: op.method,
    path: op.path,
    tag: op.tag,
    write: isWrite(op),
    ...(op.release ? { release: op.release } : {}),
    scopes: op.scopes,
    description: op.description,
    params: op.params.map(param),
    ...(op.body ? { body: { content_type: op.body.contentType, required: op.body.required ?? [], fields: op.body.properties } } : {}),
    how_to_call: isWrite(op)
      ? 'etsy_write_preview({ operation, params, body }) 预检 → 用户确认 → etsy_write_apply({ preview_id, confirm: true })'
      : 'etsy_api_call({ operation, params })；shop_id / user_id 不填时自动用当前店铺的',
  };
}
