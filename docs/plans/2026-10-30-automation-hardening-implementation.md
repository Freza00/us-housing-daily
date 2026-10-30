# P0 自动出刊强化施工

2026-10-30 16:00，北京时间。用户“开干”授权实施已审查方案，并明确选择“先完成代码和测试，暂不启用外部调度与通知”。本轮不提交／推送／部署，不改真实环境或密钥，不调用付费生成，不使用 Computer Use。自动少稿及新的跨日发布政策不在实施范围。

## 施工范围与约定

在 `.tmp/house-daily-hardening-implementation-20261030/release-candidate/` 从 9f1f644 隔离施工，主 Agent 负责全部代码与测试，根工作区只同步直接相关源码／文档，保护其他改动和正式 data/state/public 数据。

1. 共用 issue 契约校验，合法 complete／degraded 同期归档均能复用，缺少结构或归档不一致不得静默跳过。
2. 每期身份为 kind／period_key／cutoff_upper／revision。常规重试固定 revision；force 创建新 revision。阶段文件包含 input、decisions、cards、metadata、release 和 manifest，记录内容及规则散列，使用稳定 ID。恢复只能合并采集检查点，不覆盖当前共享 state。
3. pipeline 支持 prepared／editor／ready 阶段停止；工作流在这些边界上传阶段附件。普通完整运行保留兼容入口，正常仍为编辑、写稿各一次。卡片与摘要分开保存和修复，共享原阶段调用／时间预算；不删除 selected 稿件。
4. 新增明确候选发布与线上校验命令，候选包保存刊物、固定版本和必要 state 增量。发布白名单排除阶段草稿；推送响应丢失须核对远端，冲突有界处理，不强推或改写历史。线上收据独立保存。
5. 提供只读截止检查、任务状态分类及有界恢复建议／接口。用户未启用外部调度和通知，不新增对应外部配置；redeploy 仅在明确配置并获授权的执行路径调用，缺凭据报告能力不可用。

新增目录 `state/issues/` 仅放本地阶段和待发布包，由 artifact 恢复，不进 Git；操作收据也不进入生产 JSON。新脚本统一采用 ESM 和现有 Node.js／gh 能力，不增加运行依赖。

## 文件职责

- `scripts/lib/issue-contract.mjs`：身份与已刊契约；`issue-store.mjs`：原子阶段文件和散列。
- `editorial.mjs`、`llm-client.mjs`：可分别验证和修复卡片／摘要；`pipeline.mjs`：阶段协调及兼容入口。
- 独立发布、artifact 恢复和线上检查脚本：只处理明确候选，不重启生成；新增脚本不得读取或输出密钥值。
- `scripts/can-run.mjs` 与三类生成工作流：状态守卫、分阶段调用、阶段附件、明确发布列表和线上核验。仅修改任务所需部分。
- 新增测试负责四个已复现缺口，以及冷缓存恢复、规则错配、附件损坏、共享状态前进、发布失败／响应丢失、线上旧刊、重复恢复与周末守卫。

## 验收与交付

每个检查点先复现，再最小修复；运行必要相关测试，最终 npm test、脚本语法、工作流静态检查及真实 29／30 号离线回放。保护根工作区数据和无关资源，记录实际验证范围。最终请既有 Astra max advisor 只读复审实现；独立调度／通知与真实 redeploy、下一次生产生成、连续 10 工作日 SLA 均保留为未启用或待验证，不以离线测试替代。

## 实施结果

2026-10-30 17:27，北京时间：本轮授权范围内的代码与本地验收全部完成。实际阶段格式为 prepared／editor／cards／metadata／ready，见 docs/RECOVERY.md。三类工作流接入冻结、附件恢复和独立发布；固定修订缺失不换号，显式手动 force 许可与新修订分配分开，周末守卫保留。外部调度与通知按用户选择未启用，P1 自动少稿政策没有实施。

隔离版和主工作区各 205／205 测试、5 个 YAML 与 51 个 ESM 检查通过；Astra max 最终只读复审及独立 79 项通过，无剩余阻断。真实 29／30 号已有刊物恢复、月份／数字／引文反例和本地 Git 故障注入通过。97 个非目标起始文件、正式 data／state／public 未变。未提交、推送、部署或新增 House Daily 模型调用。

验收与后续生产边界见 [实施验收](../validation/2026-10-30-automation-hardening-implementation.md) 和 [结构化证据](../validation/2026-10-30-automation-hardening-implementation.json)。下一次 runner／模型／部署全链路、真实 redeploy 及连续 10 工作日 SLA 仍需单独验收。
