# 2026-11-18 默认模型切换 `gpt-6.2-sol`、写后 `xhigh` 终审、首条房贷利率置顶与 30 天发布前瞻上线验收记录

- 验收时间：2026-11-18 16:52（北京时间）
- 发布基线：`origin/main`（`e211bbb` -> `eb01c8f` -> `b7f30e9`）
- 架构与审计分工：完成日报双规范与 `gpt-6.2-sol`（`high` + `xhigh`）切换后，经 `gemini-4-carbon-high`（`carbon-high`）与 `claude-opus-5-5-high`（`opus5.5-high`）独立红队交叉审计并由 `opus5.5-high` 制定 12 步行动方案（`R1`--`R9`），再经 `sol6.2-medium`（`gpt-6.2-sol`，`effort: "medium"`）二次复核收口后上线。
- 当前结论：**代码与配置提交 `eb01c8f` 已上线（`Validate Pipeline` `440 / 440` 通过，Vercel Production `7878222128` `success`），GitHub Actions `LLM_MODEL` Secret 已同步更新为 `gpt-6.2-sol`；生产运行 `44268419380`（`12m26s` `success`）已生成并发布新版 `2026-11-18` 日报（提交 `b7f30e9`，`revision: 44268419380002`，`20` 条，`publication_status: "complete"`，`coverage_status: "complete"`），第 1 条（`items[0]`，`national` 首条）固定为最新美国 30 年期按揭利率（`7.58%`），速读摘要末尾完整输出双语 30 天官方发布与报告前瞻（`executive_summary.outlook`），线上 6 路核心资源与数据 SHA-256 逐字节匹配。**

## 一、核心上线内容（提交 `eb01c8f`）

1. **三阶段模型架构与主备自动粘性切换**：
   - `editor` 与 `writer` 默认使用 `gpt-6.2-sol`（`reasoning_effort: "high"`），写稿组装后新增 `reviewer` 阶段使用 `gpt-6.2-sol`（`reasoning_effort: "xhigh"`）。
   - 主通道（`LLM_ENDPOINT` + `LLM_API_KEY`）与备用通道（`LLM_BACKUP_ENDPOINT` + `LLM_BACKUP_API_KEY`）在三阶段均启用自动粘性切换与双密钥脱敏。
   - 统一单进程与冷恢复的 `writerExhausted = !!partialEdition` 判定，保留冷恢复 `savedReview.fallback_reason`，并抽出 `buildReviewDraft` 使 `createReviewRepair` 仅携带涉及条目与 `all_item_ids`，同时在校验层拦截未展示条目及未授权元数据修改。
2. **日报第 1 条固定为最新美国房贷利率（20 条配额内）**：
   - 新增 `mnd-rates`（`Mortgage News Daily — Rate Watch`）并与 `freddie-pmms` 协同标记 `rate_benchmark: true`，抽出单一事实源 `isBenchmarkRateStory(item)`。
   - 准备期支持 `10` 天时效封顶（`RATE_FALLBACK_MAX_AGE_MS`）的利率回退准入与 enrich 后基准利率补救，使用 `insufficientIds` 防止普通正文不足稿回流；选稿后按优先级遍历全部候选逐个校验 `validateDecisions` 与 `isDailyUSStory`，并在 `assembleDailyEdition` 首卡槽位严格保护 `primary[0]`。
3. **日报速读摘要末尾新增未来 30 天重要发布与报告前瞻（`executive_summary.outlook`）**：
   - 新增 `scripts/lib/release-calendar.mjs` 提供含美国联邦法定节假日顺延与 FOMC 双日窗口的确定性 30 天官方发布日历。
   - `executive_summary.outlook`（`{ text, text_en }`）独立计算预算（中文 `<= 240` 非空白字符、英文 `<= 150` 词），生成期启用 `strictOutlookDates` 拦截越界幻觉日期，报错时自动局部回退至 `writer` 原合格 `outlook` 或确定性 `buildDefaultOutlook` 并记录 `outlook_fallback` 诊断。

## 二、生产运行与线上核验（Run `44268419380` -> `b7f30e9`）

1. **真实生产链路（[`44268419380`](https://github.com/Freza00/us-housing-daily/actions/runs/44268419380)）**：
   - `editor`（`gpt-6.2-sol`，`effort: "high"`，`route: "primary"`）：Attempt 1 一次通过（`145.0s`，`48,197` tokens，`repairs: 0`）。
   - `writer`（`gpt-6.2-sol`，`effort: "high"`）：Attempt 1 主通道超时（`240.0s`）后自动粘性切换至 `backup`（`api.openai.com`），Attempt 2（`78.4s`）拦截 1 处未证实百分比，Attempt 3（`16.4s`，`repairs: 1`）完成单卡局修并产出完整 `fullEdition`（`20` 卡 + `3` 句速读 + `outlook`）。
   - `reviewer`（`gpt-6.2-sol`，`effort: "xhigh"`）：因单进程/跨进程一致性修复（`R2`）正常进入终审；遇主通道耗时触及同版 `660s` 总预算上限后，触发后置阶段非破坏性降级自动回退保留 `writer` 完整合格成果并记录 `fallback_reason: "LLM run time budget exhausted"`。
2. **新版 `data/2026-11-18.json` 关键指标**：
   - `items[0]`（`national` 首条）：`美国 30 年期合规按揭利率升至 7.58%` / `Mortgage rates jump to 7.58% as inflation lifts bond yields`（`HousingWire`）。
   - `executive_summary.outlook`：中英双语完整覆盖 11 月 18 日新屋开工与营建许可、19 日成屋销售、24 日 Case-Shiller 与 FHFA 房价指数、25 日新屋销售及成屋签约销售指数、12 月 4 日非农就业、12 月 9 日 FOMC 利率决议、12 月 15--17 日 NAHB / CPI / 新屋开工 / 成屋销售及每周三 MBA、每周四 Freddie Mac PMMS 调查。
3. **线上 SHA-256 核验（`https://news-agent-mu.vercel.app/`）**：
   - `/`（`9d47ada00485`）、`/app.js`（`9f734d3e2f8c`）、`/style.css`（`f562820b5f1c`）、`/data/latest.json`（`898639b2e6d2`）、`/data/2026-11-18.json`（`898639b2e6d2`）、`/data/dates.json`（`65e018f2b800`）共 6 路均返回 `HTTP 200` 且与 `origin/main`（`b7f30e9`）逐字节一致。
