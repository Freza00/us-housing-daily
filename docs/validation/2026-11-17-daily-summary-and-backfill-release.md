# 2026-11-17 日报速读防丢弃修复、11/16 补刊与 11/17 刷新上线验收记录

- 验收时间：2026-11-17 16:52（北京时间）
- 发布基线：`origin/main`（`f868579` -> `bedc6de` -> `59f79bb` -> `0094946`）
- 行动咨询与实施分工：先由 `gemini-4-carbon-high`（`carbon-planner`）形成三段式只读行动计划，交 `codex`（`sol-high`，`gpt-6.1-sol` `high`）实施代码、测试与文档改造，再经复核、离线补刊、线上重跑与全链路验收上线。
- 当前结论：**日报 `executive_summary` 引用替补 ID 被整段过滤的问题已修复上线（`bedc6de`，CI `419 / 419`、`success`）；基于昨日冻结原料（artifact `14215872914`）走 OpenAI 备用端点补刊 `2026-11-16`（`59f79bb`，`20` 条、`176` 字速读摘要）并按 `materialFingerprint` 对齐 `11-17` 快照；随后通过 `daily.yml -f force=true -f use_backup=true -f period=2026-11-17`（run `44048928283` -> `0094946`）生成 `2026-11-17` 新日报（`19` 条、含 `18` 条 `11-16` 新闻、与 `16` 号 `0` 重叠、`215` 字 / `94` 词完整双语速读），线上 `12` 路 SHA-256 与 Playwright 桌面/移动端双语切换 `11/16` 与 `11/17` 全部通过。**

## 一、问题定位（为何「16 号缺失」与「17 号显旧且无速读」）

1. **`2026-11-16` 缺档**：11 月 16 日全天 `6` 次 `daily.yml` 均失败，`data/dates.json` 从 `2026-11-13` 直接跳至 `2026-11-17`；`calendar.mjs` / `publication.mjs` 仅构建当下窗口且拒绝向早于 `latest.json` 的日期覆盖发布。
2. **`2026-11-17` 旧闻堆积**：因 `16` 号未出刊写入 `seen.json` 且未消费 `state/snapshots/2026-11-17.json` 中属 `16` 号消费边界内的原料（实测 `329` 条中含 `208` 条 `< 11-16 05:00`），晨间自动版 `86daed5` 仅含 `7` 条 `2026-11-16` 新闻，其余 `13` 条为 `11-12` 至 `11-14` 旧新闻。
3. **`2026-11-17` 速读摘要整段丢失**：下载 run `43961862058` 的 `writer` 产物确认模型实际写出 `2` 句双语速读，但均引用了 `26` 条写稿池第 `21–26` 条替补 ID，被 `daily-edition.mjs` 在筛选正选 `20` 条时因 `allIn20: false` 整段丢弃，`pipeline.mjs` 直接以 `summary_status: "unavailable"` 放行且未触发修复。

## 二、机制修复与提交上线（Commit 1：`bedc6de`）

1. **`scripts/lib/editorial.mjs`**：
   - 新增 `summaryTargets(selected, fixedEvidence)` 将写稿期 `daily` 摘要目标收敛为前 `20` 条主选；在 `writingPrompt` 对 `fixedEvidence` 池第 `21..26` 条标记 `"reserve": true`，并在 `dailyWritingSystem` 明确禁止摘要引用替补 ID。
   - `validateWritingMetadata` 对混用 `reserveIds` 抛出 `LlmError('Executive summary cannot reference reserve items ...')`；`createWritingRepair` 纯摘要修复仅发送前 `20` 条主选证据，坏卡与摘要同时报错时开放联合修复，且检测“主选全被替补顶替致摘要失去已刊引用”的情况。
2. **`scripts/lib/daily-edition.mjs` & `scripts/lib/pipeline.mjs`**：
   - `assembleDailyEdition` 新增可选参数 `requireSummary = false`；`pipeline.mjs` 在预算内调用 `assemble({ requireSummary: true })` 触发摘要局部/联合修复，并用 `if (!data?.executive_summary) return;` 放开合法修复更新 `metadata.json`。
   - 请求/时间耗尽或 `budget_unknown` 冷恢复的 `catch` / 预留窗分支继续沿用 `assemble({ allowPartial: true })`，保留无摘要好卡封版与旧归档 `validateIssue` 兼容性。
3. **测试与文档**：
   - `scripts/test/daily-edition.test.mjs` 新增替补混用局部修复、数字/英文缺失局部修复、耗尽/未知账本零请求降级、联合修复、冷恢复仅摘要修复、提示字段标记及可变归档脱钩校验；`scripts/test/hardening.test.mjs` 对齐耗尽前提语义；同步更新 `AGENTS.md`、`README.md`、`docs/RECOVERY.md`。
   - **验证**：隔离工作区与 GitHub Actions `Validate Pipeline`（run `44046859898`，`Node.js v22.23.4`）均 **`419 / 419` 通过（`0` 失败、`0` 跳过）**；Vercel 部署 `success`（`2A6uCX42WVKhb99K5Mg23xwWsZeR`）。

