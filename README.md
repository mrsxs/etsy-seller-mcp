# etsy-seller-mcp

Etsy 卖家 MCP（stdio，零依赖，Node ≥ 22）：

- **Etsy Open API v3 全部 107 个接口**：目录搜索（中英文关键词）→ 看参数 → 调用，参数按官方规格校验。
- **组合工具**：店铺概况、商品列表、商品详情、规格库存、订单汇总、支付流水、评价、前台竞品搜索、类目搜索，一次调用出结果。
- **写接口（42 个）一律两步**：`etsy_write_preview` 预检（读改前状态，给出改前 → 改后、费用和风险提示，不改平台上的东西）→ 用户确认 → `etsy_write_apply` 执行。执行前重新读一遍，被别处改过就拒绝；网络中断后同一个 `preview_id` 再执行会先对账。
- **多店铺**：每家店对应一个 HubStudio 浏览器环境，授权在这家店自己的环境（IP、指纹）里完成；每家店用自己的 Seller app。
- **隐私**：结果里买家姓名、地址、邮箱、留言、礼物附言、个性化内容一律隐藏，只留收货国家。

## 工具

| 工具 | 做什么 |
|---|---|
| `etsy_shops` | 已配置的店铺、授权状态和有效期、是否只读 |
| `etsy_shop_overview` | 店铺概况 + 分区、运费模板、退货政策 |
| `etsy_listings` | 商品列表（在售 / 下架 / 售罄 / 草稿 / 过期），可按标题 / 标签 / SKU 查找 |
| `etsy_listing_detail` | 单个商品全部信息 + 每个规格的 SKU、价格、数量 |
| `etsy_inventory` | 批量查规格库存（最多 100 个商品） |
| `etsy_orders` | 最近 N 天订单：按币种汇总、已付款 / 发货 / 取消、热卖商品、每单明细 |
| `etsy_finance` | 支付账户流水：余额、各类收支、净额、最近 20 笔 |
| `etsy_reviews` | 评价：平均分、星级分布、差评原文 |
| `etsy_market_search` | 前台在售商品搜索（竞品价格分布，统一换算成美元等） |
| `etsy_category_search` | 卖家类目搜索（刊登用叶子类目） |
| `etsy_api_catalog` / `etsy_api_describe` / `etsy_api_call` | 全部接口：搜索 → 看参数 → 调查询接口 |
| `etsy_write_preview` / `etsy_write_apply` | 任意写接口：预检 → 确认后执行 |

## 第一次用：每家店做一次

1. **建 Seller app**：在这家店的 HubStudio 环境里登录 Etsy，打开 <https://www.etsy.com/developers/your-apps> → Create a seller app，等批准（通常很快）。Seller app 只能授权建它的那个账号自己的店，所以**每家店各建一个**。
2. **登记回调地址**：Your Apps → Edit callback URLs，加上
   `https://localhost/etsy-seller-mcp/callback`
   （授权时回跳请求会在浏览器里直接被拦下取 code，不需要真有这个网址。）
3. **授权**（先开小火箭等代理，HubStudio 环境代理才连得上）：

   ```bash
   npx -y etsy-seller-mcp@latest auth --container <HubStudio 环境 ID>
   ```

   会在这家店的 HubStudio 浏览器里新开标签页打开 Etsy 授权页，点「Grant access」即可。这家店还没有应用密钥时，会先从它环境里的 Your Apps 页读取（不在终端显示）。授权 90 天有效，期间用工具会自动续期；超过 90 天没用就要重新授权。

   - `--app-from-page`：重新读取应用密钥（换了应用、轮换了 shared secret 时）
   - `--read-only`：只申请读权限
   - `--redirect-uri <URL>`：回调地址换成别的（要和登记的完全一致）

HubStudio 环境 ID 在 HubStudio 环境列表里（或本地接口 `POST http://127.0.0.1:6873/api/v1/env/list`）。

## MCP 配置

```json
{
  "mcpServers": {
    "etsy-seller": {
      "command": "npx",
      "args": ["-y", "etsy-seller-mcp@latest"],
      "env": {
        "ETSY_SHOPS": "[{\"name\":\"美国店\",\"container_code\":\"1111111111\",\"default\":true},{\"name\":\"二店\",\"container_code\":\"2222222222\"}]"
      }
    }
  }
}
```

问到某家店时传 `shop`（店铺名或环境 ID）；不传用默认店。不设 `ETSY_SHOPS` 时，自动用密钥文件里已授权的店。

| 环境变量 | 说明 |
|---|---|
| `ETSY_SHOPS` | 店铺数组：`name`、`container_code`（HubStudio 环境 ID）、`default` |
| `ETSY_CONTAINER_CODE` | 只有一家店时可以只写环境 ID |
| `ETSY_API_KEYS` | 应用密钥和店铺授权文件，默认 `~/.config/etsy-seller-mcp/api-keys.json`（600 权限，换电脑时原样拷过去） |
| `ETSY_DATA_DIR` | 预检记录、执行日志（`write-log.jsonl`）、锁，默认 `~/.etsy-seller-mcp` |
| `ETSY_READ_ONLY` | `true` = 只读，不允许任何写操作 |
| `HUBSTUDIO_API` | HubStudio 本地接口，默认 `http://127.0.0.1:6873`（只有 auth 用） |

## 注意

- **额度**：每个应用 10 次 / 秒、1 万次 / 天（Etsy 后台可看）。本工具每进程限 5 次 / 秒；遇到限流会说明，不会反复重试。
- **分页**：每页最多 100 条，`offset` 最大 12000。
- **费用**：草稿发布 / 商品从下架、过期改成在售时 Etsy 收 0.20 美元刊登费，预检会提示。
- **库存 / 价格 / 规格（updateListingInventory）是整组替换**；Etsy 现在要求每个 offering 带 `readiness_state_id`（处理时间配置，`getShopReadinessStateDefinitions` 查）。
- **结果不确定时**：修改 / 删除类用同一个 `preview_id` 再执行会先对账、可安全重发；创建 / 上传 / 加运单类不会自动重发，要先查询确认。
- **账本金额**按最小货币单位记，`etsy_finance` 已除以 100。
- 调 Etsy 接口走本机网络（Node 不读系统代理）；HubStudio 只在授权时用。
- 接口目录来自官方 OpenAPI（`spec/etsy-oas-3.0.0.json`），更新：下载新版覆盖后 `npm run build-spec`。

## 开发

```bash
npm test
node bin/etsy-seller-mcp.mjs --help
```
