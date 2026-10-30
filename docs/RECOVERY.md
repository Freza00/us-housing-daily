# 固定版本恢复与交付核验

恢复先判断本期是否已有合格归档或 ready 候选，再补未完成阶段。来源覆盖不完整仍可是一份合格刊物；普通补偿不为 degraded 反复重新选稿。自动执行沿用北京时间日历守卫；保留已有显式 FORCE_RUN 工作日手动接口，指定 revision 时不丢失该许可，周末始终退出。不启用周月自动跨日补刊，不用历史 PUBLISH_NOW 绕过发布日历。

## 阶段事实源

`state/issues/<kind>/<period>/r<revision>/` 保存 `manifest.json`、`prepared.json`、`editor.json`、`cards.json`、`metadata.json`、`ready.json`。prepared 冻结实际证据、稳定 ID、原始采集增量和前置版本；cards 只保存通过逐稿校验的卡片，metadata 绑定完整入选集合；ready 包含完整合格刊物和发布所需增量。

manifest 记录身份、规则及模型指纹、阶段散列和逐次调用账本。普通重试固定 revision；FORCE_RUN=1 且未指定 ISSUE_REVISION 时才创建新修订。GitHub 新修订号结合 run ID／attempt 分配，允许非连续增长，防止上次附件全部丢失后误用旧号。指定 revision 始终恢复该版，不重置其额度；该版附件缺失、过期或规则不兼容时明确失败，不自动换号，有效同版本地阶段／已刊归档可继续使用。

两阶段各最多 3 次请求，合计模型耗时预算 660 秒。局部纠正与传输重试共用该预算；账本中的未结束请求按预留时长计算。附件缺失或较新的运行已开始模型阶段却没有最终账本时，相关阶段标记 budget_unknown，禁止新请求；已验证缓存和 ready 仍能使用。不要清空 manifest 绕过上限。

阶段附件和交付收据忽略 Git。Actions cache 只加速；恢复下载须通过仓库、分支、工作流、期号、截止点、规则、模型和散列检查。只接收当前仓库 main 的 schedule／workflow_dispatch／repository_dispatch 产物，拒绝 PR 或外部仓库附件。附件过期／损坏须报告，不静默更换网页证据。

## 执行阶段

以下命令展示当前工作日期的操作接口。生成使用已有环境配置；发布 `--push`、工作流 dispatch 和 redeploy 均会改变外部状态，执行须已有对应授权。本轮仅完成代码与离线测试，没有执行这些外部写入。

```bash
# 用既有密钥环境，顺序执行；同版后续阶段不重新补文或选稿。
PIPELINE_UNTIL=prepared node --env-file=.env scripts/build.mjs
PIPELINE_UNTIL=editor node --env-file=.env scripts/build.mjs
PIPELINE_UNTIL=ready node --env-file=.env scripts/build.mjs

# ready 包已存在时不需要模型凭据；无 --push 只核验生产。
node scripts/publish.mjs daily
node scripts/publish.mjs daily --push

# 只读：当前期生产内容及 GitHub 执行状态；不 dispatch、不通知。
node scripts/check-publication.mjs daily
```

周／月生成入口为 `build-weekly.mjs`／`build-monthly.mjs`，恢复、发布、观察入口的 kind 参数改为 weekly／monthly。NEWS_STATE_DIR 可选择独立恢复状态目录；测试、dry-run 或历史时间仍必须使用隔离 data/state。固定版本命令可同时设置 `ISSUE_REVISION`、`EXPECTED_PERIOD`、`EXPECTED_CUTOFF`，期号或截止点不再匹配当前日历时立即停止。

GitHub 工作流先调用 `restore-issue.mjs <kind>`，用 `GH_TOKEN` 读取附件。手动输入 revision 留空选最新，period 为 YYYY-MM-DD（日报／周报）或 YYYY-MM（月报），cutoff 为 epoch 毫秒。后续步骤传递 prepared 输出的身份，防止排队跨日后变成另一刊。恢复需要 contents:write 和 actions:read；Git 推送采用仅在子进程存在的认证头，不把 token 放到命令参数或候选包。

## 发布失败的处理

| 观察到的状态 | 恢复行为 |
| --- | --- |
| 编辑通过、写稿失败 | 原证据和决策不变，只补写作缺口。 |
| 卡片通过、摘要失败 | 只修摘要／主线，保留合格卡片；全部 selected 仍须通过最终校验。 |
| ready 已就绪、推送失败 | 只恢复发布，不触发模型；远端无关变更最多刷新重试一次。 |
| 推送响应丢失 | fetch 并确认目标提交是否已在 main，避免再次发布。 |
| 归档已有、latest／索引／首页缺失 | 由同一归档修复派生文件，不重新生成。 |
| 新一期或更高 revision 已发布 | 拒绝旧候选覆盖；共享水位不倒退，新补采材料不删除。 |
| 仓库已更新、生产仍旧／超时 | 返回交付失败并保存收据；可再次只核验，已有配置和授权时可单独 redeploy。 |

交付必须同时匹配生产 latest、本期归档、日期索引，日报再核对首页 initial-data。收据记录内容散列、目标提交、核验时间及逐路由结果，不回写生产 JSON。相同内容重复确认不新增发布提交。

`--redeploy` 只接受配置于 VERCEL_DEPLOY_HOOK 的官方 HTTPS Deploy Hook。没有凭据时明确返回能力不可用，默认工作流不调用。此入口没有本轮真实权限或部署验收，不能据此声称已自动自愈；最终仍要求生产内容匹配候选。

## 截止观察边界

`check-publication.mjs` 区分任务未创建、排队、运行、失败、执行状态未知、任务成功但网站仍旧，以及候选可直接发布。09:00 后未核验成功记为 missed；首次观察已在截止之后，即使网站现已正确，也不会声称此前准时。月报尚无统一完成时限，返回 policy_pending。

本轮不注册外部 cron、不发送通知，也不自动 dispatch。现有 GitHub 调度整体未启动时，代码本身不会从外部唤醒；独立承载及告警启用另行落实。下一次生产工作流的阶段上传／恢复、实际 redeploy、连续 10 个工作日 09:00 SLA 都须单独验收。
