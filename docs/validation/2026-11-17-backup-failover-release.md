# 2026-11-17 主备 LLM 故障切换上线、自动日报复验与周报恢复验收记录

- 验收时间：2026-11-17 13:40（北京时间）
- 发布基线：`origin/main`（`86daed5` -> `bcf5cf4` -> `630cbdf`）
- 当前结论：**`c9ed058` 已于 11 月 17 日晨间主通道自动日报（`86daed5`）验证通过；主备 LLM 故障切换与单次 `use_backup` 开关（`bcf5cf4`）已完成 CI（`408 / 408`）与 Vercel 部署；使用 OpenAI 官方备用端点通过 `weekly.yml -f force=true -f use_backup=true`（`44007345875` -> `630cbdf`）一次性生成并发布 `2026-11-09` 周报（20 条、3 条主线），线上 11 路 SHA-256 散列与 Playwright 桌面/移动端双语渲染全部通过。**

## 一、隔夜主通道恢复与 `c9ed058` 真实日报验证

1. **自动日报 `43961862058`（`2026-11-16T21:36:52Z` / `2026-11-17 05:36:52` CST，`repository_dispatch`）**：
   - 在未启用备用的情况下通过原主通道 `aineapi.com` 自动完成 `daily-build`（提交 `86daed5`，总耗时 `5m42s`）。
   - `editor` Attempt 1（`118.6s`）完成初选，Attempt 2（`14.3s`）通过 `evidence-refs-v2` 针对性局部修复；`writer` Attempt 1（`48.2s`）一次通过。
   - 生成 `data/2026-11-17.json`（`items: 20`、`editorial_protocol: "evidence-refs-v2"`、`edition.revision: 1`、`summary_status: "unavailable"`），Vercel 部署 `success`（`9xCtZtf6RWwa2C3ZJgaLFkakeZmT`）。
2. **隔夜自动周报 `43897511750`（`2026-11-16 23:32` CST）**：
   - 恢复已耗尽的 `ISSUE_REVISION: 1` 失败，周报线上仍停留在 `period_start: "2026-11-02"`、`publish_date: "2026-11-10"`。

## 二、备用端点配置、代码改造与 CI 上线

1. **非破坏性双通道凭据隔离**：
   - 保留 GitHub Secrets 与本地 `.env` 原主通道 `LLM_API_KEY`、`LLM_ENDPOINT`、`LLM_MODEL` 不变。
   - 独立新增 GitHub Secrets `LLM_BACKUP_API_KEY` 与 `LLM_BACKUP_ENDPOINT`（`https://api.openai.com/v1/chat/completions`），本地 `.env` 仅以注释行记录备用键位名。
   - 发布前使用 `scripts/probe-model.mjs` 对 OpenAI 官方端点 + `gpt-6.1-sol` 验证通过：`effort: "low"`（`3445ms`、`32` tokens）与 `effort: "medium"`（`2684ms`、`32` tokens）均返回 `HTTP 200`、`finish_reason: "stop"`、`done: true`。
2. **客户端粘性切换与三类工作流开关（提交 `bcf5cf4`）**：
   - `scripts/lib/llm-client.mjs` & `scripts/lib/pipeline.mjs`：在获得完整有效模型 JSON 前，若主通道发生网络、超时、流中断、无效 JSON 或任意非 `2xx` HTTP 错误且存在不同的完整备用配置，立即在客户端实例内粘性切换至备用通道，并确保切换时原完整 `invalidJson` 失败不会把主通道残缺响应与纠错消息污染进备用请求；已收到完整 JSON 后的语义/证据 `validation` 报错仍在原通道局部修复；备用遇永久错误立即快速失败；主备密钥均从 `LLM_API_KEY` 与 `LLM_BACKUP_API_KEY` 完整脱敏，共用原阶段 3 次及同版 `660000 ms` 账本，不绕过 `deadline`、退避预算、`reserved_ms` 与 `ruleDigest` 校验。
   - `.github/workflows/{daily,weekly,monthly}.yml`：新增默认关闭的 `workflow_dispatch` 布尔输入 `use_backup` 与门禁校验 step `Validate backup credentials`；所有触发路径均向 `editor` / `writer` 注入备用环境变量。
   - 文档同步：`AGENTS.md`、`README.md`、`docs/RECOVERY.md` 补全主备切换与手动开关边界说明。
   - 测试与上线：`scripts/test/model-recovery.test.mjs` 与 `scripts/test/daily-recovery-fix.test.mjs` 扩充回归后，两份本地工作区及 GitHub Actions `Validate Pipeline`（run `44007122385`，`Node.js v22.23.4`）均 **`408 / 408` 通过（`0` 失败、`0` 跳过）**；Vercel 部署 `success`（`4FymeLKPXzMF2gWg5LBaxJV6b8xT`）。