## 三、补刊 `2026-11-16` 与快照边界对齐（Commit 2：`59f79bb`）

1. **从冻结原料生成 `2026-11-16`**：
   - 复用 GitHub Actions artifact `14215872914`（`72h` 窗 `2026-11-13 05:00 ~ 2026-11-16 05:00 CST`，`60` 条候选、`67/77` 信源成功），以显式新修订号 `43847812056003` 在隔离目录通过 OpenAI `gpt-6.1-sol` 生成：`editor` Attempt 1（`97.7s`，指出第 `32` 条资本证据）+ Attempt 2 局修（`7.1s`、`repairs: 1`），`writer` Attempt 1 一次通过（`42.0s`、`repairs: 0`）。
   - 产出 `data/2026-11-16.json`（`20` 条、`summary_status: "available"`、`176` 中文非空白字符 / `77` 英文词、`missing_dates: []`），通过 `validateIssue` 与 `assertFreshDailyReports`。
2. **外科手术式归档与 `17` 号快照对齐**：
   - 提交白名单 `6` 文件：`data/2026-11-16.json`、`data/dates.json`、`state/seen.json`（先清除 `86daed5` 留下的重叠 `2026-11-17` 记录再写入 `16` 号 `20` 条）、`state/inputs/daily-2026-11-16.json`、`state/snapshots/2026-11-16.json`，以及按 `materialFingerprint` 剔除 `208` 条已消费旧料的 `state/snapshots/2026-11-17.json`（留存 `121` 条原料、`24h` 窗口、`coverage_status: "observed"`，`72` 条满额候选）。
   - 未改动 `data/latest.json`、`public/index.html`、`state/publication-watermark.json` 与 `state/collection-checkpoint.json` 水位。
   - **验证**：`npm test` `419 / 419` 通过，提交 `59f79bb` 的 Vercel 部署 `success`（`72zRZQDXWFTCHw2haNqdivgdTJ2e`）。

## 四、刷新 `2026-11-17` 日报与生产全链路验收（Commit 3/Run `44048928283` -> `0094946`）

1. **生产执行 `44048928283`（`daily.yml -f force=true -f use_backup=true -f period=2026-11-17`）**：
   - 耗时 `3m52s` 全程 `success`：`editor` Attempt 1（`69.0s`，`repairs: 0`）一次通过；`writer` Attempt 1（`37.9s`）拦截 `1` 处未证实数字 `9`，Attempt 2 局修（`5.4s`，`repairs: 1`）通过并发布提交 `0094946`（revision `44048928283002`）。
   - `data/2026-11-17.json` 验收指标：`items: 19`（`selection_target: 20`、`selection_count: 19`、`selection_shortfall: 1`、`writing_plan.shortfall: 0`、`sources_ok: 67/77`），其中 `18` 条为 `2026-11-16` 新闻、`1` 条为 `2026-11-13` 补采稿、与 `2026-11-16` 重叠 ID 为 `0`，`window_hours: 24`、`generated_at` 北京 `16:45:07`、`summary_status: "available"`（`215` 中文字符、`94` 英文词）、`missing_dates: []`；Vercel 部署 `success`（`DuHVGXkFC1Gxy6A84XF1e53gccrX`）。
2. **线上 12 路散列与 Playwright 渲染**：
   - `node scripts/check-publication.mjs daily` 返回 `state: "online_verified"`、`receipt.ok: true`。
   - `https://news-agent-mu.vercel.app` 全部 `12` 路资源（`/`、`app.js`、`style.css`、`/data/latest.json`、`2026-11-17.json`、`2026-11-16.json`、`dates.json` 及周/月报 `5` 路）`HTTP 200` 且与 `0094946` SHA-256 逐字节一致。
   - Playwright Desktop（`1440 x 900`）ZH/EN 与 Mobile（`390 x 844`）ZH 实测：`2026-11-17`（`19` 卡、`更新于 11/17 16:45 (北京)`、`3` 句速读含 `5` 个源站链接）与切换日期条 `一 16` / `M 16` 加载 `2026-11-16`（`20` 卡、`更新于 11/16 09:05 (北京)`、`2` 句速读含 `6` 个源站链接）均正常渲染，`scrollWidth === clientWidth`（`overflow: false`），`browser_console_messages` 返回 `0` 错误、`0` 警告。

## 五、工作区保护与边界说明

- 仅单向将源码/测试/文档同步回本地主工作区；主工作区既有 `data/`、`state/`、`public/style.css`、`public/index.html`、`.env` 共 `76` 个受保护路径与起始 SHA-256 基线 100% 一致，主工作区最终 `npm test` `419 / 419` 通过。
- 手工补刊 `2026-11-16` 与手动 `use_backup=true` 重刷 `2026-11-17` 均不计为全自动准时出刊 SLA；主备自动故障切换在真实定时阻塞下的生产触发与月报自动首跑仍持续观察。
