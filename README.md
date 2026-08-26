# AI 价格雷达 ⚡

每天定时从各 AI 厂商**官方定价页面**抓取模型价格明细，用网站展示价格表 + 折线趋势图。部署在 **Cloudflare Workers** 上，存储用 **D1**，通过 **GitHub Actions** 自动部署。

## 功能特性

- **7 家主流厂商**官方定价页每日自动抓取归档：Anthropic / OpenAI / Gemini / DeepSeek / Kimi / 通义千问 / 智谱 GLM
- **双币展示**：价格列表按原始货币（USD / CNY），趋势图一键切换对比
- **价格趋势折线图**（ECharts）：多模型同图、对数坐标、数据缩放、任意时间范围
- **管理后台** `/admin`：概览 / 手动抓取 / 单厂商排查 / 通知设置 / 日志
- **主动告警**：厂商改版或抓取失败时 → 网页横幅 + Webhook（钉钉/企微/Slack）+ 邮件（SMTP/HTTP API）+ RSS 订阅
- **健壮性**：单厂商失败不影响其它、保留旧价、疑似改版自动标记、CI 全链路测试

## 监控范围

| 厂商 | 官方定价源 | 计价 | 模型示例 |
|---|---|---|---|
| Anthropic | platform.claude.com（官方 Markdown） | USD | Claude Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5 |
| OpenAI | developers.openai.com（.md） | USD | GPT-5.x / GPT-4o / o 系列 |
| Google Gemini | ai.google.dev（.md.txt） | USD | Gemini 3.x / 2.x Flash / Pro |
| DeepSeek | api-docs.deepseek.com | USD | deepseek-v4-flash / v4-pro |
| Kimi | platform.kimi.com 首页 | CNY | kimi-k3 / k2.7-code / k2.6 |
| 通义千问 | help.aliyun.com 百炼 | CNY | qwen3.8-max / qwen3.7-plus / qwen3.7-flash 等 |
| 智谱 GLM | bigmodel.cn（官方 bundle） | CNY | GLM-5.3 / GLM-5 / GLM-4.7-Flash（免费） |

- **双币显示**：价格列表按厂商原始货币（国际=USD、国内=CNY）；趋势图默认 USD 对比，可一键切换 CNY。
- 人民币↔美元用固定汇率换算（`USD_TO_CNY` 配置），页面会标注"固定汇率"。

## 架构

```
[Cron 每天 00:15 UTC]  ─┐
[POST /api/trigger]    ─┴─>  src/scrape.js
        并行抓取 7 家官方定价页
          -> 各 scraper parse() -> 双币归一化（convert.js）
          -> upsert 到 D1 price_history（同日幂等）
          -> 写 fetch_log（每厂商状态，失败保留旧价）

GET /                     静态页面（wrangler assets 托管 public/）
GET /admin                管理后台（密码登录）
GET /api/prices/latest    最新一天全部价格（按厂商分组，含双币列）
GET /api/prices/history   单模型时序（同时返回 usd+cny，前端切币种零请求）
GET /api/meta             厂商/模型清单、最近抓取状态、汇率
GET /api/feed             RSS 订阅源（含抓取失败/疑似改版条目）
GET /healthz              存活检查
POST /api/trigger         手动触发抓取（需 x-trigger-secret 头）

管理后台 API（需 x-admin-token，登录后获得）：
POST /api/admin/login                    密码登录 -> token
GET  /api/admin/overview                 概览：各厂商状态/模型数/最近抓取
POST /api/admin/trigger                  立即抓取全部厂商
POST /api/admin/run                      单厂商重跑（{provider}，排查用）
GET/PUT /api/admin/settings              读取/更新通知设置
GET  /api/admin/logs?limit=50            最近抓取日志
POST /api/admin/test-notification        发送测试通知
```

