# 自动出刊缺少固定恢复进度与线上交付确认

2026-10-30 12:51，北京时间。基线为已上线源码 ca5f11f 和文档 9f1f644。用户指定 gpt-6-astra、max 推理强度进行只读审查，最终方案复审通过，无剩余阻断问题。本轮只制定方案，不修改业务源码、工作流、密钥或生产，不提交／推送，不调用 House Daily 真实模型，不使用 Computer Use。正式方案见 [实施建议](../plans/2026-10-30-automation-hardening.md)，可保留的结构化证据见 [探针与核验记录](2026-10-30-automation-hardening-review.json)。

## 已复现的恢复缺口

| 编号与影响 | 证据与具体失败路径 | 判断边界 |
| --- | --- | --- |
| F1，高：已刊期随补偿重复进入生成 | pipeline.mjs:147 将来源缺口记为 degraded；can-run.mjs:8 和 pipeline.mjs:43 只跳过 complete。离线探针连续两次处理同一期，第二次重入 editor 和 writer，即使第一版已写归档／latest。 | 已复现控制流；stub 调用次数不能当成实际模型计费，精确请求相同仍可命中缓存。 |
| F2，高：重跑改变证据并重新编辑 | pipeline.mjs:108 补文、116 覆盖当期 inputs；llm-client.mjs:34 以完整请求散列作缓存键。探针中稳定 ID 相同、来源不再重采，Alpha／Beta 补文仍使编辑缓存失配。30 号真实日志同样显示 70 个 ID 相同但一篇摘录变化。 | 离线复现并有生产证据；现有精确缓存和原料恢复有效，缺少的是冻结某期修订版本的阶段记录。 |
| F3，高：摘要失败扩大到全部卡片 | editorial.mjs:235-237 对卡片均通过、共享摘要数字错误的回答返回无局部修复；llm-client.mjs:100 仅保存完整通过的结果。3 张合格卡片因摘要中的 99 无依据，完整纠正后仍整阶段失败，只留下 failure cache。 | 已复现；不建议放宽数字或引文。需要分开保存／修复卡片与共享摘要。 |
| F4，中：完成守卫不检查基本刊物结构 | 构造空 items、complete、同 cutoff 的归档和 latest，can-run 返回 false，pipeline 直接 skipped。 | 只说明守卫条件不充分；正常生成链路已有无候选／无入选保护，未发现生产自动生成空刊。应复用既有刊物校验，不另建复杂防御系统。 |

复现脚本及输出保存在项目 `.tmp/house-daily-hardening-20261030/advisor-probes.mjs` 和 `advisor-probes-result.json`，全部请求使用离线 stub。主 Agent 已核对探针源码、断言与实际输出，不将模拟结果写成新的生产故障。

## 代码能够确认、生产发生情况尚待验证的风险

- **推送与上线之间没有自动确认。**daily.yml:69-78 到 git push 为止；当前完成守卫读取仓库 JSON，不读取生产域名。部署失败或网站仍为旧期时，缺少“只恢复发布”的路径。30 号的上线核验由本轮 Agent 手动通过 API／HTTP 完成，尚未成为日常工作流。
- **失败发布没有完整候选包恢复入口。**daily.yml 的失败附件仅保留 state 下原料／诊断，未保存待发布 data 和首页的完整候选。生成期间 main 前进可使 git push 被拒绝；这属于代码推断，并非已经取得该原因导致本次生产失败的证据。恢复需要独立候选包、远端前置检查和实际可用的 redeploy 权限；再次 push 同一提交不能代替重新部署。
- **日／周／月共享一个 pending 位置。**三种工作流均使用 news-build 且未指定 queue。GitHub 默认只保留一个 pending，新 pending 可替换旧 pending；cancel-in-progress:false 保留运行中的任务。跨类型挤掉等待任务是机制推断，尚未取得本项目已发生的取消实例；直接拆组又会引入共享 state 和 Git 写入冲突。
- **失败日志无法发现任务未启动。**daily-retry.yml 仅监听 Daily News Build 完成后的 failure 并写 warning；没有独立按北京时间和生产期刊日期检查截止结果的观察者。它也不覆盖已取消、长期排队或部署后内容不一致。
- **跨 runner 的恢复依赖缓存和事后附件。**当前失败后会保存原料和诊断，但下一次运行没有按同一期版本显式下载阶段附件。cache 逐出或输入变化后，不保证保留已完成编辑和已合格卡片。现有原始快照、逐源水位和已提交 state 是保留的底座。

## 已核对的平台约束

以下来自 2026-10-30 查询的一手文档，只说明平台机制，不证明本次每次失败都由平台导致。

- GitHub 定时事件可能延迟，高负载时可能丢弃排队事件；增加同一平台 cron 不能独立确认今天是否已交付。[官方 schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) 。
- 同一 concurrency group 默认保留一个 pending；当前官方支持 queue:max，但把所有补偿排成队列仍不能代替幂等恢复和截止时间控制。[官方并发说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) 。
- Actions cache 会因时间及容量限制被清理，适合加速，不宜作为阶段恢复唯一事实源。[官方缓存说明](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy) 。
- Vercel cron 调用失败不会自动重试；Hobby 是小时内精度，其他套餐可到分钟内。实际账号套餐、cron 注册及触发健康仍未核实，不能假定账号属于 Hobby 或承诺已满足分钟级调度。[错误处理](https://vercel.com/docs/cron-jobs/manage-cron-jobs) 、[套餐与精度](https://vercel.com/docs/cron-jobs/usage-and-pricing) 。

## 不应夸大的缓存问题

缓存保存位于发布前，YAML 没有单独豁免其失败。但 actions/cache v6 的 saveImpl 会捕获多数错误并记 warning，saveOnlyRun 正常以成功退出；“缓存服务错误通常会阻断发布”缺少依据，已从主要发现中撤下。仍可给非关键缓存／附件步骤设置有界耗时，避免占用出刊预算，同时保持失败原料的独立恢复路径。[官方 saveImpl 源码](https://github.com/actions/cache/blob/v6/src/saveImpl.ts) 。

## 状态

四项离线反例及官方平台约束已核对，Astra max 已复审最终方案并确认可定稿。主 Agent 核验 16 个运行／配置／前端文件与 56 个受保护数据／前端文件散列均未变，已发布的隔离目录仍干净。没有重新运行 179 项全套测试；本轮不改代码，现有通过记录仍以生产验收文档为准。P0 先解决已刊重建、固定版本恢复、卡片／摘要隔离、交付确认和独立截止观察；自动删稿的内容标准及外部权限作为启用条件保留。
