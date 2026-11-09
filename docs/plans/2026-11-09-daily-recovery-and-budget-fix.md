# 11 月 9 日日报恢复、截止前预算死区与引文校验修复施工清单

T1 本地恢复、T2 通用修复及 T3 两轮只读复审均已完成；当前用户明确授权分步生产上线。已先发布旧规则 r1 数据，再以该数据提交为基线提交 11 个目标文件，最后等待代码 CI／部署并独立核验生产端点及桌面、移动端渲染。主工作区非目标脏文件以起始散列保护。

2026-11-09，北京时间。用户指令「让 sol6.1-high 执行，并让 sol6.1-xh review，上线」已明确授权：由 `gpt-6.1-sol`（`high`）执行 9 号日报 `r1` 恢复与通用代码修复，由 `gpt-6.1-sol`（`xhigh`）独立只读复审，验证通过后提交、同步开源 `main` 并上线生产环境。

## 一、背景与已确认根因

1. **首跑 `42526085953`（北京 05:36:51 -- 05:42:15）**：
   - `prepared` 冻结 68 条合格候选；`editor` 第 1 次因第 38 条 `actor` 维度双标签（`developer` + `institutional`）触发 `Semantic tag dimension limit: 38`，第 2 次纠错通过并选出 20 条，冻结 `editor.json`。
   - `writer` 第 1 次（`f97f639c-605b-4fc9-9fa1-def12e69494d`）产出 20 张卡片与双语速读摘要，其中 **18 张卡片与双语 `metadata` 通过校验并落盘**；第 18 条因原文 `with October's strong jobs report` / `October's stronger-than-anticipated gain` 未被 `datedMonths` 识别为合法 10 月日期上下文而报数字 `10` 缺失；第 9 条（`091d03c6e2673f60`，*Dallas Office Market on Rise*）因模型将原文句子开头的 `Dallas’ office investment volume...` 扩写为 `Dallas-Fort Worth’s office investment volume...` 触发 `Evidence quote is not present in source for 9`。
   - `writer` 第 2 次（`299ea3df-95b2-4452-b73e-d28bc8766515`）局部补写第 9、18 条：第 18 条通过并落盘（已保存 **19 张合格卡片 + 合格 `metadata`**），但第 9 条仍保留 `Dallas-Fort Worth’s` 开头，达到单次调用内「最多契约纠错 1 次」上限退出。累计模型耗时 `model_ms = 237,026 ms`，含退避 `spentMs = 267,026 ms`（总预算 `660,000 ms`，剩余 `392,974 ms`，`writer` 仍剩第 3 次调用额度）。
2. **补偿 `42543059356`（北京 08:58:39 -- 08:59:26）**：
   - GitHub Actions 漏跑 `05:17`、`06:17`、`07:17` 三档定时任务，并将 `08:17` 延迟 41 分钟至 `08:58:39` 启动。
   - `08:59:18.463` 进入 `writer` 时，[`scripts/lib/pipeline.mjs`](../../scripts/lib/pipeline.mjs) 第 163 行在 `0 < targetDeadline - Date.now() <= 180000`（即 `08:57:00 -- 09:00:00` 截止前 3 分钟预留窗内）将 `budgetMs` 计算为 `Math.max(spentMs, targetDeadline - Date.now() - 180000 + spentMs) === spentMs`，使 [`scripts/lib/llm-client.mjs`](../../scripts/lib/llm-client.mjs) 的 `remaining = budgetMs - spentMs = 0`，0 次请求直接报 `LLM run time budget exhausted` 退出。

## 二、子任务划分与边界

### 子任务 T1：11 月 9 日 `r1` 兼容旧规则恢复与先行发布（执行：`sol6.1-high`，复审：`sol6.1-xh`）

