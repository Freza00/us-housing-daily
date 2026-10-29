# ROADMAP

## 当前状态

跨板块去重、行业覆盖与 BTR 漏稿修复已按用户授权同步开源仓库并上线：修复代码及 29 号修订稿为 828c07b，前端资源版本补充为 c9be26c。日报 20 条，同次 FOMC 仅 1 条，INVH 财报已补入，6 张 CRE 分类明确。首页、latest、29 号归档、日期列表及页面实际引用的脚本均已核对；Node.js 22.23.4 CI 166 项通过、0 失败。本轮未新增模型调用，保留 degraded 与历史缺口。[修复验收](docs/validation/2026-10-29-editorial-coverage.md)；[生产核验](docs/validation/2026-10-29-editorial-production.json)；[已发布修订稿](docs/validation/2026-10-29-editorial-preview.md)。

线上模型为 gpt-6.1-sol。工作日日报 05:00；周一周报 07:00 首跑、08:00 补偿；月报维持首个周一 14:30，均为北京时间。09:00 为可读目标，仍受平台调度与外部服务影响。真实生产采集和下一次自动生成仍需验证，人工修订及离线 CI 不等同于自动全链路通过。

## 进行中

- 生产 runner 对 INVH／AMH 官方 IR 的实际发现及正文补抓仍待观察；本机 2／2 来源可读不是生产采集验收。[施工与授权范围](docs/plans/2026-10-29-editorial-coverage.md)。
- 新提示词和规则的下一次真实两阶段生成、诊断 artifact 与定时出刊仍待验证。原授权 4 次调用累计 326.783 秒，未直接产出合格期刊；补稿为零新增调用的显式编辑恢复。
- 任务内恢复无法解决平台未启动或延迟启动。10 月 29 日 05:36、09:02 及 13:52 生成均未成功发布，后续定时启动和 09:00 可读目标仍需持续观察。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-10-29 19:06 经用户明确授权，将 828c07b、c9be26c 推送 main 并部署至 Vercel；29 号修订稿、跨栏去重、栏目与资产补位、BTR 来源和覆盖说明已上线。更新脚本版本参数使浏览器加载新展示。开源代码、配置、测试、文档及数据同步完成。[验收](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 18:56 本地完成跨栏目事件防重、动态栏目与资产补位、正文导航剔除、INVH／AMH 官方 IR 补文、CRE 资产分类及缺刊覆盖说明。隔离修订稿 20 条，栏目 9／3／1／6／1，FOMC 1 条、INVH 1 条，6 条 CRE 子类明确；advisor 内容和代码复审通过。未提交、推送或上线。[验收](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 16:59 经用户明确授权，提交 fcf48b8 并推送 main，Vercel 部署成功。短编号映射、有界重试与诊断、拒稿规范化、金额连字符修复及 29 号 20 条补稿已上线；advisor 复验通过，保持数字与连续引文校验。65／77 源成功，degraded 和历史覆盖缺口保留。[施工与范围](docs/plans/2026-10-29-model-recovery.md)。
- 2026-10-28 23:07 发布代码 0010673，Vercel 报告部署成功；生产 HTML／JS／CSS 与隔离发布版逐项 SHA-256 一致，最新日报仍为 10 月 28 日。原工作区及无关 CSS、截图、lock 未改写。发布证据见 [生产验收](docs/validation/production-deployment.json)。
- 2026-10-28 23:00 采纳 advisor 意见：05:00 日报、07:00 周报及 08:00 补偿；周报固定北京上周一 05:00 至本周一 05:00，不等待日报模型成功。生成工作流取消 push 触发，独立只读 CI 运行离线测试。
- 2026-10-28 22:37 完成逐源水位、原料指纹恢复、补采标记、周月补查原料持久化；配置 77 个入口（含 46 个研究入口），采用 medium 编辑／low 写作和约 180 字速读摘要。实现及限制见 [详细验收](docs/validation/2026-10-28-morning-deadline.md)。
- 2026-10-28 17:48 将线上及本地模型恢复为 gpt-6.1-sol，补跑日报成功，用户确认 10 月 28 日显示。[运行日志](https://github.com/Freza00/us-housing-daily/actions/runs/40666081378)。

## 最近验证

- 2026-10-29 19:06 最终代码 c9be26c 的 Node.js 22.23.4 CI 166 项通过、0 失败；Vercel 部署成功。线上首页／JS／CSS／latest／29 号归档／日期列表与候选 SHA-256 全部一致，页面实际引用 /app.js?v=2026-10-29-editorial 内容匹配；FOMC 1 条、BTR 1 条、20 条总数及固定截止点通过。未执行浏览器视觉验收或付费生成。[结构化证据](docs/validation/2026-10-29-editorial-production.json)。
- 2026-10-29 18:56 主工作区和隔离发布候选在 Node.js v25.8.0 各通过 166 项测试；17 个运行脚本语法及 JSON 检查通过，首页内嵌／latest／归档一致。实际 57 条保存决策回放 19 条、FOMC 1 条；人工补查修订 20 条的数字及连续引文通过。两源本机实采 2／2 可读，advisor 独立复审通过；55 个正式文件和原 CSS／水位／pending 未变。不是远端 CI、生产采集或新模型全链路验收。[范围与限制](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 16:59 生产首页、latest、29 号 JSON 及日期索引均返回 HTTP 200，SHA-256 与候选逐项一致，日期为 2026-10-29、20 条。[Node.js 22 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40845600776) 127 项通过、0 失败；[Vercel 部署](https://vercel.com/freza00s-projects/news-agent/ChAbePwZpDBsK8fkG9RhpEzJaeUe) 成功。本地 127 项、5 个 YAML、脚本语法及 diff 检查通过，完整补稿与 advisor 复验通过；固定截止点和 14 条截稿后 pending 保留，根工作区 59 个正式文件及无关资源未改。[结构化证据](docs/validation/2026-10-29-production.json)。
- 2026-10-28 23:07 [生产 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40712118581) 在 Node.js 22.23.3 完成 103 项测试，0 失败；生产静态文件和最新数据内容比对通过，周报接口无授权请求返回预期 401，未触发生成。Vercel 部署 [J4XSdDEF2RJ5QyNUZi4fY5EBTqzG](https://vercel.com/freza00s-projects/news-agent/J4XSdDEF2RJ5QyNUZi4fY5EBTqzG) 成功。
- 2026-10-28 23:00 隔离发布版 34 个脚本语法、5 个工作流 YAML 与 Git diff --check 通过；59 个原工作区受保护文件未变，发布目录保留远端 data／state 与首页内嵌数据。
- 2026-10-28 22:39 advisor 复验日报 9 条原料恢复及周月补查保留路径通过。此前 4 组真实模型对照和 31／46 研究入口可读保留为历史证据。

## 已定位问题

10 月 29 日早间两轮均采到 57 条候选，05:40 连接中断，09:04 选稿返回未知 ID 后失败；13:52 的追加调度同样未成功发布。首轮缺少逐次调用记录，无法完整解释其 3 笔记账。29 号现已编辑恢复并上线；自动全链路及定时启动仍待验证，不能将补稿发布等同于调度已修复。

10 月 21 日起旧模型路由返回 get_channel_failed／model_not_found，重试后构建退出；采集和触发正常。[起点日志](https://github.com/Freza00/us-housing-daily/actions/runs/39526464861)。