```
项目结构
├─ wrangler.jsonc           # Worker 配置（cron / assets / D1 / vars）
├─ migrations/0001_init.sql # D1 schema
├─ src/
│  ├─ index.js              # Worker 入口：路由 + scheduled
│  ├─ scrape.js             # 抓取编排（并行、降级、汇总）
│  ├─ convert.js            # 双币换算（全项目唯一汇率逻辑）
│  ├─ utils.js              # 抓取/表格/金额解析工具
│  ├─ db.js                 # D1 帮助函数
│  └─ scrapers/             # 每个厂商一个 adapter
├─ public/                  # 前端（index.html / app.js / style.css，ECharts 折线图）
└─ scripts/
   ├─ check-scrapers.mjs    # 逐个抓官方页验证解析器（node scripts/check-scrapers.mjs）
   └─ smoke.mjs             # 端到端冒烟测试（node:sqlite 模拟 D1，node scripts/smoke.mjs）
```

## 本地开发

前置：Node ≥ 22（冒烟测试 `scripts/smoke.mjs` 用 `node:sqlite`，需要 Node 22+）。

```bash
npm install
# 复制敏感变量示例（本地测试 trigger / 管理后台需要）
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars，然后填值
npx wrangler login                      # 登录 Cloudflare（部署前需要）
npx wrangler d1 create ai-price-radar-db   # 建远程 D1 库，记下输出的 database_id
export D1_DATABASE_ID="<database_id>"   # PowerShell: $env:D1_DATABASE_ID="<database_id>"（供本地 wrangler 命令解析配置）
npx wrangler d1 migrations apply ai-price-radar-db --local
npm run dev                              # 启动本地开发（wrangler dev --test-scheduled）
```

本地触发与调试：

```bash
# 触发 scheduled handler（需 dev 带 --test-scheduled）
curl -X POST "http://localhost:8787/__scheduled?cron=15+0+*+*+*"

# 手动触发抓取
curl -X POST http://localhost:8787/api/trigger -H "x-trigger-secret: <你的TRIGGER_SECRET>"

# 查看本地数据
npx wrangler d1 execute ai-price-radar-db --local --command "SELECT provider, COUNT(*) AS n FROM price_history GROUP BY provider"

# 验证各厂商解析器（真实抓官方页面）
npm run check:scrapers
```

> 注：若 Windows 上 `wrangler dev` 报 `bind: #10013`（端口被安全策略禁止监听），可换端口 `npx wrangler dev --port 8790`；若仍不行，说明该环境禁止 workerd 绑定本地端口，可改用 `npm run check:scrapers` + `npm run smoke` 验证逻辑（后者用 node:sqlite 跑通完整链路）。

## 通过 GitHub Actions 自动部署（推荐）

每次 push 到 GitHub `main`，自动执行 `.github/workflows/deploy.yml`：

```
CI 验证（npm run check:scrapers + npm run smoke + wrangler 配置校验）
  └─> wrangler d1 migrations apply --remote（生产库建表）
        └─> wrangler deploy（Worker + cron + 静态资源）
              └─> 注入 TRIGGER_SECRET / ADMIN_PASSWORD 为 Worker Secrets
```

### 一次性准备

**1. 在 GitHub 创建仓库并推送**（已配置好 git 与本仓库文件）：

```bash
gh auth login                                        # 首次登录 GitHub
gh repo create ai-price-radar --public --source . --push
```

**2. 本地建 D1 库**（只需一次），拿到 `database_id`：

```bash
npx wrangler login
npx wrangler d1 create ai-price-radar-db   # 输出里的 database_id 类似 1a2b3c4d-...
```

`database_id` **不写进仓库**（避免公开泄露）：`wrangler.jsonc` 里是 `${D1_DATABASE_ID}`，由环境变量提供。CI 里把它放进仓库 Secret。

**3. 在 GitHub 仓库添加 5 个 Actions Secrets**（Settings → Secrets and variables → Actions → New repository secret）：

| Secret | 获取方式 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token，权限勾选 **Workers Scripts: Edit** 和 **D1: Edit**，区域选 All zones |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard 首页右下角 Account ID |
| `D1_DATABASE_ID` | 上面 `wrangler d1 create` 输出的 database_id |
| `TRIGGER_SECRET` | 任意长随机串，用于 `POST /api/trigger` 鉴权 |
| `ADMIN_PASSWORD` | 管理后台 `/admin` 登录密码 |

之后每次 push 到 `main` 会自动部署；也可以在 Actions 页面点 **Run workflow** 手动触发。

