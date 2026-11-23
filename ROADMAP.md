# ROADMAP

## 当前状态

2026-11-23 16:28，方案 C 已在周报补发基点 `fcd633a0944465f8eec2375095ac429c359323ef` 完成本地实施、首轮终审修复与验收。模型阶段在同一 Actions job 内继承备用路由，同版总预算 900,000 ms，job 第 21 分钟停止模型请求、上限 25 分钟。终审按四态保留结果，使用 24,000 completion tokens 与 210／270 秒首字节／总时限。周报自动 `r2` 通过 gate、恢复 CLI 和流水线的本地闭环，月报通过恢复附件与窗口边界测试。本地全量测试 435 项通过，变更尚未上线。

协调者提供的 `2026-11-16` 周报补发记录（run `45132667872`）显示，旧终审配置两次在约 148 秒收到首字节，并在 10,000 completion tokens 上限处截断。本轮已提高限额，后续真实刊物的终审耗时与完成率仍待上线验证。

2026-11-18 16:52，已将默认模型切换 `gpt-6.2-sol`（`editor`／`writer` `high` + 写后 `reviewer` `xhigh`）、日报第 1 条固定为最新美国房贷利率、速读摘要末尾 30 天重要发布与报告前瞻（`executive_summary.outlook`）及 `opus5.5-high` 12 步行动方案（`R1`--`R9`）与 `sol6.2-medium` 审计补强正式上线（代码提交 `eb01c8f`，CI `440 / 440` 通过，Vercel Production `7878222128` `success`，GitHub Actions `LLM_MODEL` Secret 已同步为 `gpt-6.2-sol`），并通过生产运行 [`44268419380`](https://github.com/Freza00/us-housing-daily/actions/runs/44268419380) 刷新发布 `2026-11-18` 日报（数据提交 `b7f30e9`，`revision: 44268419380002`，`20` 条，`complete`）：第 1 条（`items[0]`，`national` 首条）固定为最新美国 30 年期按揭利率（`7.58%`），速读摘要末尾完整展示中英双语 30 天官方发布与报告前瞻；生产实况同时验证了 `writer` 主通道超时后自动粘性切换 `backup` 单卡局修成稿、`R2` 满额成稿进入 `reviewer` 及 `reviewer` 触及 `660s` 总预算上限时的非破坏性回退保底，`https://news-agent-mu.vercel.app/` 6 路核心资源与数据 SHA-256 逐字节匹配。[上线验收](docs/validation/2026-11-18-sol62-rate-outlook-release.md)。

2026-11-18 16:05，已按 `opus5.5-high`（`claude-opus-5-5-high`）制定的 12 步行动方案完成 `R1`--`R9` 全部残留盲点闭环，并经 `sol6.2-medium`（`gpt-6.2-sol`，`reasoning_effort: "medium"`）二次复核强化 `R5` 元数据防回退护栏：
1. **利率置顶与准备期闭环（`R1`、`R6`、`R7`、`R8`）**：在 `scripts/lib/editorial.mjs` 抽出单一事实源 `isBenchmarkRateStory(item)` 统一 3 处利率识别；`pickFallbackRate` 增加 `10` 天时效封顶（`RATE_FALLBACK_MAX_AGE_MS`）且仅对基准利率稿开放 `collector.enrich` 后的补救通道，使用 `insufficientIds` 集合拦截普通稿因 `insufficient_evidence` 被拒后绕过二次门槛回流，同步清理孤儿 `fallbackRateId` 并修正 `candidatePreparation.rejected` 统计；`pipeline.mjs` 选稿后救回逻辑改为遍历全部候选逐个校验 `validateDecisions` 与 `isDailyUSStory`，并写入 `_diagnostics.rate_pin`（`{ id, method, failures }`）。
2. **单进程/跨进程一致性与终审容错闭环（`R2`、`R3`、`R4`、`R5`、`R9`）**：统一单进程与冷恢复的 `writerExhausted = !!partialEdition` 判定，避免单进程 `writer` 局部修复耗尽 `3/3` 时跳过 `reviewer` 阶段；冷恢复 `savedReview` 时完整透传 `fallback_reason`；在 `scripts/lib/release-calendar.mjs` 新增 `outlookAllowedDates`（`[-5, +35]` 天容差）与 `outlookDateMentions`，在生成期（`strictOutlookDates: true`）拦截 `outlook` 越界幻觉日期并在 `prepareReview` 局部回退至 `writer` 原 `outlook`（不改动 `validateIssue` 历史归档契约，`41` 份归档 `100%` 兼容）；在 `persistParts` 与 `assembleDailyEdition` 记录 `outlook_fallback` 诊断；抽出 `buildReviewDraft` 使 `createReviewRepair` 仅携带被拒局部条目与 `all_item_ids`，同时在校验层拦截未展示条目及未授权元数据修改。`npm test` `440 / 440` 全部通过（0 失败 / 0 跳过）。

2026-11-18 14:45，已完成日报两项新规范的文档修订、全链路实现、十维红队/第一性原理复盘，并经 `gemini-4-carbon-high`（`carbon-high`）与 `claude-opus-5-5-high`（`opus5.5-high`）双模型独立交叉审计修补全部 7 处 P0/P1 跨模块与冷恢复边界漏洞：
1. **日报第 1 条固定为最新房贷利率**：新增按揭利率日更专用源 `mnd-rates`（`Mortgage News Daily — Rate Watch`，`https://www.mortgagenewsdaily.com/rss/rates`，权重 `10`，`rate_benchmark: true`）并与 `freddie-pmms` 协同作为基准源；在 `news-core.mjs`、`sources.mjs` 与 `pipeline.mjs` 全链路透传 `rate_benchmark: true`，将 `fallbackRateId` 提升至函数顶层作用域并持久化进 `snapshot.fallback_rate_id`（防止 `ReferenceError` 及跨阶段恢复丢失），在 `collector.enrich` 后补充利率候选兜底（消除 `80` vs `160` 字符门槛断层），并在 `editor` 误判 `keep: false` 或跨栏错分（非 `national`）时以 `bindEditorialEvidence` 零额外请求自愈归一至 `national`；`assembleDailyEdition` 在预算内严格保护 `primary[0]`（同时修复 `deferred` 非首条 `importance >= 4` 下标判定，并在 3 次 `writer` 预算耗尽 `allowPartial: true` 时允许安全降级保留其余 19 张合格卡）。
2. **日报速读摘要末尾新增未来 30 天重要发布与报告前瞻 + `reviewer` 阶段容错加固**：`scripts/lib/release-calendar.mjs` 提供含美国联邦法定节假日顺延（元旦、六月节、退伍军人节、感恩节、圣诞节）、FOMC 双日议息窗口及常用统计基数（`20-City`、`10-Year`、`2-day`、`1..12` 等）的确定性 30 天官方发布日历；修复 `persistParts` 在 `outlook` 报错时自动以 `buildDefaultOutlook` 落盘保底 `savedMetadata`（避免连坐丢弃合格 `sentences`），修复 `prepareReview` 仅修订 `sentences` 时保留原 `outlook`，修复周/月报 `shortDraft` 传入短编号 `id` 生成 `evidence_id`（消除 16 位哈希 ID 泄漏），修复 `createReviewRepair` 透传 `error.message` 及 `preassembled` 跨进程识别已耗尽 `writer` 账本，并在 `reviewer`（`sol6.2-xh`）耗尽重试或超时/报错时自动回退保留已通过确定性校验的 `writer` 成果。`npm test` `429 / 429` 全部通过（0 失败 / 0 跳过）。

2026-11-18 11:07，已完成本地默认模型切换至 `sol6.2-high`（`gpt-6.2-sol`，`reasoning_effort: "high"`）与写稿后新增独立 `reviewer` 审核阶段（`sol6.2-xh`，`gpt-6.2-sol`，`reasoning_effort: "xhigh"`），并在主用通道（`LLM_ENDPOINT` + `LLM_API_KEY`）与备用通道（`LLM_BACKUP_ENDPOINT` + `LLM_BACKUP_API_KEY`）同步启用：单一 `createLlmClient` 实例支持按阶段传入 `model`／`effort`，使 `editor`（`high`）、`writer`（`high`）与 `reviewer`（`xhigh`）共享主备自动粘性切换与双密钥完整脱敏；`reviewer` 阶段在 `writer` 落盘后对全部出刊卡片、双语速读与主线执行事实、数字、机构资产 `impact` 与排版复核，仅在必要时返回局部修订并再次通过全量确定性校验（`prepareWritingCard`／`prepareWritingMetadata`／`validateWriting`），写入 `reviewer.json` 与 `ready.json`。`npm test` `425 / 425` 全部通过（0 失败 / 0 跳过）；`node --env-file=.env scripts/probe-model.mjs` 实测验证 `gpt-6.2-sol` 在 `high` 与 `xhigh` 下遇主通道 `ne.aineapi.com` 返回 `HTTP 503 model_not_found` 时自动粘性切换至备用官方端点 `api.openai.com` 并 `HTTP 200` 通过。本地未执行 `git commit`／`git push` 或线上部署，生产环境待授权提交与推送后生效。

2026-11-17 20:21，已按 `opus5.5-high` 方案上线覆盖降级分层与周／月报受限 `r2` 自动快照补全修订（`3860ee5`，CI run `44081597651` `423 / 423`、`Node.js v22.23.4`，Vercel `success`）：收紧 `daily` 的 `degraded` 触发边界（仅 `snapshot_gap`、`required_source` 或 0 入选栏目的 `section_lead_gap` 标为 `degraded`，已有入选稿栏目的漏斗缺口与非必需 `403` 来源留在 `_diagnostics` 与“来源与行业覆盖”明细）并记录 `coverage_reasons`；删除前端 `public/app.js` 失实的“补齐后可更新”提示并改为按原因／版本／历史兼容的真实说明；在 `calendar.mjs` 新增受 `withinRecoveryWindow`／`recoverableRevision` 严格封顶的周（截稿后 48h 内工作日）／月（次月前 3 个工作日）单次 `r2` 自动修订机制，配齐 `weekly.yml`/`monthly.yml`/`vercel.json`/`dispatch.mjs` 补偿调度，全链路共用于 `can-run.mjs`、`restore-issue.mjs`、`pipeline.mjs`、`publish.mjs` 与 `publication.mjs`。线上 `https://news-agent-mu.vercel.app/app.js` 散列与提交一致，Playwright 桌面/移动端 ZH/EN 日/周/月报实测 0 失实提示、0 报错、0 溢出。[上线验收](docs/validation/2026-11-17-coverage-tiering-release.md)。

2026-11-17 16:52，日报速读防丢弃修复已上线（`bedc6de`，CI `419 / 419`、Vercel `success`），并已完成 `2026-11-16` 冻结原料补刊与 `11-17` 快照边界对齐（`59f79bb`，`20` 条、`summary_status: available`）及 `daily.yml -f force=true -f use_backup=true` 刷新 `2026-11-17`（run `44048928283` / `0094946`，`19` 条、含 `18` 条 `11-16` 新闻、与 `16` 号 `0` 重叠、完整双语速读）；`node scripts/check-publication.mjs daily` 返回 `online_verified`，线上 `12` 路 SHA-256 与 Playwright 桌面/移动端双语核验全部通过。真实定时调度主通道阻塞自动切换、月报自动首跑及连续 SLA 仍待观察。[上线验收](docs/validation/2026-11-17-daily-summary-and-backfill-release.md)。

2026-11-17 13:40，主备 LLM 故障自动粘性切换与三类工作流单次手动开关（`use_backup=true`）已以 `bcf5cf4` 同步上线，Vercel 部署 `success`（`4FymeLKPXzMF2gWg5LBaxJV6b8xT`）；2026-11-09 周报已通过 `weekly.yml -f force=true -f use_backup=true` 走 OpenAI 备用端点一次通过（run `44007345875` / `630cbdf`，20 条、3 条主线），CI `408 / 408`、线上 11 路 SHA-256 及 Playwright 桌面/移动端双语渲染全部通过。[备用验收](docs/validation/2026-11-17-backup-failover-release.md)。

2026-11-12 16:20，编辑证据与覆盖机制以 683091f 同步开源并上线，Vercel success；主工作区、发布副本及 Node.js 22 CI 各 381 项通过，17 路生产资源和 39 个语言状态通过。新协议冻结前集中修字段，按主事件派生资本属性，区分选稿／写稿及正文／日期缺口。今天原 16 条、周月报和原状态保持；13 号新协议真实首跑待观察。[生产验收](docs/validation/2026-11-12-editorial-mechanism-release.md)。

2026-11-11 10:25，11 号人工 r2 的 20 条及通用改造已同步开源并上线。数据 9555175、代码 fbfaae3，Vercel success；发布副本及 Node.js 22 CI 各 340 项通过，生产 16 路内容和 39 语言状态通过。主备稿封版、美国范围、固定证据窗口、稀缺板块补文机会及冻结的近期事件台账生效。剔除英国／重复事件后 BTR 本期为 0，BTR List 原站 403 仍待解决。人工补刊保留原 1／3 账本，不记为自动准时。[生产验收](docs/validation/2026-11-11-workflow-release.md)。


11 月 10 日日报 17 条、11 月 2—9 日周报 20 条及通用修复均已同步开源并上线。数据提交 263864f／b5769c2，代码 6641efa，Vercel success；发布副本与 Node.js 22 CI 各 332 项通过，生产 15 路散列、39 语言状态核验通过。发布前纳入 11:37 迟到补偿的最新 editor 2／writer 3 账本，保留 16 好卡，只补齐失败卡。人工迟到恢复不记为自动稳定，未改调度或启用外部通知。[生产验收](docs/validation/2026-11-10-reliability-release.md)。

11 月 9 日 r1 已以 eac3fe8 发布，通用修复 f0201f1 已上线。2026-11-09 11:39，sol6.1-high 完成 `impact` 规则、20 张卡片及发布／恢复链路复审：收紧为机构资产视角、依证据判断方向与期限，删除指标到标签的机械映射；仅第 6 条（`5256d67a543953a1`）由 `short-neg` 修正为 `neutral`，归档、latest 与首页 payload 一致，r1 冻结版保持。主工作区及 origin/main 隔离副本各 325／325 已通过，已以 395091f 完成六文件提交及生产发布；CI、Vercel 和四路线上核验成功，结果见 `.tmp/daily-20261109-fix/impact-review-and-release.json`。本次无模型或源站采集请求。[此前验收](docs/validation/2026-11-09-daily-recovery-and-budget-fix.md)。

全页修复已以 5a00784 同步开源 main 并上线，Vercel success；发布副本和 Node.js 22 CI 各 298 项通过，线上 13 路资源／数据匹配。实际生产页面 15 场景／39 语言状态及 15 边界检查通过，0 页面异常／横向溢出。6 号仍为原 20 条，CFPB 原栏目保留；新分类提示仅影响未来生成。[生产验收](docs/validation/2026-11-06-page-fix-release.md)。

5 号首跑已验证候选增补生效：05:36:52 自动启动、05:41:10 完成 20 条线上四路核验；51 条初始候选、检查 72、复验后送审 57，editor 1 次／writer 2 次。后续补偿没有再次生成。英文摘要／主线泄漏和分类缺口已复现并完成本地修复，通用修复已上线，5 号仍为原稿。[运行与产品复核](docs/validation/2026-11-05-run-language-classification-review.md)。

11 月 4 日测试时钟修复及 16 条日报已同步开源并上线。修复提交 4514369，主工作区、隔离副本及 Node.js 22 CI 各 249 项通过，规则散列不变；补跑 41842020832 完成生成并由 c7ba641 推送，editor／writer 各 1 次。该任务因线上交付超时仍记 failure；随后 f98420b 单独恢复部署，Vercel success、四路线上数据与原候选完全一致，恢复未新增模型请求。自动数据提交缺少部署记录的原因仍待查，不记为准时或全程自动成功。[验收](docs/validation/2026-11-04-test-clock-implementation.md)。

11 月 3 日 17 条日报和通用修复均已同步开源 main 并上线。先以 413682d 发布旧规则恢复稿，再以 cc48955 修复数字区间／负号解析、最终排版校验和冻结卡片／摘要恢复；Node.js 22 CI 的 242 项通过，Vercel success。两次部署后的首页、latest、归档及索引均匹配候选。零新模型／源站请求，原规则、r1、账本及原工作区业务数据保持；下次自动首跑和连续准时出刊仍待观察。[发布验收](docs/validation/2026-11-03-daily-range-release.md)。

11 月 2 日完整美东周／月周期、下午错峰及固定原文日期已提交 d160c43、同步开源 main 并上线。Node.js 22 CI 的 237 项通过，Vercel success；线上新版 HTML／JS／CSS、周／月中英文固定日期与真实窗口均核验通过，七个已刊数据路由散列不变。本期周报保留原截止点和稿件，不重做新修订；北京 11 月 2 日 05:00 至 13:00 的 8 小时仅为本次周报切换未补发的过渡窗口，日报和月报仍各按自身规则收录。新周报从 11 月 9 日观察，月报下次为 12 月 1 日；未注册额外观察器或通知。[生产验收](docs/validation/2026-11-02-periodical-calendar-production.md)。

11 月 2 日周报、10 月月报均已恢复并上线，各 20 条；latest、当期归档和日期列表逐项与冻结候选一致。摘要／月份修复及来源状态去重／100 MiB 文件门禁已同步开源 main，代码合入提交 23cc0fd；Node.js 22 CI 的 225 项通过，Vercel success。实际月报输入从 188.7 MB 降到 1.0 MB，全部不同来源观测、覆盖缺口、payload／冻结附件／账本保持。本轮新增模型及源站采集请求均为 0；原工作区正式数据保持，11 月 2 日线上日报及首页资源未改变。[发布验收](docs/validation/2026-11-02-periodicals-release.md)。

11 月 2 日日报首跑失败后，同版冻结阶段与 18 张合格卡片被自动恢复，08:51:43 完成 20 条线上核验，形成首个强化后的真实恢复样本；来源 66／77 成功，HAR 超时，本期 degraded。周报此前三次摘要超长、writer 额度用尽，现已用完整句候选恢复；月报此前生成成功但输入文件过大导致推送受阻，现已修复并恢复交付。两者属于人工恢复发布，不能记为准时自动出刊。[原日志与双顾问对照](docs/validation/2026-11-02-advisor-comparison.md)。

默认模型切换为 `gpt-6.2-sol`（`editor`／`writer` 均为 `high`，`reviewer` 为 `xhigh`），主备双通道均已接入自动粘性切换。北京时间工作日日报 05:00 首跑、09:00 可读目标；周报周一 14:00 首跑、15:00 目标；月报次月首个周一至周五 15:00 首跑、16:00 目标，不另排除法定节假日。周报与月报采用完整美东自然周期，同日错峰且互不依赖对方成功；调度和外部服务仍可能使发布延后。新配置已部署接受，下一次真实 cron 执行、连续 SLA 及实际 redeploy 尚待后续验证。

P0 自动出刊强化已完成代码与本地验证：冻结版本、分阶段附件、卡片／摘要局部恢复、跨运行额度账本、独立候选发布及线上确认均已实现；隔离版和主工作区各 205 项测试通过。Astra max 最终只读复审通过，独立 79 项测试通过。已按用户授权提交 69a45a1、同步开源 main 并上线 Vercel，Node.js 22 CI 的 205 项通过，生产内容核验通过。独立外部截止调度与通知继续不启用。[生产证据](docs/validation/2026-10-30-automation-hardening-production.md)。[本地验收](docs/validation/2026-10-30-automation-hardening-implementation.md)；[施工清单](docs/plans/2026-10-30-automation-hardening-implementation.md)。

## 进行中

- 2026-11-18 16:52 默认模型 `gpt-6.2-sol`（`high` + `xhigh` `reviewer`）、日报首条房贷利率置顶与速读摘要 30 天发布前瞻已以 `eb01c8f` 上线，并以 `b7f30e9`（run `44268419380`）完成 `2026-11-18` 生产刷新与线上核验；后续工作日定时首跑下主通道稳定性及跨进程 `reviewer` 在充足剩余时间预算下的实况表现持续观察。[上线验收](docs/validation/2026-11-18-sol62-rate-outlook-release.md)。

## 待确认

- `outlook` 已通过 `outlookAllowedDates`（`[-5, +35]` 天窗口）拦截越界幻觉日期，但单句内将合法报告名与另一合法日程日期错配的残余风险（回退保底为 `buildDefaultOutlook`），待观察生产实况表现后再决定是否引入实体-日期配对级校验。

- 2026-11-17 20:21 实施并上线 `opus5.5-high` 方案（`3860ee5`）：收紧 `daily` `degraded` 触发边界并输出 `coverage_reasons`；删除 `public/app.js` 失实的“补齐后可更新”提示并区分新刊原因、周／月 `r2` 与历史兼容归档；新增 `withinRecoveryWindow`／`canAttemptRecoverySchedule`／`recoverableRevision` 与 `loadWindowSnapshots` 并在 `can-run.mjs`、`restore-issue.mjs`、`pipeline.mjs`、`publish.mjs`、`publication.mjs` 与 `dispatch.mjs` 统一执行周 48h／月前 3 工作日、仅 `r1 -> r2` 快照清零后的受限自动补全修订；扩充 `weekly.yml`/`monthly.yml`/`vercel.json` 补偿调度与 `coverage-tiering.test.mjs`。后续真实周／月 `r1 -> r2` 线上定时触发待观察。[上线验收](docs/validation/2026-11-17-coverage-tiering-release.md)。

- 2026-11-17 16:52 日报速读主选约束与预算内局修（`bedc6de`）、主备手动/自动切换（`bcf5cf4`）已上线，`2026-11-16` 经冻结原料手动补刊（`59f79bb`）、`2026-11-17` 经 `use_backup=true` 刷新（`0094946`）、`2026-11-09` 周报经 `use_backup=true` 恢复（`630cbdf`）；真实定时任务遇主通道阻塞自动切换备用的生产触发、月报自动首跑及连续 SLA 仍待后续观察（手动补刊与 `use_backup=true` 恢复均不计为全自动准时成功）。[上线验收](docs/validation/2026-11-17-daily-summary-and-backfill-release.md)。

- 6 号补发与通用地域校验修复已提交、同步开源并上线；后续自动出刊和上游流稳定性待观察。未增加模型额度或通知，人工恢复不计为自动准时成功。[生产记录](docs/validation/2026-11-06-geography-release.md)。

- 11 月 4 日 P0 修复和 16 条补发均已完成，自动数据提交未建部署记录的具体原因待查；本次人工恢复交付不能证明后续自动交付稳定。P1 工作流职责划分继续不实施。[验收](docs/validation/2026-11-04-test-clock-implementation.md)。

- 11 月 9 日周报首跑失败后已按旧规则人工恢复交付；新生成规则后续周报首跑与 12 月 1 日月报仍待观察。周报旧 8 小时过渡窗口不补发、不自动移入下一自然周。[施工与边界](docs/plans/2026-11-02-periodical-calendar-trial.md)。

- 日报真实 runner 阶段上传／恢复、同版续写与线上交付已验证一次；周／月报人工恢复发布和生产交付也已验证。实际 redeploy、连续 10 工作日 SLA 及周月报修复后的自动首跑仍待观察。外部观察器调度和通知继续不启用；12 号自动交付 16 条，编辑证据与覆盖机制的新修复已上线，后续真实首跑与连续稳定性仍待观察。
- 30 号生产原料证实 INVH 公告正文取得成功，因已在 29 号发布而按 seen 去重；AMH 本期源检查正常但无当期新稿，新的正文补抓仍待观察。本机与 runner 验证证据分别记录。[本轮证据](docs/validation/2026-10-30-publication-eligibility.md)。
- 30 号真实两阶段生成及诊断 artifact 已验证能运行，定时阶段数字校验连续失败；用户 rerun 的单卡修复成功。稳定在 09:00 前自动出刊仍未实现，不能用一次手动恢复替代稳定性验收。
- 任务内恢复无法解决平台未启动或延迟启动。10 月 29 日 05:36、09:02 及 13:52 生成均未成功发布，后续定时启动和 09:00 可读目标仍需持续观察。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-11-23 16:28 方案 C 完成同 job 备用路由、终审四态与冷恢复、模型容量与停止点、周／月报自动 `r2` 首跑及停用模块清理。首轮终审修复将非 JSON 响应归入可重试错误，终审耗尽保留合格成稿。自动 `r2` 首次分配的 run 查询向前放宽 48 小时，按 `r1` 完成时间核对模型步骤并拒绝未知账本，门禁要求显式 `coverage_status: degraded`。同步 gate、恢复 CLI 和周／月报补偿调度文档。

- 2026-11-18 16:52 以 `eb01c8f` 上线默认模型切换 `gpt-6.2-sol`（`high` + `xhigh` `reviewer`）、日报首条房贷利率置顶、速读末尾 30 天官方发布前瞻及 `R1`--`R9` 加固，同步更新 GitHub Actions `LLM_MODEL` Secret 为 `gpt-6.2-sol`，并通过 `daily.yml`（run `44268419380` -> `b7f30e9`）刷新上线 `2026-11-18` 日报（`20` 条、首条 `7.58%` 按揭利率、完整双语速读与 30 天发布前瞻）。[上线验收](docs/validation/2026-11-18-sol62-rate-outlook-release.md)。

- 2026-11-18 16:05 完成 `opus5.5-high` 12 步行动方案（`R1`--`R9`）与 `sol6.2-medium` 复核修补：在 `editorial.mjs` 抽出 `isBenchmarkRateStory` 与 `buildReviewDraft`、强化 `createReviewRepair` 局部提示与未展示条目/元数据防护、支持生成期 `strictOutlookDates` 日期窗口校验与 `prepareReview` 局部 `outlook` 回退；在 `pipeline.mjs` 实现 `pickFallbackRate` 10 天时效封顶、`insufficientIds` 防回流、多候选迭代利率救回与 `_diagnostics.rate_pin`、单进程与跨进程一致的 `writerExhausted = !!partialEdition`、冷恢复 `savedReview.fallback_reason` 保留及 `outlook_fallback` 诊断；在 `release-calendar.mjs` 新增 `outlookAllowedDates`／`outlookDateMentions`，在 `daily-edition.mjs` 记录 `outlook_fallback`，新增 11 项回归测试并更新 `AGENTS.md`、`README.md` 与 `ROADMAP.md`。

- 2026-11-18 12:15 新增日报两项编排与写作规范：在 `config/sources.json` 新增 `mnd-rates`（`Mortgage News Daily — Rate Watch`）并与 `freddie-pmms` 标记 `rate_benchmark: true`，在 `pipeline.mjs`、`editorial.mjs`、`daily-edition.mjs` 与 `issue-contract.mjs` 全链路固定日报 `items[0]` 为最新美国房贷利率（含假日后最新利率回退准入与首卡保护）；新增 `scripts/lib/release-calendar.mjs` 提供确定性 30 天美国住宅与宏观官方发布日历，在 `editorial.mjs`、`daily-edition.mjs`、`issue-contract.mjs` 与 `public/app.js` 实现日报 `executive_summary.outlook`（`{ text, text_en }`，独立 `<= 240` 中文字 / `<= 150` 英文词预算）双语生成、终审、数字核验与前端末段渲染，并同步更新 `AGENTS.md`、`README.md` 与 `docs/source-coverage.md`。

- 2026-11-18 11:07 将 `editor` 与 `writer` 阶段默认模型切换为 `gpt-6.2-sol`（`reasoning_effort: "high"`），并在 `writer` 后新增 `reviewer` 终审阶段（`gpt-6.2-sol`，`reasoning_effort: "xhigh"`）；更新 `llm-client.mjs`、`pipeline.mjs`、`editorial.mjs`、`model-references.mjs`、`issue-store.mjs`、`artifact-recovery.mjs`、`restore-issue.mjs`、`publish.mjs`、`evaluate-models.mjs`、`probe-model.mjs`、`.env`、`.env.example`、`.github/workflows/{daily,weekly,monthly}.yml` 及项目文档，使主用与备用 key 通道在三阶段均共享自动粘性切换与确定性复验。

- 2026-11-17 20:21 以 `3860ee5` 上线分层覆盖降级（`coverage_reasons`）、前端诚实 `coverageNote` 文案及周／月报单次受限 `r2` 自动快照补全修订机制，更新 `README.md`、`AGENTS.md`、`docs/RECOVERY.md` 与 `weekly.yml`/`monthly.yml`/`vercel.json` 补偿调度，保持 `daily` 不自动回溯改刊、周 48h／月前 3 工作日上限、`r2` 独立预算与 `<= r2` 硬边界。[上线验收](docs/validation/2026-11-17-coverage-tiering-release.md)。

- 2026-11-17 16:52 以 `bedc6de` 上线日报写稿池 `"reserve": true` 标记与速读摘要主选限制、预算内局修及坏卡联合修复；以 `59f79bb` 从冻结原料 `14215872914` 通过备用端点补刊 `2026-11-16`（`20` 条、`176` 字速读）并按 `materialFingerprint` 对齐 `11-17` 快照边界；再以 `daily.yml -f force=true -f use_backup=true`（run `44048928283` / `0094946`）刷新 `2026-11-17`（`19` 条、含 `18` 条 `11-16` 新闻、完整双语速读）。[上线验收](docs/validation/2026-11-17-daily-summary-and-backfill-release.md)。

- 2026-11-17 13:40 以 `bcf5cf4` 上线主通道故障自动粘性切换备用、切换前免污染 `invalidJson` 保护、双密钥完整脱敏及三类工作流单次手动 `use_backup=true` 开关，保持主 Secrets、3 次阶段额度、`660000 ms`、`reserved_ms` 与 `ruleDigest` 边界；并执行 `weekly.yml -f force=true -f use_backup=true`（run `44007345875` / `630cbdf`）一次性发布 `2026-11-09` 周报（20 条、3 条主线），CI 与 Vercel 部署均已通过。[上线验收](docs/validation/2026-11-17-backup-failover-release.md)。

- 2026-11-17 05:42 晨间自动日报（run `43961862058` / `86daed5`）通过原主通道 `aineapi.com` 自动生成并上线 `2026-11-17` 日报 r1（20 条、`evidence-refs-v2`、`editor` 2 次 + `writer` 1 次），验证 `c9ed058` 机制修复生效。[上线验收](docs/validation/2026-11-17-backup-failover-release.md)。

- 2026-11-16 11:47 以 `3b7346a` 与 `c9ed058` 提交、同步开源并部署历史台账 ID 投影隔离、去重边与语义字段联合局修、`evidence-refs-v2` 缩写保护拆句及 `evidenceRefs` 专用字段顺序示例／`manufactured housing` 标签词表指引；本地与 CI `389／389`、Vercel 代码部署均已通过，今日线上出刊待上游 `aineapi.com` 恢复。[状态记录](docs/validation/2026-11-16-editor-repair-status.md)。

- 2026-11-12 16:20 以 683091f 提交、同步开源并上线原文编号、冻结前局修、主事件分类、双目标计数和补文原因诊断；原 16 条与周月报保持，CI／Vercel／生产双语回归通过。[验收](docs/validation/2026-11-12-editorial-mechanism-release.md)。

- 2026-11-11 11:33 以 aadaef3 发布 11 号人工 r3 的 20 条，以 b1b02dc 同步开源并上线补文主体、地域证据及跨期就业快报机制修复；原 19 张好卡及账本保持。CI、Vercel 和双语生产回归通过。[验收](docs/validation/2026-11-11-review-release.md)。


- 2026-11-11 10:25 以 9555175 补发 11 号人工 r2 的 20 条，再以 fbfaae3 同步开源并上线主备稿封版、美国范围、固定原文窗口、稀缺板块补文优先与冻结事件台账。保留原账本与真实 BTR 缺口，后续自动稳定待观察。[验收](docs/validation/2026-11-11-workflow-release.md)。

- 2026-11-11 10:01 完成日报 26 条有界写稿池、主选好稿保留和同栏候补、重要稿／栏目保护的不足额封版、美国范围及固定原文窗口校验。速读按最终稿过滤，可双语缺失。旧规则与正式数据保持，待提交及发布。[验收](docs/validation/2026-11-11-daily-workflow.md)。

- 2026-11-10 12:50 以 263864f／b5769c2 补发日报 17 条及周报 20 条，再以 6641efa 同步开源并上线严格模型边界与局部恢复修复。CI 332 项通过，15 路生产内容及双语渲染匹配；最新补偿账本保持，发布无新生成请求。[验收](docs/validation/2026-11-10-reliability-release.md)。

- 2026-11-10 12:05 按 Astra-max 复审实施严格模型边界、有界语义／卡片局修、原值反馈、冷缓存与裁剪诊断修复；旧规则日报 17 条、周报 20 条 ready 通过，未提交或发布。[验收](docs/validation/2026-11-10-reliability-fix.md)。

- 2026-11-09 11:39 sol6.1-high 完成 `impact` 严格复审并修正两项问题：提示词不再将指标机械定性；永久测试不绑定会滚动的 latest／首页，改验固定归档及日报／周报／月报修复提示共用规则。20 张卡片仅修正第 6 条标签，三路内容和发布读取契约通过；旧冻结版、其他期刊与用户样式保持，正在按授权隔离提交和上线。

- 2026-11-09 10:42 9 号 r1 数据以 eac3fe8 先行发布并完成四路线上恢复验证，Vercel success；通用修复以 f0201f1 上线，完成两轮复审，F1 关闭，129 组／258 次校验通过，approve、0 阻塞。O1 保留 3 分钟预留方案且不设最小窗口；O2 为 20／20 旧契约通过、18／20 逐字子串及 2 张原保留规范化引文。[验收](docs/validation/2026-11-09-daily-recovery-and-budget-fix.md)。

- 2026-11-06 11:14 提交 5a00784、同步开源 main 并上线全页修复；CI 298 项、13 路线上资源及生产页面双语／边界回归通过。已刊稿、冻结账本及来源缺口保持，无新生成请求。[验收](docs/validation/2026-11-06-page-fix-release.md)。

- 2026-11-06 10:57 按 Astra-max 扩查方案统一页面加载身份和失败状态，英文卡片改用已验证原文节选，补齐标签／Sun Belt／北京日历及双语状态；收紧行业监管与机构资本提示，未增加模型步骤。复审通过，未提交、未部署、未改写已刊数据。[验收](docs/validation/2026-11-06-page-fix.md)。

## 最近验证

- 2026-11-23 16:28 本地 `npm test` 435 项通过，0 失败、0 跳过。新增用例覆盖周报终审三次 HTTP 200 HTML 后保留成稿、早建 run 中迟发模型步骤阻断自动 `r2`、缺失覆盖状态时拒绝自动修订。基点 210 份归档逐文件运行 `validateIssue`，前后结果逐字节一致，23 份 v2 全通过。受保护路径差异检查、`.env` SHA-256 和 `git diff --check` 均通过。16:14 的小额模型探针在主通道以 `high` 与 `xhigh` 均收到 HTTP 200 和完整 JSON。

- 2026-11-18 16:52 隔离发布区、主工作区及 GitHub Actions `Validate Pipeline` CI `npm test` 均 `440 / 440` 通过（0 失败 / 0 跳过），209 份归档文件（`v2: 22`、`v1: 187`）`validateIssue` 100% 通过；Vercel Production `7878222128`（`eb01c8f`）与生产构建 `44268419380`（`b7f30e9`）均为 `success`，实测验证 `writer` 主通道超时自动粘性切备用单卡局修及 `reviewer` 耗时触顶非破坏性回退；`https://news-agent-mu.vercel.app/` 6 路核心资源与 `2026-11-18` 数据 SHA-256 与 `b7f30e9` 逐字节一致。[上线验收](docs/validation/2026-11-18-sol62-rate-outlook-release.md)。

- 2026-11-18 16:05 执行 `opus5.5-high` 行动方案与 `sol6.2-medium`（`gpt-6.2-sol`，`effort: "medium"`）代码审计验收：`node --check` 语法检查全过；全套单元测试 `npm test` `440 / 440` 全部通过（0 失败 / 0 跳过，新增 `T1`--`T10` 覆盖多候选利率救回、10 天回退时效封顶、`insufficient_evidence` 防回流、`outlook` 越界日期拦截与 `prepareReview` 局部回退、`outlook_fallback` 诊断、单进程 `writerExhausted` 仍执行 `reviewer`、冷恢复 `savedReview.fallback_reason`、`createReviewRepair` 最小化负载与未展示条目/元数据拦截）；全量 41 份历史归档 `validateIssue` 核验保持 `v2=1/1 passed (0 failed), legacy_v1=40` 零破坏。

- 2026-11-18 12:15 单元测试套件 `npm test` `429 / 429` 全部通过（0 失败 / 0 跳过，新增日报 `items[0]` 房贷利率置顶与假日后最新利率回退准入、`assembleDailyEdition` 首卡按揭利率候补保护、30 天官方发布日历 `outlook` 独立预算与数字校验、前端 `.brief-outlook` 中英双语渲染共 4 项测试）；在线探测 `https://www.mortgagenewsdaily.com/rss/rates` 验证 `HTTP 200 text/xml` 返回日更按揭利率流且 `extractArticle` 完整提取正文与时间戳。

- 2026-11-18 11:07 单元测试套件 `npm test` `425 / 425` 全部通过（0 失败 / 0 跳过，新增 `reviewer` `xhigh` 卡片与摘要局部修订、确定性数字复验及主备自动粘性切换回归测试）；运行 `node --env-file=.env scripts/probe-model.mjs` 实测 `gpt-6.2-sol` 在 `high` 与 `xhigh` 两档推理强度下的在线兼容性：主通道 `ne.aineapi.com` 返回 `HTTP 503 model_not_found` 时自动粘性切换至备用通道 `api.openai.com` 并均以 `HTTP 200`、`finish_reason: "stop"` 返回有效 JSON。

- 2026-11-17 20:21 隔离发布区、主工作区及 Node.js v22.23.4 CI（run `44081597651`）`npm test` 均 `423 / 423` 通过（0 失败 / 0 跳过）；Vercel Deployment `7852946311` 为 `success`，线上 `/app.js`（SHA-256 `564d32494c750649dd676908fdfbb20f7f25318e6aeaa70ff40a984e86aeefcf`）与 `3860ee5` 一致，`check-publication.mjs daily` 返回 `online_verified`；Playwright Desktop（`1440x900`）ZH/EN 日／周报与 Mobile（`390x844`）ZH/EN 日／月报共 8 场景渲染均 `0` 报错、`0` 警告、`0` 横向溢出，页面已无“补齐后可更新”失实文案。主工作区 `76` 个受保护文件零改动。[上线验收](docs/validation/2026-11-17-coverage-tiering-release.md)。

- 2026-11-17 16:52 隔离发布区、主工作区及 Node.js v22.23.4 CI（run `44046859898`）`npm test` 均 `419 / 419` 通过（0 失败 / 0 跳过）；`bedc6de`、`59f79bb`（`2026-11-16` 补刊）与 `0094946`（`2026-11-17` 刷新）Vercel 部署均为 `success`；`check-publication.mjs daily` 返回 `online_verified`，线上 `12` 路资源 SHA-256 与 `origin/main` 完全一致，Playwright Desktop（`1440x900` ZH/EN）与 Mobile（`390x844` ZH）切换 `2026-11-16` / `2026-11-17` 渲染速读摘要均 `0` 报错、`0` 横向溢出。主工作区 `76` 个受保护文件零改动。[上线验收](docs/validation/2026-11-17-daily-summary-and-backfill-release.md)。

- 2026-11-17 13:40 隔离发布区、主工作区及 Node.js v22.23.4 CI（run `44007122385`）`npm test` 均 `408 / 408` 通过（0 失败 / 0 跳过）；`86daed5`（2026-11-17 日报）、`bcf5cf4`（代码）与 `630cbdf`（2026-11-09 周报）Vercel 部署均为 `success`；`check-publication.mjs daily` 返回 `online_verified`，11 路生产资源 SHA-256 与 `origin/main` 完全一致，Playwright Desktop（`1440x900` ZH/EN 日/周报）与 Mobile（`390x844` ZH 日/周报）渲染均 `0` 报错、`0` 横向溢出。自动切换生产实况触发待后续观察。[上线验收](docs/validation/2026-11-17-backup-failover-release.md)。

- 2026-11-16 11:47 隔离发布区、主工作区及 Node.js v22.23.4 CI（`43798958623`）各 389／389 通过，Vercel `c9ed058` 部署 `success` ；对 `43792530578` 冻结的 60 条实样复测 `evidence-refs-v2` 日期／头衔缩写合并干净生效（11 条无回退）。`43799056363` 与 11:42／11:45／11:47 CST 本机实测确认 `aineapi.com` 连续 Cloudflare `HTTP 522`／超时阻塞；2026-11-16 线上出刊及网页渲染尚未验证。[记录](docs/validation/2026-11-16-editor-repair-status.md)。

- 2026-11-12 16:20 主工作区、发布副本及 Node.js v22.23.4 CI 各 381／381；17 路生产散列、15 场景／39 个语言状态通过，0 页面异常／溢出；430 个非目标远端文件与原工作区 253 个保护路径保持。[证据](docs/validation/2026-11-12-editorial-mechanism-release.json)。

- 2026-11-11 11:33 主工作区、发布副本及 Node.js v22.23.4 CI 各 360／360；生产 16 路散列、15 场景／39 语言状态通过，0 页面异常／溢出。原工作区 253 个保护路径与 174 个缺失保持，零新模型请求。[证据](docs/validation/2026-11-11-review-release.json)。


- 2026-11-11 10:25 发布副本和 Node.js v22.23.4 CI 各 340／340，16 路生产散列与 39 个语言状态通过；来源四入口成功，BTR List 原站 403 单列。415 个远端非目标文件及原工作区数据／状态／样式保持。[证据](docs/validation/2026-11-11-workflow-release.json)。

- 2026-11-11 10:01 主工作区与生产 0cdcaf2 隔离副本各 337／337，真实 3 条 editor／4 条 writer 小额探针通过；本地 24 个语言状态通过。11 号原始附件两种回放得到 20 条，人工测试候补逐条标注，零生产写入；253 个保护路径及原 174 个缺失保持。[证据](docs/validation/2026-11-11-daily-workflow.json)。

- 2026-11-10 12:50 发布副本及 Node.js v22.23.4 CI 各 332／332，Vercel success；生产 15 路散列和 15 场景／39 语言状态通过，0 页面异常／溢出。409 个远端非目标文件、原工作区既有数据／缺失／样式及恢复账本保持。[证据](docs/validation/2026-11-10-reliability-release.json)。

- 2026-11-10 12:05 主工作区及干净副本各 332／332；609 原文选项全通过，8 场双语候选渲染无异常／溢出。真实协议 editor 1＋writer 3 次最终三卡通过，两次失败历史保留；日报恢复 0 请求，周报旧账本内 writer 1 次。原工作区数据、既有缺失和样式保持。[证据](docs/validation/2026-11-10-reliability-fix.json)。

- 2026-11-09 11:39 主工作区及隔离副本 `npm test` 各 325／325 通过；独立发布验收确认三路 payload 为 `6905d5ada5c03ca1633d95c4270644cd24dd6c2d665fc67acffc6ce5cefc0df4`，仅第 6 条 impact 变更；`validateIssue`、`loadCurrentCandidate` 优先读取修正归档、`runPipeline` 跳过已刊均通过。433 个非目标路径及旧 r1 内容在测试后逐项保持；线上结果待本次发布完成写入结构化记录。

- 2026-11-09 10:42 F1 复审散列核对通过；主工作区和干净副本 npm test 各 324／324。9 号 r1 latest／归档／索引／首页线上与冻结候选一致，payload 626dbb0a17a9b38841e867a0950057f3dfe4f76c6396f83d2cd91b299c9e70e0；代码提交 f0201f1 的 Node.js 22 CI 324／324、Vercel Production success，11 个线上端点及 24 个桌面／移动浏览器状态核验通过。

- 2026-11-06 11:14 发布副本及 Node.js v22.23.4 CI 各 298／298，Vercel success；13 路散列一致，生产四宽度／三刊／39 语言状态及 15 边界通过，0 页面异常／溢出。391 个远端非目标文件及原工作区 data／state 保持。[证据](docs/validation/2026-11-06-page-fix-release.json)。

- 2026-11-06 10:57 主工作区与基于生产 040df80 的干净副本各 298／298；两轮离线 Chromium 各 15 场景／39 语言状态和 15 边界通过，0 页面异常／横向溢出。真实 editor medium 单次 6 样本全过，13,071 tokens；49 个 data、13 个 state 文件保持，生产额度及环境／CI 配置未改。[结构化记录](docs/validation/2026-11-06-page-fix.json)。

- 2026-11-06 10:31 实际站点 15 场景／39 语言状态、四种宽度及归档／日历／筛选只读检查，0 页面异常、0 横向溢出，但确认六项交互与内容问题。三刊 60 条契约通过，54 链接为 42 HTTP 成功／11 访问受限／1 未核实，无 404。只审查，无代码／稿件／生成／发布变更。[记录](docs/validation/2026-11-06-whole-page-acceptance.json)。

## 已定位问题

11 月 16 日自动构建（`43764655343`／`43784252396`）因 `recent_coverage` 历史 ID 传入模型并引发 `duplicate_of` 全量重试，加之 `national + asset_location` 空短锚及 `Rd.` 拆句未通过校验而耗尽 `editor` 3 次预算；`3b7346a` 修复后试跑 `43792530578` 清零了重复引用与 `Rd.` 报错，但受上游流报错及 `240s` 超时影响未能进入局部修复，并暴露 `evidenceRefs` 提示缺新字段示例与 `manufactured housing` 词汇缺口；`c9ed058` 补齐后重跑 `43799056363` 在 `editor` 阶段遇 `aineapi.com` 连续 Cloudflare `HTTP 522` 源站超时阻塞。

10 月 29 日早间两轮均采到 57 条候选，05:40 连接中断，09:04 选稿返回未知 ID 后失败；13:52 的追加调度同样未成功发布。首轮缺少逐次调用记录，无法完整解释其 3 笔记账。29 号现已编辑恢复并上线；自动全链路及定时启动仍待验证，不能将补稿发布等同于调度已修复。

10 月 21 日起旧模型路由返回 get_channel_failed／model_not_found，重试后构建退出；采集和触发正常。[起点日志](https://github.com/Freza00/us-housing-daily/actions/runs/39526464861)。
