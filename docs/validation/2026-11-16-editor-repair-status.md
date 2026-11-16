# 2026-11-16 Editor 失败机制修复与上线验收记录

- 验收时间：2026-11-16 11:46（北京时间）
- 发布基线：`origin/main`（`053d358` -> `3b7346a` -> `c9ed058`）
- 当前结论：**代码修复、CI（389 / 389）及 Vercel 代码部署均已完成并验证通过；但今日（`2026-11-16`）线上日报生成与发布被外部 LLM 网关（`aineapi.com`）Cloudflare `HTTP 522` 持续中断阻塞，线上站点仍停留在 `2026-11-13` 。**

## 一、今日早间失败根因回溯

1. **自动首跑 `43764655343`（`2026-11-15T21:36:51Z`，`repository_dispatch`）**：
   - `prepared` 成功（66 / 77 源站成功，4 个必选源成功，60 / 72 候选入库并冻结 `2026-11-16/r1`）。
   - `editor` 用尽 3 次阶段请求后失败：
     - 第 1 次（`150.2s`）：第 7 条把 `recent_coverage` 历史 16 位 ID（`"4ab6bbff7303f67f"`）填入 `duplicate_of`，触发 `Invalid duplicate reference` 异常；`createDecisionRepair()` 因 `validateDecisionReferences()` 直接抛出 `LlmError` 而返回 `null`，退化为 60 条全量重跑（`66,301` prompt tokens）。
     - 第 2 次（`109.8s`）：第 7 条修复，但 `3, 19, 25, 32, 46, 47, 52, 60` 共 8 条语义／证据失败（首错停在第 3 条 `geo: "national"` + `market_role: "asset_location"` + `geo_evidence: null`）。
     - 第 3 次（`25.1s` 局部修复）：修复其中 5 条，仍余 3 条失败（首错停在第 3 条：`market_evidence_id` 改填 `"body-2"` 但 `geo_evidence: "across the U.S."` 来自 `title`；第 32 条改了 `primary_event` 但未同步更新 `market_role`；第 52 条 `"101 Crawfords Corner Rd. in Holmdel, NJ."` 在 `"Rd."` 处被误拆句）。
2. **迟到定时运行 `43784252396`（`00:17` UTC cron，`09:06:14` CST）**：恢复 `r1` 账本后因同一阶段已满 3 次请求直接退出（`FATAL: Error: Issue stage request budget exhausted: editor`）。

## 二、机制修复与提交记录

### 1. 第一批机制修复：`3b7346a`（Codex `sol-high` 实施，验收通过）

- **历史台账 ID 隔离**（`scripts/lib/pipeline.mjs`）：`editor` 系统提示只投影 `recent_coverage` 可读字段（`date` / `title` / `published_at` / `summary_zh` / `report_key` / `report_evidence`），剥离内部 16 位 `id`。
- **身份与去重边分层 + 联合局部修复**（`scripts/lib/editorial.mjs`）：拆分 `validateDecisionIdentities()` 与 `duplicateReferenceProblems()`；当 `duplicate_of` 指针越界或图约束失败而身份完整时，由 `createDecisionRepair()` 与语义／证据问题同批局部修复，并保留防越权校验（禁止未知引用改 `null` 后直接 `keep: true` 放行，纯语义错误禁止修改 `keep` / `importance` / `capital_focus` / `duplicate_of` / `reason`）。
- **关联诊断与缩写保护拆句 v2**（`scripts/lib/editor-evidence.mjs`、`scripts/lib/daily-edition.mjs`、`scripts/lib/issue-contract.mjs`）：升级 `EDITORIAL_PROTOCOL` 为 `evidence-refs-v2`，保留 `evidence-refs-v1` 兼容；基于 `Intl.Segmenter` 与常见地址／机构缩写合并拆句；报错补充 `related_fields` 与 `matching_evidence_ids`，提示明确 `national + asset_location` 仍须提供短锚。
- **验证**：本地隔离工作区与主工作区 `npm test` 均 388 / 388 通过；GitHub Actions `Validate Pipeline` run `43792122552`（Node.js v22.23.4）388 / 388 通过；Vercel 部署 `success`（`4LhvX1jZ8ut65LwvmPauGXZmDaV8`）。

### 2. 首轮生产试跑暴露问题与第二批修复：`c9ed058`