## 三、单次备用周报补跑与线上全链路验收

1. **周报生产运行 `44007345875`（`gh workflow run weekly.yml -f force=true -f use_backup=true`）**：
   - 执行耗时 `5m46s`，全部启用步骤通过：`Validate backup credentials`、`Validate pipeline`（`408 / 408`）、`Freeze issue input`、`Select frozen issue`、`Write and validate frozen issue`、`Publish candidate and verify production`。
   - 因 `use_backup=true` 将备用 OpenAI 端点与凭据注入本次工作流执行上下文，`editor`（`chatcmpl-El3o4g0Y2gAdkdJBGJrc5vJSYuiCs`，`93.8s`，`28,329` tokens，`repairs: 0`）与 `writer`（`chatcmpl-El3pbJT88YpfUmsRvCiVbSwOBIkt3`，`37.1s`，`20,470` tokens，`repairs: 0`）均在 **Attempt 1 一次通过**。
   - 自动提交并推送 `630cbdf`（`data/weekly/2026-11-09.json`、`data/weekly/latest.json`、`data/weekly/dates.json`、`state/collection-checkpoint.json`、`state/inputs/weekly-2026-11-09.json`），`period_start: "2026-11-09"`、`period_end: "2026-11-15"`、`publish_date: "2026-11-17"`、`items: 20`、`themes: 3`、`edition.revision: 44007345875002`；Vercel 部署 `success`（`GHjN75hcNfxhsFAJcbFiSQi81hpY`）。
2. **线上散列与发布校验**：
   - `node scripts/check-publication.mjs daily` 返回 `state: "online_verified"`、`receipt.ok: true`（`/data/latest.json`、`/data/2026-11-17.json`、`/data/dates.json`、`/` 全部通过）。
   - 对 `https://news-agent-mu.vercel.app` 11 路生产资源做逐字节 SHA-256 校验全部匹配 `origin/main`（`630cbdf`）：`/`、`app.js`、`style.css`、`/data/latest.json`、`2026-11-17.json`、`dates.json`、`/data/weekly/latest.json`、`2026-11-09.json`、`weekly/dates.json`、`/data/monthly/latest.json`、`monthly/dates.json` 均 `HTTP 200` 且 `match: true`。
3. **Playwright 浏览器渲染回归**：
   - **Desktop（`1440 x 900`）**：日报 ZH / EN 均 `20` 张卡片、`scrollWidth === clientWidth`（`1440`、`overflow: false`）；周报 ZH / EN（`#weekly`）均显示 `Wk 2026-11-09`、`Updated Nov 16, 10:08 PM (ET)` / `更新于 11/17 11:08 (北京)`、`20` 张卡片、`3` 条 `本周主线` 与带源站链接速读摘要、`overflow: false`。
   - **Mobile（`390 x 844`）**：周报 ZH（`#weekly`）与日报 ZH 均 `20` 张卡片、`scrollWidth === clientWidth`（`390`、`overflow: false`）。
   - 全程 `browser_console_messages({ all: true, level: "error" })` 返回 `Total messages: 0 (Errors: 0, Warnings: 0)`。

## 四、未验证边界与后续观察

- 本次周报验证的是 `workflow_dispatch -f use_backup=true` 的显式单次备用路径；自动调度（`schedule` / `repository_dispatch`）中“主通道发生实时阻塞并触发同实例粘性切备用”的真实生产事件，已由单元测试（含 522 / 429 / 401 / 超时 / 流错误 / `invalidJson` / 双密钥脱敏 / 预算门禁）覆盖，线上自然触发路径仍待后续实况运行继续观察。
- 手动 `-f use_backup=true` 恢复的周报不计入全自动准时 SLA；月报自动首跑与连续工作日 SLA 持续观察。
