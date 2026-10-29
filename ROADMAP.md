# ROADMAP

## 当前状态

新版可靠性与研究覆盖改造、模型契约修复及 10 月 29 日补稿已同步开源仓库并部署至 Vercel，代码及数据版本 fcf48b8。线上模型为 gpt-6.1-sol。工作日日报 05:00；周一周报 07:00 首跑、08:00 补偿；月报维持首个周一 14:30，均为北京时间。09:00 为可读目标，仍受平台调度与外部服务影响。

10 月 29 日日报 20 条已上线，首页、latest、当日归档及日期列表均与发布候选内容一致，GitHub CI 在 Node.js 22 上通过 127 项测试。补稿复用已保存的完整模型答案，显式修正一处连续原文引文及一处摘要来源引用；保留 degraded 和覆盖缺口，未增加模型调用。本次为编辑恢复与发布验收，不代表后续自动出刊已验证。[本轮验收](docs/validation/2026-10-29-model-recovery.md)；[生产核验](docs/validation/2026-10-29-production.json)。

## 进行中

- 修复已上线；真实生成任务的诊断 artifact 与后续自动出刊仍待验证。原授权 4 次调用累计 326.783 秒，未直接产出合格期刊；当前补稿为零新增调用的显式编辑恢复，不能视为自动全链路通过。
- 任务内恢复无法解决平台未启动或延迟启动。10 月 29 日 05:36、09:02 及 13:52 生成均未成功发布，后续定时启动和 09:00 可读目标仍需持续观察。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-10-29 16:59 经用户明确授权，提交 fcf48b8 并推送 main，Vercel 部署成功。短编号映射、有界重试与诊断、拒稿规范化、金额连字符修复及 29 号 20 条补稿已上线；advisor 复验通过，保持数字与连续引文校验。65／77 源成功，degraded 和历史覆盖缺口保留。[施工与范围](docs/plans/2026-10-29-model-recovery.md)。
- 2026-10-28 23:07 发布代码 0010673，Vercel 报告部署成功；生产 HTML／JS／CSS 与隔离发布版逐项 SHA-256 一致，最新日报仍为 10 月 28 日。原工作区及无关 CSS、截图、lock 未改写。发布证据见 [生产验收](docs/validation/production-deployment.json)。
- 2026-10-28 23:00 采纳 advisor 意见：05:00 日报、07:00 周报及 08:00 补偿；周报固定北京上周一 05:00 至本周一 05:00，不等待日报模型成功。生成工作流取消 push 触发，独立只读 CI 运行离线测试。
- 2026-10-28 22:37 完成逐源水位、原料指纹恢复、补采标记、周月补查原料持久化；配置 77 个入口（含 46 个研究入口），采用 medium 编辑／low 写作和约 180 字速读摘要。实现及限制见 [详细验收](docs/validation/2026-10-28-morning-deadline.md)。
- 2026-10-28 17:48 将线上及本地模型恢复为 gpt-6.1-sol，补跑日报成功，用户确认 10 月 28 日显示。[运行日志](https://github.com/Freza00/us-housing-daily/actions/runs/40666081378)。

## 最近验证

- 2026-10-29 16:59 生产首页、latest、29 号 JSON 及日期索引均返回 HTTP 200，SHA-256 与候选逐项一致，日期为 2026-10-29、20 条。[Node.js 22 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40845600776) 127 项通过、0 失败；[Vercel 部署](https://vercel.com/freza00s-projects/news-agent/ChAbePwZpDBsK8fkG9RhpEzJaeUe) 成功。本地 127 项、5 个 YAML、脚本语法及 diff 检查通过，完整补稿与 advisor 复验通过；固定截止点和 14 条截稿后 pending 保留，根工作区 59 个正式文件及无关资源未改。[结构化证据](docs/validation/2026-10-29-production.json)。
- 2026-10-28 23:07 [生产 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40712118581) 在 Node.js 22.23.3 完成 103 项测试，0 失败；生产静态文件和最新数据内容比对通过，周报接口无授权请求返回预期 401，未触发生成。Vercel 部署 [J4XSdDEF2RJ5QyNUZi4fY5EBTqzG](https://vercel.com/freza00s-projects/news-agent/J4XSdDEF2RJ5QyNUZi4fY5EBTqzG) 成功。
- 2026-10-28 23:00 隔离发布版 34 个脚本语法、5 个工作流 YAML 与 Git diff --check 通过；59 个原工作区受保护文件未变，发布目录保留远端 data／state 与首页内嵌数据。
- 2026-10-28 22:39 advisor 复验日报 9 条原料恢复及周月补查保留路径通过。此前 4 组真实模型对照和 31／46 研究入口可读保留为历史证据。

## 已定位问题

10 月 29 日早间两轮均采到 57 条候选，05:40 连接中断，09:04 选稿返回未知 ID 后失败；13:52 的追加调度同样未成功发布。首轮缺少逐次调用记录，无法完整解释其 3 笔记账。29 号现已编辑恢复并上线；自动全链路及定时启动仍待验证，不能将补稿发布等同于调度已修复。

10 月 21 日起旧模型路由返回 get_channel_failed／model_not_found，重试后构建退出；采集和触发正常。[起点日志](https://github.com/Freza00/us-housing-daily/actions/runs/39526464861)。
