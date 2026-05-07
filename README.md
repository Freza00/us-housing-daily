# US Housing Daily — 美国住宅地产新闻聚合 Agent

每天北京时间 09:00 自动跑一遍：抓 27 个一手信源 → 24h 时间窗 → 实体级去重 → 跨日去重（rolling 21d）→ enrich 全文 → 5 section 配额挑选 → LLM 一次性产出 21 条中文译标 + 摘要 + ★重要性 + 利好利空。结果写成静态 JSON、提交到 git、Vercel 自动部署。

```
RSS 抓取 (27 源)
  ↓ 解析 / 评分 / 标签 (4 维度 ~28 tag)
  ↓ 24h 时间窗 + 实体级去重 + 跨日去重 (21d seen list)
  ↓ Top-30 并发抓全文 HTML → 提取 article body
  ↓ 用 enriched body 重新打分 / 重新分类 (title-only 决策)
  ↓ 5 section 配额挑选 (国住宅 5 + Sunbelt 4 + BTR 3 + CRE 5 + 机构 3)
  ↓ 德州三城保底 (后 4 个 section 至少 1 条 dfw/houston/austin)
  ↓ LLM 单次 batch (21 条) → 中文译标 + 摘要 + imp 1-5 + dir 五选一
写出 data/latest.json + data/YYYY-MM-DD.json
```

**90% 是脚本（fetch / 正则 / 算分 / 分类 / 去重）；10% 是 LLM**（单次调用产出所有摘要）。

---

## 文件结构

```
news-agent/
├── README.md                      # 本文件
├── package.json
├── vercel.json                    # Vercel 静态站配置 (cache headers + routing)
├── .github/workflows/daily.yml    # 每天 09:00 北京时间 cron
├── config/
│   └── sources.json               # 27 个 RSS 源（可编辑）
├── scripts/
│   └── build.mjs                  # 主 pipeline (GitHub Actions 调用)
├── public/                        # 静态前端 (Vercel 部署根目录)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/                          # 由 GitHub Action 写入并 commit
│   ├── latest.json
│   ├── 2026-05-07.json
│   ├── 2026-05-08.json
│   └── dates.json                 # 日期索引
├── state/                         # 跨日 seen list (commit 进 repo)
│   └── seen.json
└── src/                           # (旧 Cloudflare Worker 代码 — 不再使用，可删)
```

---

## 部署到 Vercel + GitHub Actions（约 15 分钟）

### 0. 前置

- GitHub 账号（个人免费）
- Vercel 账号（hobby 免费）
- LLM API key（Kimi / OpenAI / Anthropic 任意 OpenAI 兼容服务）

### 1. 推到 GitHub

```bash
cd news-agent

# 初始化仓库
git init
git add .
git commit -m "init"

# 创建 GitHub repo（需提前在 github.com/new 建一个空 repo）
git remote add origin git@github.com:<你的用户名>/us-housing-daily.git
git branch -M main
git push -u origin main
```

### 2. 在 GitHub repo Settings → Secrets and variables → Actions 添加 3 个 secret

| Name | Value |
| --- | --- |
| `LLM_API_KEY` | 你的 API key（如 `sk-xxx...`） |
| `LLM_ENDPOINT` | `https://xxx/v1/chat/completions`（OpenAI 兼容路径） |
| `LLM_MODEL` | 模型名（如 `Kimi-K2.6` / `moonshot-v1-128k` / `gpt-4o-mini`） |

> **注意：API key 永远不要直接 commit 到代码里**。GitHub Secrets 加密存储，只在 Action 运行时作为环境变量注入。

### 3. 触发首次构建（拿到第一份数据）

GitHub repo → Actions tab → "Daily News Build" → Run workflow（手动触发）

约 15 秒跑完，会 commit `data/latest.json` 和 `data/YYYY-MM-DD.json` 到 main 分支。

### 4. 连 Vercel

