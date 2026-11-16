// 组合工具端到端：MCP 进程连本机假的 Etsy 服务（ETSY_API_BASE），看商品详情、账本、订单汇总的结果
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP, grant, keysFile, tmp } from './helpers.mjs';

const SERVER = fileURLToPath(new URL('../bin/etsy-seller-mcp.mjs', import.meta.url));

/** 假 Etsy：routes(pathname, searchParams) 返回 JSON；记录请求 */
async function fakeEtsy(routes) {
  const seen = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname}?${u.searchParams}`);
    const body = routes(u.pathname, u.searchParams);
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

async function callTool(base, name, args) {
  const dir = tmp();
  const file = keysFile(dir, { ...APP, shops: { 1001: grant() } });
  const p = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ETSY_API_KEYS: file, ETSY_DATA_DIR: join(dir, 'd'), ETSY_API_BASE: base },
  });
  let buf = '';
  const reply = new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
    });
  });
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const m = await reply;
  p.stdin.end();
  const text = m.result.content[0].text;
  return m.result.isError ? { error: text } : JSON.parse(text);
}

test('listing detail: translations come back as an object keyed by language', async () => {
  const etsy = await fakeEtsy((path) => {
    if (path === '/v3/application/listings/5') {
      return { listing_id: 5, title: 'Tree &amp; Grass', price: { amount: 999, divisor: 100, currency_code: 'USD' }, translations: { de: { language: 'de' }, fr: { language: 'fr' } }, images: [] };
    }
    if (path === '/v3/application/listings/5/inventory') return { products: [] };
    return null;
  });
  try {
    const r = await callTool(etsy.base, 'etsy_listing_detail', { listing_id: 5 });
    assert.deepEqual(r.translations, ['de', 'fr']);
    assert.equal(r.title, 'Tree & Grass');
    assert.equal(r.price, 9.99);
  } finally {
    etsy.close();
  }
});

const entry = (i) => ({ entry_id: i, sequence_number: i, created_timestamp: 1_700_000_000 + i, amount: -20, balance: 10_000 + i, currency: 'USD', ledger_type: 'listing_fee', description: 'Listing fee' });
const ledger = (total) => (path, q) => {
  if (!path.endsWith('/payment-account/ledger-entries')) return null;
  const off = Number(q.get('offset'));
  const lim = Number(q.get('limit'));
  return { count: total, results: Array.from({ length: Math.max(0, Math.min(lim, total - off)) }, (_, k) => entry(off + k)) };
};

test('finance: with more entries than max_entries the newest tail is used for balance and recent', async () => {
  const etsy = await fakeEtsy(ledger(250));
  try {
    const r = await callTool(etsy.base, 'etsy_finance', { max_entries: 100 });
    assert.equal(r.entries, 100);
    assert.equal(r.balance_now.amount, (10_000 + 249) / 100);
    assert.equal(r.recent[0].amount, -0.2);
    assert.match(r.truncated, /最新的 100 笔（共 250 笔）/);
    assert.ok(etsy.seen.some((s) => s.includes('offset=150')));
  } finally {
    etsy.close();
  }
});

test('finance: when the newest entries are beyond offset 12000 it refuses instead of showing an old balance', async () => {
  const etsy = await fakeEtsy(ledger(12_500));
  try {
    const r = await callTool(etsy.base, 'etsy_finance', { max_entries: 1000 });
    assert.match(r.error, /把 days 调小/);
  } finally {
    etsy.close();
  }
});

test('orders: one receipt with two variations of a listing counts as one order; buyer data hidden', async () => {
  const etsy = await fakeEtsy((path) => {
    if (!path.endsWith('/receipts')) return null;
    return {
      count: 1,
      results: [{
        receipt_id: 1, buyer_user_id: 9, name: 'Jane', formatted_address: 'x', country_iso: 'DE', status: 'paid', is_paid: true, is_shipped: false, created_timestamp: 1_700_000_000,
        grandtotal: { amount: 3000, divisor: 100, currency_code: 'USD' }, subtotal: { amount: 2500, divisor: 100, currency_code: 'USD' },
        transactions: [
          { listing_id: 5, title: 'Tree', quantity: 2, price: { amount: 500, divisor: 100 }, variations: [{ property_id: 200, formatted_name: 'Size', formatted_value: 'S' }] },
          { listing_id: 5, title: 'Tree', quantity: 1, price: { amount: 1500, divisor: 100 }, variations: [{ property_id: 54, formatted_name: 'Engraving', formatted_value: 'JANE' }] },
        ],
      }],
    };
  });
  try {
    const r = await callTool(etsy.base, 'etsy_orders', { days: 7 });
    assert.deepEqual(r.top_listings, [{ listing_id: 5, title: 'Tree', quantity: 3, orders: 1 }]);
    assert.equal(r.summary.by_currency.USD.grandtotal, 30);
    assert.equal(r.orders[0].country, 'DE');
    assert.ok(!JSON.stringify(r).includes('Jane') && !JSON.stringify(r).includes('JANE'));
  } finally {
    etsy.close();
  }
});
