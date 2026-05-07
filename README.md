# US Housing Daily — 美国住宅地产新闻聚合 Agent

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Vercel](https://img.shields.io/badge/Hosted_on-Vercel-black?logo=vercel)](https://vercel.com)
[![Daily build](https://img.shields.io/badge/cron-08:57_Beijing_daily-brightgreen)](.github/workflows/daily.yml)

每天北京时间 08:57 截止数据、08:57:01 GitHub Actions 触发，约 09:00 页面更新：抓 **30 个一手 RSS 信源** → 24h 时间窗 → 实体级去重 → 跨日去重（rolling 21d）→ enrich 全文 → 5 section 配额挑选 → LLM 一次性产出 20 条中文译标 + 摘要 + ★重要性 + 利好利空。结果写成静态 JSON、提交到 git、Vercel 自动部署。

> A daily aggregator that pulls 30 US residential real-estate RSS feeds, scores and clusters them, and uses an OpenAI-compatible LLM to produce Chinese-language titled summaries with importance scores and impact direction. Runs on free GitHub Actions + Vercel hobby tier.

```
30 RSS 源
  ↓ 解析 / 评分 / 标签 (4 维度 ~28 tag)
  ↓ 24h 时间窗 + 实体级去重 + 跨日去重 (21d seen list)
  ↓ Top-30 并发抓全文 HTML → 提取 article body
  ↓ 重新打分 / 重新分类 (title-only 决策)
  ↓ 5 section 配额挑选 (national 5 / sunbelt 4 / btr 3 / cre 5 / institutional 3)
  ↓ ensureSectionMinimum: 每 section 至少 2 条（24h 不够时按规则扩 7d）
  ↓ ensureTexasCity: 后 4 个 section 至少 1 条 dfw/houston/austin
  ↓ LLM 单次 batch (20 条) → 中文译标 + 摘要 + imp 1-5 + dir 五选一
写出 data/latest.json + data/YYYY-MM-DD.json
```

**90% 是脚本（fetch / 正则 / 算分 / 分类 / 去重）；10% 是 LLM**（单次调用产出所有摘要，所以成本极低）。

---

## Quickstart

```bash
# 1. Fork 然后 clone
git clone https://github.com/<你的用户名>/us-housing-daily.git
cd us-housing-daily

# 2. 配置环境
cp .env.example .env
# 编辑 .env 填入 LLM_API_KEY / LLM_ENDPOINT / LLM_MODEL / SEC_CONTACT_EMAIL

# 3. 跑一次完整 pipeline
npm run build
# 或不调 LLM 验证抓取链路: LLM_SKIP=1 node scripts/build.mjs

# 4. 本地预览前端
npm run preview
# 打开 http://localhost:8080
```

要把它跑成每天自动更新的网站，跟 [完整部署](#-部署到-vercel--github-actions约-15-分钟) 那一节走一遍即可。

---

## 文件结构

```
us-housing-daily/
├── README.md / LICENSE
├── package.json / vercel.json
├── .env.example                    # 复制为 .env 填值
├── .github/workflows/daily.yml     # 每天 UTC 00:57 (北京 08:57) cron
├── config/
│   └── sources.json                # 30 个 RSS 源（可编辑）
├── scripts/
│   └── build.mjs                   # 主 pipeline (~900 行，无 src/ 依赖)
├── public/                         # 静态前端 (Vercel 部署根目录)
│   ├── index.html / style.css / app.js
├── data/                           # GitHub Action 写入并 commit
│   ├── latest.json
│   ├── 2026-MM-DD.json
│   └── dates.json                  # 日期索引
└── state/
    └── seen.json                   # 跨日去重 (rolling 21d)
```

---

## 五大 Section + Quota 机制

| Section | quota | 内容 | 数据窗口 |
| --- | --- | --- | --- |
| 🏠 全国住宅市场 (national) | 5 | 全国房市 / 利率 / 政策 / NAR / Realtor / Zillow / Calculated Risk | 严格 24h |
| 🌵 Sunbelt 住宅 (sunbelt) | 4 | TX / AZ / GA / FL 等 Sun Belt 各州住宅与租赁市场 | 24h，不够扩 7d |
| 🏘 全国 BTR / SFR (btr) | 3 | Build-to-Rent / Single-Family Rental | 24h，不够扩 7d |
| 🏢 全国 CRE (cre) | 5 | 办公 / 工业 / 数据中心 / 仓储 / 多户 / 酒店 | 严格 24h |
| 💰 全国机构资本 (institutional) | 3 | PE / REIT 募资、并购、IPO、机构持仓 | 24h，不够扩 7d |

**3-pass filler 策略**（确保 final = 20 条）：
1. 24h 池 + 严格 quota 限额（高频 section 不会 overflow）
2. 7d 池 + 仅扩窗 section（sunbelt/btr/institutional）+ 严格 quota
3. 24h 池兜底 + 不限 quota（极端情况下宁可 national 多也不让 cre/national 用旧数据）

**扩窗的项**会被标记 `extended_window: true`，前端用 ext-pill badge 显示。

**分类规则要点**（`classify()` in build.mjs）：
- `multifamily` 资产类（MAA / Essex / AvalonBay 财报）→ 默认 cre；但若 title 同时含 Sun Belt 城市 → sunbelt
- `houston-agent` / `d-magazine` 等区域行业媒体的"业内花絮"（设计趋势 / 任命 / 新办公室）→ national，不再兜底进 sunbelt
- `trerc` 区域研究源 title 通常不带城市但内容默认地产，特殊兜底进 sunbelt

---

## Alternates URL（Cloudflare/Substack 兜底）

某些原站（Inman / Multi-Housing News / Substack）会对 GitHub Actions IP 段返 HTTP 403。每个 source 可在 `config/sources.json` 加 `alternates: []` 字段，fetcher 会在原 URL 失败时按顺序回落：

```json
{
  "id": "inman",
  "url": "https://www.inman.com/feed/",
  "alternates": [
    "https://news.google.com/rss/search?q=site:inman.com&hl=en-US&gl=US&ceid=US:en"
  ],
  ...
}
```

默认走 Google News RSS（免代理免 secret，永远从 GitHub Actions 可达），代价是新闻索引有 2-6h 延迟、description 较短。如果某天 Google News 也不够稳定，可改加 RSSHub 自部署 endpoint 或 Vercel function proxy（详见 [`scripts/build.mjs`](scripts/build.mjs) 注释）。

`fetcher` 还做了：
- 浏览器 sec-ch-ua / Referer / Accept-Encoding 等完整指纹（非 SEC 源）
- primary URL 仅在 5xx / 网络错误时重试一次（403 直接走 alternate）
- 所有 attempted URL 写入 `data/latest.json` 的 `errors[]`，便于排查

---

## 信源池（30 个）

| Tier | 数量 | 代表 |
| --- | --- | --- |
| A 一线媒体 | 12 | HousingWire / Inman / TRD / Bisnow / Multi-Housing News / National Mortgage News / CNBC RE / Realtor News / Redfin News / Multifamily Dive / Connect CRE / REBusiness |
| B KOL & 数据 | 9 | Calculated Risk / Lance Lambert (ResiClub) / Logan Mohtashami / Yardi Matrix / Realtor Research / PERE News / Pretium / SEC INVH 8-K / SEC AMH 8-K |
| C 政策宏观 | 2 | Federal Reserve Press / Brookings |
| D 区域 | 6 | TRERC / D Magazine / Houston Agent / Phoenix Agent / Atlanta Agent / Miami Agent |
| E 协会 / 机构 | 1 | National Rental Home Council (NRHC) |

加 / 改 / 删信源 → 编辑 `config/sources.json` → push 到 main → Action 自动跑下一轮。

---

## 部署到 Vercel + GitHub Actions（约 15 分钟）

### 0. 前置

- GitHub 账号（个人免费）
- Vercel 账号（hobby 免费）
- LLM API key（任何 OpenAI 兼容服务：OpenAI / Anthropic via proxy / Together / Fireworks / Groq / 自部署 vLLM）

### 1. Fork 或推到自己的 GitHub

```bash
# 方法 A: GitHub web 上 fork
# 方法 B: 本地 init
cd us-housing-daily
git remote set-url origin git@github.com:<你的用户名>/us-housing-daily.git
git push -u origin main
```

### 2. 在 GitHub repo Settings → Secrets and variables → Actions 添加 secret

| Name | Value | 必需？ |
| --- | --- | --- |
| `LLM_API_KEY` | 你的 API key（如 `sk-xxx...`） | ✅ |
| `LLM_ENDPOINT` | OpenAI 兼容 chat-completions URL | ✅ |
| `LLM_MODEL` | 模型名 | ✅ |
| `SEC_CONTACT_EMAIL` | 你的邮箱（SEC EDGAR 公平使用要求） | 可选，不填用占位 |

> ⚠️ API key 永远不要直接 commit 到代码里。`.env` 已 gitignore；GitHub Secrets 加密存储，只在 Action 运行时作为环境变量注入。

### 3. 触发首次构建

GitHub repo → Actions tab → "Daily News Build" → Run workflow（手动触发）。约 30-90 秒跑完，会 commit `data/latest.json` 和 `data/YYYY-MM-DD.json` 到 main 分支。

### 4. 连 Vercel

[vercel.com/new](https://vercel.com/new) → Import Git Repository → 选这个 repo → Deploy。Vercel 自动检测 `vercel.json`，把 `public/` 当静态站托管。约 30 秒部署完成。

### 5. cron 自动跑

每天 UTC 00:57（北京 08:57）GitHub Action 自动跑一次，commit 新的 `data/2026-MM-DD.json`，Vercel 监听 main 分支变化自动重新部署，约北京 09:00 页面更新。窗口是绝对边界 `[昨天 08:57, 今天 08:57)`，跨日不重不漏。

---

## 本地开发

```bash
# 不调 LLM（验证抓取链路）
LLM_SKIP=1 node scripts/build.mjs

# 完整 pipeline
npm run build       # 读 .env

# 本地预览前端（自动 ln -s data → public/data）
npm run preview     # http://localhost:8080
```

---

## API 接口（静态文件）

| Path | 说明 |
| --- | --- |
| `/` | 前端 dashboard（中英双语切换） |
| `/data/latest.json` | 最新一期 |
| `/data/YYYY-MM-DD.json` | 指定日期 |
| `/data/dates.json` | 日期索引（最近 90 天） |

---

## 调权重 / 改分类（不需要重新部署）

打分 / 分类 / 配额都在 `scripts/build.mjs` 里：

- 信源权重：`config/sources.json` 每条 source 的 `weight` 字段（1-10）
- 时效加分：`scoreItem()` 函数里 `ageH < 6 → +6 / 24 → +4 / 48 → +2`
- 关键词权重：`HOT_CORE` / `HOT_REGIONAL` / `HOT_MACRO` / `HOT_INST` / `HOT_TREND` 数组的乘数
- Section 配额 / 扩窗策略：`SECTIONS` 数组的 `quota` / `extendedWindow` 字段
- 分类规则：`classify()` / `RE_RES` / `RE_SUNBELT` / `RE_NON_HOUSING_MARKET` / `RE_MULTIFAMILY_ASSET` 等正则
- LLM prompt：`summarizeBatch()` 函数里的 prompt 字符串

改完 push，下一轮 cron 自动生效。

---

## 成本

| 项 | 月成本 |
| --- | --- |
| GitHub Actions | $0（免费层 2000 分钟，我们用 ~5 分钟/月） |
| Vercel hobby | $0（免费层完全够） |
| LLM API | 取决于服务，gpt-4o-mini / Haiku / Kimi 约 $0.5–1/月 |
| **总计** | **< $1/月** |

---

## 常见问题

**Q: 第一次 push 后 Action 没自动跑？**
A: 检查 Actions tab。如果 disabled，点 "I understand my workflows, go ahead and enable them"。

**Q: Vercel 部署后页面空白？**
A: 看 Vercel build log。`vercel.json` 里 `outputDirectory: "public"`，确认 public/ 下有 index.html。

**Q: 数据没更新？**
A: 检查 main 分支是否有新 commit（"chore: daily build for ..."）。如果没有，看 Actions tab 上一次 run 的 log。常见问题：LLM_API_KEY 未配置 / endpoint 错误。

**Q: 如何换 LLM 服务？**
A: 改三个 GitHub secret：`LLM_API_KEY` / `LLM_ENDPOINT` / `LLM_MODEL`。任何 OpenAI 兼容协议都可以。

**Q: 跨日去重的 seen.json 太大怎么办？**
A: pipeline 内自动 prune > 21 天的条目（实测每条 ~150B，21 天 × 20 条 = ~60KB）。

**Q: GitHub Action 跑失败因为反爬 / 信源 down？**
A: 单源失败不影响整体（pipeline 容错）。`alternates[]` 兜底机制覆盖大多数 Cloudflare/Substack IP 拦截。如果掉到 < 25/30 OK 看 Actions log 找原因。

**Q: 可以加非美国住宅地产的源吗？**
A: 可以。复制 `config/sources.json` 改成自己关心的领域，调 `SECTIONS` / `classify()` / 关键词正则即可——本质是个通用的 RSS-to-LLM 聚合管道。

---

## 后续可扩展

- **邮件 / Telegram 推送**：在 build.mjs 末尾加 SendGrid / Telegram bot 调用
- **Twitter/X 信号源**：加 RSS bridge URL 到 sources.json
- **NAR 月度数据自动抓**：每月特定日期触发额外 workflow 抓 NAR PDF
- **个性化权重学习**：前端记录用户点击的 item，回流到 sources weight
- **多视角**：复制 sources.json 为不同视角（institutional / consumer / international）

---

## License

[Apache 2.0](LICENSE) — 自由使用、修改、再分发，含专利授权保护。