- **生产试跑 `43792530578`（`daily.yml -f force=true`，revision `43792530578002`）**：
  - `prepared` 正常冻结 60 条（`evidence-refs-v2`）。
  - `editor` Attempt 1 遭遇上游流报错（`upstream_error`，`100.5s`）；Attempt 2 因 `editorInstructions()` 在 `evidenceRefs` 模式下仍展示旧版 JSON 示例（缺少新字段名，且 `"geo_evidence"` 排在前面），模型逐条幻觉输出额外 `"title"` 与 `"evidence_refs"` 键，输出膨胀至 `17,914` 字符（至第 53 / 60 条）后在 `240s` 触发 `LLM total timeout`；Attempt 3 在 `106.4s` 返回完整 JSON（`45,592` prompt tokens，`5,571` completion tokens），**历史台账 ID 与 `Rd.` 拆句均为 0 报错**，但有 8 条需修复（`4, 25, 28, 29, 31, 44, 45` 为 `geo_evidence` 与 `market_evidence_id` 跨句错配，其中 4 条本可填 `geo_evidence: null`；第 32 条将 mobile home 自创为 `asset: "manufactured-housing"`），因前两次网络失败已耗尽 3 次阶段预算，未能进入 `createDecisionRepair()`。
- **针对性修复 `c9ed058`**：
  - `scripts/lib/editorial.mjs`：为 `evidenceRefs` 模式替换专用 JSON 示例，将 `primary_event` / `event_evidence_id` / `market_scope` / `market_evidence_id` / `market_role` 置于 `geo_evidence` 之前，明令禁止输出 `title` / `evidence_refs` / `capital_focus` / `tags` 键；明确 `national` + `market_policy` / `capital_subject` 优先 `geo_evidence: null`，其他情形严格从所选同一 `market_evidence_id` 原句逐字复制；禁止自创标签名（`manufactured housing` / `mobile home` 归入 `housing`）。
  - `config/tags.json`：`housing` 适用说明补充 `manufactured housing / mobile home`。
  - `scripts/lib/editor-evidence.mjs`：`evidence-refs-v2` 补充月份与头衔缩写（`Jan`–`Dec`、`Rep`/`Reps`/`Sen`/`Sens`/`Gov`/`Mr`/`Mrs`/`Ms`）防止 `Nov. 11.` / `Reps. Maxwell` 等被误拆句；对今日 60 条冻结样本复测，共干净合并 11 条的日期／人名断句，无回退。
  - `scripts/test/editor-repair-v2.test.mjs`：新增测试覆盖新提示字段顺序、禁用字段规则及日期／人名缩写不误拆。

## 三、验证与当前阻塞状态

1. **离线回归与 CI**：
   - 本地隔离发布区与主工作区 `npm test` 均 **389 / 389 通过**（0 失败 / 0 跳过）。
   - GitHub Actions `Validate Pipeline` run `43798958623`（commit `c9ed0582e31551862a4b83ebe491d597f2b4e8fb`，Node.js v22.23.4）**389 / 389 通过**。
   - Vercel 部署 `c9ed058` 状态 `success`（`https://vercel.com/freza00s-projects/news-agent/CtcSaDSkjzKG2gNTPzZBZygHjrWz`）。
2. **线上重跑阻塞（外部网关故障）**：
   - 触发 `daily.yml -f force=true`（run `43799056363`，revision `43799056363002`）后，`Validate pipeline` 与 `Freeze issue input` 正常完成，但 `Select frozen issue` 连续 3 次请求均在 ~`19.8s` 收到上游网关错误：**Cloudflare `HTTP 522: Connection timed out` on `aineapi.com`**。
   - 本机独立探测 `https://aineapi.com/v1/models` 也连续超时 / 返回 `HTTP 522`（`11:42` CST `12.0s` 超时、`11:45` CST `HTTP 522 / 20.1s`），确认是 `aineapi.com` 源站服务中断所致，非本仓库逻辑问题。
3. **未验证范围与下一步**：
   - `c9ed058` 的真实全链路 LLM 一次通过率、今日（`2026-11-16`）日报生成与 `https://news-agent-mu.vercel.app/` 线上新刊数据／页面渲染均尚未完成验证。
   - 待 `aineapi.com` 恢复（或切换 GitHub Actions Secrets `LLM_ENDPOINT` / `LLM_API_KEY`）后，执行 `gh workflow run daily.yml -R Freza00/us-housing-daily -f force=true` 即可按新规则重新冻结生成并发布今日日报。