- **目标与预期行为**：
  - 在不改动已部署规则（`20a99547d8feb4f0dfc3be80b7089326eaa2b131`，规则散列与线上 `r1` 一致）的干净检出副本中，下载并恢复 `daily/2026-11-09/r1` 最新可信阶段附件（`news-issue-daily-2026-11-09-r1-42543059356-1-writer`）及诊断附件（`news-llm-daily-42526085953-1`）。
  - 核对 `prepared`、`editor`、19 张 `cards`、`metadata` 阶段散列与第 2 次 `writer` 回答（`299ea3df-95b2-4452-b73e-d28bc8766515.response.json`，请求散列 `6ba21c165de45aa938d2a8ef5a8aef6dc5b06d7ab252ffc380f5e653efd0046e`）。
  - 将 `299ea3df` 回答中第 9 条 `evidence_quote` 开头的 `Dallas-Fort Worth’s` 精确还原为原文连续子串 `Dallas’`（保持其余字段、19 张已过卡片、双语 `metadata`、原 2 次 `editor` + 2 次 `writer` 账本、`r1` 身份及截稿点完全不变），经旧版 `validateWritingCard` 与 `validateWriting` 全量严格校验通过后写入 `cards` 并由 `runPipeline`（零新增源站与模型请求）产出 `ready.json`。
  - 先行使用兼容旧规则发布 9 号日报数据提交（`chore: 发布 daily 2026-11-09 修订 1 并保存采集状态`），避免先推代码改动触发 `Generation rules changed since candidate was prepared`。
- **验收标准**：
  - 20 条卡片、数字依据、逐字引文、双语摘要、栏目归属、来源 cap、阶段散列与冷恢复零请求验证全部通过。
  - 线上首页、`data/latest.json`、`data/2026-11-09.json`、`data/dates.json` 四路内容与候选 SHA-256 完全匹配，Vercel 部署状态为 `success`。

### 子任务 T2：通用代码修复与回归测试（执行：`sol6.1-high`，复审：`sol6.1-xh`）

- **允许修改范围**：
  - `scripts/lib/pipeline.mjs`
  - `scripts/lib/editorial.mjs`
  - `.github/workflows/daily.yml`
  - `scripts/test/` 下相关测试文件
  - `AGENTS.md`、`README.md`、`ROADMAP.md`、`docs/plans/2026-11-09-daily-recovery-and-budget-fix.md`、`docs/validation/2026-11-09-daily-recovery-and-budget-fix.md`、`docs/validation/2026-11-09-daily-recovery-and-budget-fix.json`
- **禁止修改范围**：
  - 不修改已刊历史归档数据（`2026-11-06` 及更早日报、周报、月报）、不修改模型调用次数上限（每阶段仍最多 3 次）或 11 分钟总时间预算（`660,000 ms`）、不放宽 `validateWritingCard` 要求 `evidence_quote` 必须为原文连续子串的门禁（禁止模糊匹配或跳词）。
- **已确定实现决策**：
  1. **消除截止前 3 分钟预算死区（`scripts/lib/pipeline.mjs`）**：
     - 按用户最新精确要求，仅在 `targetDeadline - Date.now() - 180000 > 0` 时按 `Math.min(660000, targetDeadline - Date.now() - 180000 + spentMs)` 为准点发布预留 3 分钟；进入预留窗（含等于边界）或迟到恢复时使用同版共享总预算 `660000`。不另设最小请求窗口阈值；`spentMs >= 660000` 仍严格报时间预算耗尽。
  2. **支持英文月份所有格与 `with/by/before/after` 日期介词（`scripts/lib/editorial.mjs`）**：
     - 在 `groundedNumbers` 的 `datedMonths` 识别中，将介词上下文扩展覆盖 `with|by|before|after|ahead of`，并支持月份所有格 `October's` / `October’s`（如 `October's strong jobs report`、`with October's ...`），同时继续排除后接大写专有名词（如 `May Capital`）的误判。
  3. **增强局部补写引文报错可诊断性（`scripts/lib/editorial.mjs`）**：
     - 在 `createWritingRepair` 构造 `corrections` 时，若错误为 `Evidence quote is not present in source`，在报错提示中附带明确指示：必须逐字复制给定 `title` 或 `evidence` 中的连续原文，不得将原文中的简称／代词展开或替换为全称（例如原文写 `Dallas’` 时不得写成 `Dallas-Fort Worth’s`）。
  4. **补齐 09:17 北京时间兜底定时触发（`.github/workflows/daily.yml`）**：
     - 在 `daily.yml` 的 `schedule` 中将 `17 0 * * 1-5` 扩展为 `17 0,1 * * 1-5`（新增 UTC `01:17` 即北京时间 `09:17` 一档兜底重试；若 `09:00` 前已成功出刊，`can-run.mjs` 会在毫秒级直接跳过，不消耗模型或源站请求）。