[vercel.com/new](https://vercel.com/new) → Import Git Repository → 选这个 repo → Deploy

Vercel 会自动检测 `vercel.json`，把 `public/` 目录当作静态站点托管。约 30 秒部署完成。

部署后访问 `https://<项目名>.vercel.app` 就能看到完整 dashboard。

### 5. 验证 cron

接下来每天 UTC 01:00（北京 09:00）GitHub Action 会自动跑一次，commit 新的 `data/2026-MM-DD.json`，Vercel 监听 main 分支变化自动重新部署。第二天早上打开页面就是最新内容。

---

## 本地开发

### 跑一次 pipeline（不调 LLM）

```bash
LLM_SKIP=1 node scripts/build.mjs
```

会输出到 `data/latest.json`，不调 LLM，每条的中文摘要为 `(LLM_SKIP)`。

### 跑一次完整 pipeline（含 LLM）

```bash
export LLM_API_KEY=sk-xxx
export LLM_ENDPOINT=https://xxx/v1/chat/completions
export LLM_MODEL=Kimi-K2.6
node scripts/build.mjs
```

约 15-25 秒（取决于 LLM 延迟），输出含完整中文摘要的 JSON。

### 本地预览前端

任何静态 HTTP server 即可：

```bash
cd public
python3 -m http.server 8080
# 然后在浏览器打开 http://localhost:8080
# 注意：本地 fetch /data/latest.json 会失败，因为 public/ 下没数据
# 解决：把 data/ 目录软链到 public/data
ln -s ../data data
```

---

## API 接口（静态文件）

| Path | 说明 |
| --- | --- |
| `/` | 前端 dashboard |
| `/data/latest.json` | 最新一期 |
| `/data/YYYY-MM-DD.json` | 指定日期 |
| `/data/dates.json` | 日期索引（最近 90 天） |

---

## 信源池（27 个）

| Tier | 数量 | 代表 |
| --- | --- | --- |
| A 一线媒体 | 9 | HousingWire / Inman / TRD / Bisnow / Multi-Housing News / National Mortgage News / CNBC RE / D Magazine / Houston Agent |
| B KOL & 数据 | 7 | Calculated Risk / Lance Lambert / Logan Mohtashami / Yardi Matrix / Realtor Research / Redfin News / Pretium |
| C 政策宏观 | 2 | Federal Reserve Press / Brookings |
| D 德州区域 | 1 | TRERC |
| E BTR/机构 | 8 | NRHC / PERE / Multifamily Dive / Connect CRE / REBusiness / SEC EDGAR INVH / SEC EDGAR AMH |

加 / 改 / 删信源 → 编辑 `config/sources.json` → push 到 main → Action 自动跑下一轮。

---

## 调权重（不需要重新部署）

打分 / 分类 / 配额都在 `scripts/build.mjs` 里：

- 信源权重：`config/sources.json` 每条 source 的 `weight` 字段（1-10）
- 时效加分：`scoreItem()` 函数里 `ageH < 6 → +6 / 24 → +4 / 48 → +2`
- 关键词权重：HOT_CORE / HOT_REGIONAL / HOT_MACRO / HOT_INST / HOT_TREND 数组的乘数
- Section 配额：SECTIONS 数组的 `quota` 字段
- LLM prompt：`summarizeBatch()` 函数里的 prompt 字符串

改完 push，下一轮 cron 自动生效。

---

## 成本

| 项 | 月成本 |
| --- | --- |
| GitHub Actions | $0（免费层 2000 分钟，我们用 ~5 分钟/月） |
| Vercel hobby | $0（免费层完全够） |
| LLM API | 取决于服务，Haiku/Kimi 约 $0.5–1/月 |
| **总计** | **< $1/月** |

---

## 常见问题

**Q: 第一次 push 后 Action 没自动跑？**  
A: 检查 Actions tab。如果 disabled，点 "I understand my workflows, go ahead and enable them"。

**Q: Vercel 部署后页面空白？**  
A: 看 Vercel build log 是否成功。`vercel.json` 里 `outputDirectory: "public"`，确认 public/ 下有 index.html。

**Q: 数据没更新？**  
A: 检查 GitHub repo 的 main 分支是否有新 commit（"chore: daily build for ..."）。如果没有，看 Actions tab 上一次 run 的 log。常见问题：LLM_API_KEY 未配置 / endpoint 错误。

**Q: 如何换 LLM 服务？**  
A: 改三个 GitHub secret：`LLM_API_KEY` / `LLM_ENDPOINT` / `LLM_MODEL`。任何 OpenAI 兼容协议都可以。

**Q: 跨日去重的 seen.json 太大怎么办？**  
A: pipeline 内自动 prune > 21 天的条目，文件不会无限增长（实测每条 ~150B，21 天 × 20 条 = ~60KB）。

**Q: GitHub Action 跑失败因为反爬 / 信源 down？**  
A: 单源失败不影响整体（pipeline 容错）。如果 25/27 OK 通常没问题。如果掉到 < 20 OK 看 Actions log 找原因。

---

## 后续可扩展

- **邮件 / Telegram 推送**：在 build.mjs 末尾加 SendGrid / Telegram bot 调用
- **Twitter/X 信号源**：加 RSS bridge URL 到 sources.json
- **NAR 月度数据自动抓**：每月特定日期触发额外 workflow 抓 NAR PDF
- **个性化权重学习**：前端记录用户点击的 item，回流到 sources weight
- **多用户 / 多视角**：复制 sources.json 为不同视角（institutional / consumer / international）
