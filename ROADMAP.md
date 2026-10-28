# ROADMAP

## 当前状态

新版可靠性与研究覆盖改造已提交并部署至 Vercel，代码版本 0010673。线上模型为 gpt-6.1-sol。工作日日报 05:00；周一周报 07:00 首跑、08:00 补偿；月报维持首个周一 14:30，均为北京时间。09:00 为可读目标，仍受平台调度与外部服务影响。

## 进行中

- 10 月 29 日首次新版定时采集生成待观察：检查实际启动／生成／上线时间、必需研究源状态、水位续接和缓存。生产页面已核对，当前保留已恢复的 10 月 28 日日报，没有晚间重建。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-10-28 23:07 发布代码 0010673，Vercel 报告部署成功；生产 HTML／JS／CSS 与隔离发布版逐项 SHA-256 一致，最新日报仍为 10 月 28 日。原工作区及无关 CSS、截图、lock 未改写。发布证据见 [生产验收](docs/validation/production-deployment.json)。
- 2026-10-28 23:00 采纳 advisor 意见：05:00 日报、07:00 周报及 08:00 补偿；周报固定北京上周一 05:00 至本周一 05:00，不等待日报模型成功。生成工作流取消 push 触发，独立只读 CI 运行离线测试。
- 2026-10-28 22:37 完成逐源水位、原料指纹恢复、补采标记、周月补查原料持久化；配置 77 个入口（含 46 个研究入口），采用 medium 编辑／low 写作和约 180 字速读摘要。实现及限制见 [详细验收](docs/validation/2026-10-28-morning-deadline.md)。
- 2026-10-28 17:48 将线上及本地模型恢复为 gpt-6.1-sol，补跑日报成功，用户确认 10 月 28 日显示。[运行日志](https://github.com/Freza00/us-housing-daily/actions/runs/40666081378)。

## 最近验证

- 2026-10-28 23:07 [生产 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40712118581) 在 Node.js 22.23.3 完成 103 项测试，0 失败；生产静态文件和最新数据内容比对通过，周报接口无授权请求返回预期 401，未触发生成。Vercel 部署 [J4XSdDEF2RJ5QyNUZi4fY5EBTqzG](https://vercel.com/freza00s-projects/news-agent/J4XSdDEF2RJ5QyNUZi4fY5EBTqzG) 成功。
- 2026-10-28 23:00 隔离发布版 34 个脚本语法、5 个工作流 YAML 与 Git diff --check 通过；59 个原工作区受保护文件未变，发布目录保留远端 data／state 与首页内嵌数据。
- 2026-10-28 22:39 advisor 复验日报 9 条原料恢复及周月补查保留路径通过。此前 4 组真实模型对照和 31／46 研究入口可读保留为历史证据。

## 已定位问题

10 月 21 日起旧模型路由返回 get_channel_failed／model_not_found，重试后构建退出；采集和触发正常。[起点日志](https://github.com/Freza00/us-housing-daily/actions/runs/39526464861)。
