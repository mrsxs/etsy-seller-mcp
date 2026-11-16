#!/usr/bin/env node
// 从 Etsy 官方 OpenAPI（spec/etsy-oas-3.0.0.json，来自 https://www.etsy.com/openapi/generated/oas/3.0.0.json）
// 生成随包分发的精简接口目录 spec/operations.json：每个接口的方法、路径、分类、说明、所需权限、参数和请求体结构。
// 用法：node scripts/build-spec.mjs [源文件]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] || join(ROOT, 'spec', 'etsy-oas-3.0.0.json');
const oas = JSON.parse(readFileSync(src, 'utf8'));

/** 说明开头的发布状态徽章（General Release / Feedback only） */
const releaseOf = (s) => (/wt-badge[^>]*>\s*([^<]+?)\s*</.exec(s ?? '')?.[1] ?? 'General Release');

/** 去掉开头的徽章 HTML、文档内链接，压缩空白，截断过长说明 */
function text(s, max) {
  if (!s) return undefined;
  let t = String(s)
    .replace(/^(\s*<div[^>]*>.*?<\/div>)+/s, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t || undefined;
}

const KEEP = ['type', 'format', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'nullable', 'minItems', 'maxItems'];

function schema(s, depth = 0) {
  if (!s || typeof s !== 'object') return undefined;
  const out = {};
  for (const k of KEEP) if (s[k] !== undefined) out[k] = s[k];
  if (s.default !== undefined && s.default !== null) out.default = s.default;
  const d = text(s.description, depth ? 240 : 400);
  if (d) out.description = d;
  if (s.items) out.items = schema(s.items, depth + 1);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = schema(v, depth + 1);
    if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  }
  if (s.oneOf || s.anyOf) out.oneOf = (s.oneOf || s.anyOf).map((x) => schema(x, depth + 1));
  return out;
}

const ops = [];
for (const [path, item] of Object.entries(oas.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const scopes = [...new Set((op.security || []).flatMap((x) => Object.values(x).flat()))].sort();
    const params = (op.parameters || []).map((p) => ({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      ...schema({ ...p.schema, description: p.description || p.schema?.description }),
    }));
    let body;
    const content = op.requestBody?.content;
    if (content) {
      const [contentType, v] = Object.entries(content)[0];
      body = { contentType, ...schema(v.schema) };
    }
    ops.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      tag: (op.tags || ['Other'])[0],
      ...(releaseOf(op.description) !== 'General Release' ? { release: releaseOf(op.description) } : {}),
      summary: text(op.summary || op.description, 160),
      description: text(op.description, 900),
      scopes,
      params,
      ...(body ? { body } : {}),
    });
  }
}
ops.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const out = {
  source: 'https://www.etsy.com/openapi/generated/oas/3.0.0.json',
  title: oas.info?.title,
  version: oas.info?.version,
  generated_at: new Date().toISOString().slice(0, 10),
  scopes: oas.components?.securitySchemes?.oauth2?.flows?.authorizationCode?.scopes ?? {},
  operations: ops,
};
const file = join(ROOT, 'spec', 'operations.json');
writeFileSync(file, `${JSON.stringify(out)}\n`);
process.stdout.write(`${ops.length} 个接口 → ${file}（${(JSON.stringify(out).length / 1024).toFixed(0)} KB）\n`);
