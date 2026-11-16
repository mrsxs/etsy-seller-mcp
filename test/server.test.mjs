import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP, grant, keysFile, tmp } from './helpers.mjs';

const SERVER = fileURLToPath(new URL('../bin/etsy-seller-mcp.mjs', import.meta.url));

/** 起一个 MCP 进程（不联网的请求），逐条发请求拿回复 */
async function session(env, requests) {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  let buf = '';
  const replies = new Map();
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
      waiters.get(m.id)?.(m);
    }
  });
  const out = [];
  for (const r of requests) {
    out.push(await new Promise((resolve) => {
      waiters.set(r.id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...r })}\n`);
    }));
  }
  p.stdin.end();
  return out;
}

const text = (m) => m.result.content[0].text;

test('server: initialize, 15 tools, multi-shop status, argument checks, write guards', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1111111111: grant({ shop_name: 'CN' }) } });
  const env = {
    ETSY_API_KEYS: file,
    ETSY_DATA_DIR: join(dir, 'data'),
    ETSY_SHOPS: JSON.stringify([{ name: '美国店', container_code: '1111111111', default: true }, { name: '二店', container_code: '2222222222' }]),
  };
  const [init, list, shops, badArg, writeViaCall, readViaPreview, unknown, describe] = await session(env, [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'etsy_shops', arguments: {} } },
    { id: 4, method: 'tools/call', params: { name: 'etsy_orders', arguments: { days: 'thirty' } } },
    { id: 5, method: 'tools/call', params: { name: 'etsy_api_call', arguments: { operation: 'updateListing', params: {} } } },
    { id: 6, method: 'tools/call', params: { name: 'etsy_write_preview', arguments: { operation: 'getShop' } } },
    { id: 7, method: 'tools/call', params: { name: 'etsy_nope', arguments: {} } },
    { id: 8, method: 'tools/call', params: { name: 'etsy_api_describe', arguments: { operation: 'createReceiptShipment' } } },
  ]);
  assert.equal(init.result.serverInfo.name, 'etsy-seller-mcp');
  assert.match(init.result.instructions, /etsy_write_preview/);
  assert.equal(list.result.tools.length, 15);
  assert.ok(list.result.tools.every((t) => !('run' in t)));
  const s = JSON.parse(text(shops));
  assert.deepEqual(s.shops.map((x) => [x.name, x.authorized, x.default]), [['美国店', true, true], ['二店', false, false]]);
  assert.match(s.shops[1].how_to_authorize, /auth --container 2222222222/);
  assert.ok(!text(shops).includes('access-ok'), '不暴露令牌');
  assert.match(text(badArg), /days 必须是整数/);
  assert.match(text(writeViaCall), /写操作.*etsy_write_preview/);
  assert.match(text(readViaPreview), /查询接口/);
  assert.equal(unknown.result.isError, true);
  assert.match(text(describe), /tracking_code/);
});

test('server: read-only mode refuses previews; writes for another shop_id are refused', async () => {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant() } });
  const [ro] = await session({ ETSY_API_KEYS: file, ETSY_DATA_DIR: join(dir, 'd'), ETSY_READ_ONLY: 'true' }, [
    { id: 1, method: 'tools/call', params: { name: 'etsy_write_preview', arguments: { operation: 'updateShop', body: { title: 'x' } } } },
  ]);
  assert.match(text(ro), /只读模式/);
  const [other] = await session({ ETSY_API_KEYS: file, ETSY_DATA_DIR: join(dir, 'd') }, [
    { id: 1, method: 'tools/call', params: { name: 'etsy_write_preview', arguments: { operation: 'updateShop', params: { shop_id: 999 }, body: { title: 'x' } } } },
  ]);
  assert.match(text(other), /只能改本店/);
});

test('server: --help lists the auth command and multi-shop config', async () => {
  const p = spawn(process.execPath, [SERVER, '--help']);
  let out = '';
  for await (const d of p.stdout) out += d;
  assert.match(out, /auth --container/);
  assert.match(out, /ETSY_SHOPS/);
});