> 注意：`database_id` 通过 `${D1_DATABASE_ID}` 从环境变量读取（本地开发需先 `export D1_DATABASE_ID=<uuid>`；PowerShell 用 `$env:D1_DATABASE_ID="<uuid>"`）。CI 里若没配 `D1_DATABASE_ID` secret，部署会报错并提示。

### 手动部署（不依赖 GitHub Actions）

```bash
export D1_DATABASE_ID="<database_id>"    # PowerShell: $env:D1_DATABASE_ID="<database_id>"
npx wrangler d1 migrations apply ai-price-radar-db --remote   # 生产库建表
npx wrangler deploy                                            # 部署 Worker（自动带上 cron 与 assets）
echo "<你的TRIGGER_SECRET>" | npx wrangler secret put TRIGGER_SECRET
echo "<你的ADMIN_PASSWORD>" | npx wrangler secret put ADMIN_PASSWORD
```

### 部署后验证

```bash
curl https://<你的worker域名>/api/meta
curl https://<你的worker域名>/api/prices/latest
curl "https://<你的worker域名>/api/prices/history?provider=anthropic&model=claude-sonnet-5&days=30"
curl -X POST https://<你的worker域名>/api/trigger -H "x-trigger-secret: <你的TRIGGER_SECRET>"
```

首次部署后每天 00:15 UTC（北京 08:15）自动抓取；也可手动 trigger 立即抓一次。

## 配置（wrangler.jsonc vars）

| 变量 | 说明 | 默认 |
|---|---|---|
| `USD_TO_CNY` | 人民币↔美元固定汇率 | `7.15` |
| `FETCH_TIMEOUT_MS` | 单次抓取超时 | `15000` |
| `FETCH_RETRIES` | 重试次数 | `1` |
| `SCRAPE_PROVIDERS` | 启用的厂商（逗号分隔） | 全部 7 家 |
| `ALERT_WEBHOOK_URL` | 抓取失败/疑似改版时的告警 webhook（钉钉/企业微信/Slack/通用机器人），留空不告警 | 空 |
| `EMAIL_SMTP_HOST/PORT/USER/PASS/TLS` | 邮件 SMTP 配置（也可在后台「通知设置」改） | 空 / 587 / starttls |
| `EMAIL_FROM` / `EMAIL_TO` | 发件人 / 收件人（逗号分隔） | 空 |
| `EMAIL_API_URL` / `EMAIL_API_KEY` | HTTP 邮件 API（Resend/Mailgun 等），SMTP 不可用时回退 | 空 |
| `APP_BASE_URL` | RSS 订阅源里展示的站点根地址（可选） | 空 |

以下两个是**敏感变量（Secret）**，不写在 `wrangler.jsonc` 里，用 `wrangler secret put` 注入（GitHub Actions 已配置从仓库 Secrets 注入；本地开发放 `.dev.vars`，参考 `.dev.vars.example`）：

| Secret | 说明 |
|---|---|
| `TRIGGER_SECRET` | `POST /api/trigger` 手动触发抓取的密钥（任意长随机串） |
| `ADMIN_PASSWORD` | 管理后台 `/admin` 登录密码（务必改强） |

## 告警与监控（官方页面改版怎么提醒）

厂商改版导致抓取失败时，有三种方式会提醒你，无需每天手动检查：

1. **网站横幅 + 状态区**：打开站点时，若某厂商 `error`（抓取失败）或 `partial`（疑似改版），顶部会出现红色横幅，底部"抓取状态"逐家显示红/橙/绿点。
2. **webhook 主动推送**：在 `wrangler.jsonc` 配置 `ALERT_WEBHOOK_URL`（钉钉/企业微信机器人、Slack Incoming Webhook 或任意通用 webhook）。仅在厂商状态**从正常变为失败/疑似改版的瞬间**推送一条告警（含厂商、原因、修复建议）；连续多天失败不会每天重复轰炸，恢复后再失败会重新提醒。
3. **RSS 订阅源**：`/api/feed` 输出最近抓取状态 RSS，可在 Feedly / Inoreader 等阅读器订阅，异常条目带 ⚠️ 前缀。

