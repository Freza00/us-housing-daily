# 2026-11-17 覆盖降级分层、诚实提示与周／月报受限 `r2` 自动补全上线验收记录

- 验收时间：2026-11-17 20:21（北京时间）
- 发布基线：`origin/main` `3860ee5`
- 架构来源：`opus5.5-high`（`opus-advisor`）评估收敛方案 + 全链路回归实测
- 当前结论：**已将日报与周／月报的 `degraded` 判定按影响层级拆解（新增 `coverage_reasons`），消除前端 `public/app.js` 失实的“补齐后可更新”提示，并为周／月报启用严格有界的单次 `r2` 快照自动补全修订及补偿调度。隔离副本、主工作区及 Node.js `v22.23.4` CI（run `44081597651`）`npm test` 均 `423 / 423` 通过（`0` 失败、`0` 跳过），Vercel Production（deployment `7852946311`）`success`，线上 `app.js` 散列逐字节匹配，Playwright 桌面／移动端中英文 `8` 场景 0 报错、0 溢出。**

## 一、问题根因核验（线上事实）

1. **日报为何长期标黄 `degraded`**：检查线上 `data/2026-11-16.json` 与 `data/2026-11-17.json`，`coverage_gaps: []`、`required_source_problems: []`、`missing_dates: []`、`sources_ok: "67/77"`；触发 `degraded` 的唯一原因是 `btr`（`2` 条 `insufficient_evidence`）与 `cre`（`1` 条 `insufficient_evidence`）在已有入选稿（`btr: 2`、`cre: 5`）的情况下，仍因漏斗 `evidence_gap: true` 使 `pipeline.mjs` 的 `sectionProblems` 判 `degraded`。
2. **`2026-11-09` 周报为何标黄且无法自动补齐**：`data/weekly/2026-11-09.json`（`revision: 44007345875002`）在周一早间生成时尚缺 `2026-11-16` 日报快照，故记录 `_diagnostics.coverage_gaps: [{ lower: 1794517200000, upper: 1794776400000 }]`；随后 `59f79bb` 补齐 `state/snapshots/2026-11-16.json` 后重算 `coverageGaps` 已归零 `[]`，但原 `can-run.mjs` 与 `pipeline.mjs` 对所有有效归档无条件跳过，导致网页上“补齐后可更新”长期成为空头承诺。

## 二、机制与规范改动（提交 `3860ee5`）

1. **先改规范，后改实现**：同步更新 `README.md`、`AGENTS.md` 和 `docs/RECOVERY.md`，明确分层 `coverage_status` 定义、前端提示诚信边界及周／月报单次 `r2` 有限窗口规则。
2. **分层 `degraded` 与 `coverage_reasons`（`scripts/lib/pipeline.mjs`）**：
   - 将 `coverageReasons` 显式区分 `snapshot_gap`、`required_source` 与 `section_lead_gap`。
   - 已有入选稿件（`section.selected > 0`）的栏目不再因个别候选正文／日期淘汰触发 `section_lead_gap`，非必需 `403` 来源亦不将全期降级为 `degraded`；相关缺口继续保留在 `_diagnostics` 与网页“来源与行业覆盖”明细。
   - 若某栏目当期 0 入选且存在 `evidence_gap` 或 `qualification_gap`，仍触发 `section_lead_gap` 标为 `degraded`。
3. **诚实的双语横幅（`public/app.js`）**：
   - 移除 `补齐后可更新`／`this issue can be updated` 失实文案。
   - 依据 `coverage_reasons`、刊期类型（`kind`）及修订号（`edition.revision`）分别提示：周／月报首版 `snapshot_gap` 明确说明“若在补齐窗口内补全快照，将自动生成第 2 版”；`r2` 修订显示“第 2 版：已补齐此前缺失的历史快照并完成重算”；`required_source`/`section_lead_gap` 与历史兼容归档如实说明已按现存材料定稿并指引查看来源覆盖记录。
