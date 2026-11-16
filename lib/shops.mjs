// 店铺配置：每家 Etsy 店对应一个 HubStudio 浏览器环境（环境 ID = containerCode），授权和店铺浏览器都按它找。
// ETSY_SHOPS='[{"name":"美国店","container_code":"1111111111","default":true}]'
// 或 ETSY_CONTAINER_CODE=1111111111（只有一家店时）。都没配时，用密钥文件里已授权的店。

export class ShopConfigError extends Error {}

const CODE = /^\d{4,20}$/;

export function parseShops(env = process.env, keys = null) {
  const raw = env.ETSY_SHOPS?.trim();
  if (raw) {
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new ShopConfigError('ETSY_SHOPS 不是合法 JSON，示例：[{"name":"美国店","container_code":"1111111111","default":true}]');
    }
    if (!Array.isArray(list) || !list.length) throw new ShopConfigError('ETSY_SHOPS 应是非空数组');
    const shops = list.map((s, i) => {
      const code = String(s?.container_code ?? '').trim();
      if (!CODE.test(code)) throw new ShopConfigError(`ETSY_SHOPS 第 ${i + 1} 项的 container_code 应是 HubStudio 环境 ID（数字）`);
      return { name: String(s.name ?? code).trim() || code, code, isDefault: s.default === true };
    });
    const names = new Set();
    for (const s of shops) {
      if (names.has(s.name)) throw new ShopConfigError(`ETSY_SHOPS 里店铺名重复：${s.name}`);
      names.add(s.name);
    }
    if (shops.filter((s) => s.isDefault).length > 1) throw new ShopConfigError('ETSY_SHOPS 里只能有一家 default: true');
    return shops;
  }
  const one = env.ETSY_CONTAINER_CODE?.trim();
  if (one) {
    if (!CODE.test(one)) throw new ShopConfigError('ETSY_CONTAINER_CODE 应是 HubStudio 环境 ID（数字）');
    return [{ name: one, code: one, isDefault: true }];
  }
  const granted = Object.entries(keys?.shops ?? {}).filter(([code, g]) => CODE.test(code) && g?.refresh_token);
  return granted.map(([code, g], i) => ({ name: g.shop_name || code, code, isDefault: i === 0 }));
}

/** 按店铺名或环境 ID 找店；不传用默认店（只有一家时就是它） */
export function resolveShop(shops, ref) {
  if (!shops.length) {
    throw new ShopConfigError('还没有配置 Etsy 店铺：先运行「npx -y etsy-seller-mcp@latest auth --container <HubStudio 环境 ID>」授权，或在 MCP 配置里设 ETSY_SHOPS');
  }
  if (ref === undefined || ref === null || ref === '') {
    const d = shops.find((s) => s.isDefault) ?? (shops.length === 1 ? shops[0] : null);
    if (!d) throw new ShopConfigError(`有多家店，请用 shop 指定：${shops.map((s) => s.name).join('、')}`);
    return d;
  }
  const r = String(ref).trim();
  const hit = shops.find((s) => s.name === r || s.code === r);
  if (!hit) throw new ShopConfigError(`没有这家店：${r}（已配置：${shops.map((s) => `${s.name}(${s.code})`).join('、')}）`);
  return hit;
}