**"疑似改版"检测**：即使页面还能抓到数据，如果某厂商解析出的模型数比最近一次历史**骤降 40% 以上**（如 15 → 3），会自动标记 `partial` 并告警——这通常意味着页面结构变了、只抓到了部分数据。此时运行 `npm run check:scrapers <厂商>` 定位问题并修复解析器。

## 管理后台（/admin）

打开 `https://<你的域名>/admin`，用 `ADMIN_PASSWORD` 登录。包含四个视图：

| 视图 | 功能 |
|---|---|
| 概览 | 各厂商状态灯、模型数、最近抓取时间、错误提示；支持单厂商"重跑"排查 |
| 抓取 | 一键抓取全部厂商；单厂商重跑（页面改版时先用它验证解析器是否已修复） |
| 通知设置 | 网页表单直接配置 Webhook / SMTP 邮件 / HTTP 邮件 API，保存即生效，无需改代码重部署 |
| 日志 | 最近 50 次抓取日志（时间/厂商/状态/模型数/耗时/错误） |

登录 token 用 HMAC 签名、12 小时有效；所有管理接口都要带 `x-admin-token`。

## 邮件通知（SMTP / HTTP API）

在管理后台「通知设置」配置：

- **SMTP**：填 `SMTP 主机`、`端口`（默认 587）、`TLS 模式`（`starttls` 或 `none`）、`用户名`、`密码/授权码`（QQ/163 等用授权码）、`发件人`、`收件人`。支持普通端口和 STARTTLS。
  > ⚠️ SMTP 通过 Cloudflare Workers 的**出站 TCP** 发送，需要 **Workers Paid 计划**；且 `cloudflare:sockets` 不支持隐式 TLS(465) 直连。若你的服务商仅提供隐式 TLS，或你在免费计划上，请改用 HTTP 邮件 API。
- **HTTP 邮件 API**：填 `API URL`（如 `https://api.resend.com/emails`）和 `API Key`，免费套餐可用。配置了 SMTP 主机时优先走 SMTP，失败时自动回退到 API。

两种方式都可以在「发送测试通知」按钮验证是否配置成功。抓取异常时（失败/疑似改版），会**同时**推送 webhook 和邮件；也可通过后台手动发测试通知确认通道正常。

## 新增/修改厂商 scraper

每个厂商在 `src/scrapers/<name>.js` 导出一个 adapter：

```js
export const provider = 'anthropic';   // 固定 ID
export const label = 'Anthropic';      // 展示名
export const url = 'https://...';      // 官方定价页
export const currency = 'USD';         // 源币种 USD | CNY
export async function parse(text, env) // 输入页面原文，输出 RawPrice[]
```

`RawPrice = { model, input, output, cacheHit?, contextWindow?, notes? }`，单位统一为「每 1M tokens / 源币种」。`convert.normalize()` 会自动补齐 USD/CNY 双币列。写好后用 `npm run check:scrapers <name>` 验证，并记得加进 `scrape.js` 的 `ALL_PROVIDERS`。

## 健壮性设计

- 每厂商 `try/catch` 独立降级：某家失败不影响其余，**失败时不清空旧价**，前端仍展示最近一次成功价。
- `fetch_log` 记录每次运行每厂商的状态/数量/错误/耗时；`/api/meta` 返回最近抓取状态。
- 每个 scraper 有 sanity 锚点（解析数过少/关键模型缺失判为失败），防止官方页面改版后静默出错。
- 复合主键 `(date, provider, model)` + upsert：同日重复运行幂等。
- 官方页面结构可能变动，建议定期运行 `npm run check:scrapers` 巡检。

## 已知取舍

- 通义千问只取**国内（华北2）**分区文本模型价；阿里帮助文档表格复杂，阶梯价取第一档、其余入 `notes`。
- DeepSeek 采用 **PEAK 档**（标准价），OFF-PEAK 记入 `notes`。
- OpenAI 取 developers.openai.com 的 Standard（短上下文）价；部分模型有长上下文/促销等其它档位未单独列出。
- Gemini 输出价含思考（thinking）token，已写入 `notes.outputIncludesThinking`。
- 汇率固定，人民币换算价仅供参考。