4. **周／月报有界单次 `r2` 自动快照补全（`calendar.mjs` / `issue-store.mjs` / `can-run.mjs` / `restore-issue.mjs` / `pipeline.mjs` / `publish.mjs` / `publication.mjs` / `dispatch.mjs`）**：
   - 新增 `withinRecoveryWindow`、`canAttemptRecoverySchedule`、`recoverableRevision` 与 `loadWindowSnapshots`：仅当已刊有效归档 `edition.revision === 1`、`coverage_status === 'degraded'`、归档 `_diagnostics.coverage_gaps` 非空、以当前 `state/snapshots/` 与检查点重算的 `coverageGaps` 降为 `0`，且处于有限窗口（周报截稿后 `48` 小时内工作日，月报次月前 `3` 个工作日）时，批准且仅批准一次 `ISSUE_REVISION=2`。
   - `r2` 在独立 `state/issues/<kind>/<period>/r2/` 目录与独立 `660,000 ms`／`3` 次阶段预算内运行，产出 `recovered_from_revision: 1`，永不触发 `r3`，也不影响手工 `FORCE_RUN` 修订（`revision > 1`）；已刊 `daily` 永不自动回溯重改。
   - `weekly.yml` 增加周一 `18:17`、周二 `10:17`/`14:17`、周三 `10:17`（CST）补偿检查；`monthly.yml` 增加每月 `1-5` 日 `10:17` 及 `4-5` 日 `15:17`（CST）补偿检查；`vercel.json` 同步放宽 `/api/trigger-weekly`（`0 6 * * 1-2`）与 `/api/trigger-monthly`（`0 7 1-5 * *`）并通过 `dispatch.mjs` 窗口守卫。
5. **回归测试**：新增 `scripts/test/coverage-tiering.test.mjs`，更新 `daily-recovery-fix.test.mjs` 与 `frontend.test.mjs`，覆盖 `daily` 403/局部缺口保持 `complete`、0 入选降级、必需源失败降级、部分写稿 `coverage_status=complete` + `publication_status=degraded`、周 48h／月前 3 工作日与周末边界、`r1 -> r2` 全流程推仓及绝不触发 `r3`、`daily` 永不自修与 `app.js` 全部双语文案分支。

## 三、验证与生产核验结果

1. **自动化测试**：
   - 隔离仓库 `/tmp/sol-opus-20261117` `npm test`：`423 / 423` 通过（`0` 失败、`0` 跳过）。
   - 主工作区 `npm test`：`423 / 423` 通过（`0` 失败、`0` 跳过）。
   - GitHub Actions `Validate Pipeline`（run [`44081597651`](https://github.com/Freza00/us-housing-daily/actions/runs/44081597651)，`Node.js v22.23.4`）：`423 / 423` 通过（`0` 失败、`0` 跳过）。
2. **线上部署与内容核验**：
   - Vercel Production（deployment `7852946311`，preview/deployment URL [`https://news-agent-ir3c6qovy-freza00s-projects.vercel.app`](https://news-agent-ir3c6qovy-freza00s-projects.vercel.app)）：`success`。
   - `https://news-agent-mu.vercel.app/app.js` SHA-256 为 `564d32494c750649dd676908fdfbb20f7f25318e6aeaa70ff40a984e86aeefcf`，与提交 `3860ee5` 逐字节一致。
   - `node scripts/check-publication.mjs daily` 返回 `state: "online_verified"`，`receipt.ok: true`。
3. **Playwright 实站浏览器核验（`https://news-agent-mu.vercel.app/`）**：
   - Desktop（`1440 x 900`）ZH/EN 日报（`19` 卡）与周报（`20` 卡）：均正确渲染，横幅已更新为诚实历史兼容说明，无“补齐后可更新”，`overflowX: false`。
   - Mobile（`390 x 844`）ZH/EN 日报（`19` 卡）与月报（`20` 卡）：均正确渲染，`overflowX: false`；`browser_console_messages`（`all: true, level: "error"`）返回 `0` 错误、`0` 警告。
4. **工作区安全与留存边界**：
   - 仅单向同步修改的文件回主工作区；主工作区 `76` 个受保护文件（`data/`、`state/`、`public/style.css`、`public/index.html`、`.env`）与初始基线 SHA-256 `100%` 一致。
   - 本期已发表的 `2026-11-16`/`17` 日报与 `2026-11-09` 周报（手工抢修 `revision: 44007345875002`）未自动重跑覆盖；真实定时周／月报在首跑 `r1` 出现快照缺口后的自动 `r2` 线上触发待后续生产周期观察。