- **验收标准**：
  - 新增单元测试覆盖：(a) `08:57 -- 09:00` 窗口内启动恢复任务不会误报 `budget_exhausted`，且 `spentMs >= 660000` 时仍严格报 `time budget exhausted`；(b) `with October's strong jobs report` / `October's stronger-than-anticipated gain` 允许中文译为 `10 月`，而 `May Capital` 等专有名词仍不得放行数字 `5`；(c) `createWritingRepair` 对引文不匹配卡片包含逐字复制／禁止简称扩写提示，且真实 11 月 9 日第 18 条回答直接通过新版 `validateWritingCard`。
  - 全量 `npm test` 全部通过（0 失败）。

### 子任务 T3：`sol6.1-xh` 独立复审、同步开源与线上核验

- **目标**：
  - 由 `gpt-6.1-sol`（`xhigh`）对 T1 恢复产物、T2 代码补丁、新增测试及文档进行只读审查。
  - 修复审查发现的任何问题后，提交通用修复与文档至 `origin/main`，同步本地工作区 `/Users/freddiezhang/Documents/Claude/Projects/美国住宅房地产报告/news-agent` 对应文件，等待 GitHub Actions `Validate Pipeline`（Node.js 22 CI）与 Vercel 部署全部 `success`，并完成线上全入口 SHA-256 核验。


## 四、分步上线状态（2026-11-09 10:42）

2026-11-09 10:42，固定规则基线 20a99547d8feb4f0dfc3be80b7089326eaa2b131 下的 2026-11-09 r1 已先行发布，数据提交 eac3fe873ed9da3798899a51efd64f8fd0e94e3c。publish.mjs 内部 latest、当期归档、日期索引和首页四路线上核验全部通过，payload SHA-256 为 626dbb0a17a9b38841e867a0950057f3dfe4f76c6396f83d2cd91b299c9e70e0，20 卡及双语摘要与冻结候选一致；Vercel Production success。回执：/Users/freddiezhang/Documents/Claude/Projects/美国住宅房地产报告/news-agent/.tmp/daily-20261109-fix/frozen-checkout/state/delivery-receipts/daily-2026-11-09-r1.json 。未新增模型或源站采集请求。

sol6.1-xh 首轮指出 F1 姓名所有格误判月份回归；收紧姓名、指标上下文及括号机构名识别后，第二轮独立复核 129 组探针／258 次卡片与 metadata 校验全部通过，结论 approve、阻塞项 0。

O1：预留窗前仍按既定方案保留 3 分钟发布窗口，不另设最小窗口阈值；距截止 180001 ms 时可能仅余 1 ms，真实时钟推进后仍可能耗尽，不能声称所有时间点均可完成请求。O2：20／20 卡通过 validateWritingCard，其中 18／20 引文为逐字连续子串，2 张首轮保留卡通过既有规范化引文匹配，未改写或放宽门禁。

F1 文件已按复审散列同步至干净副本，主工作区及干净副本各复跑 324／324。代码提交前另在最新数据提交基线上复跑全量测试；代码推送后的 Node.js 22 CI、Vercel、11 路端点和 1440×900／390×844 浏览器结果保存在任务目录 release-summary.json，本提交时仍待执行，不以本地测试代替。
