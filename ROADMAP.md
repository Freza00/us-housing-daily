# ROADMAP

## 当前状态

30 号日期缩写与旧闻入选修复已按用户授权提交 ca5f11f、同步开源 main 并上线 Vercel。30 号现为 19 条，168 天前的旧闻已移除；Node.js 22 CI 的 179 项测试、Astra 复审及生产内容核验通过。首页内嵌、latest、30 号归档一致，29 号归档保持原样。[修复验收](docs/validation/2026-10-30-publication-eligibility.md)；[生产核验](docs/validation/2026-10-30-publication-production.json)；[根因分析](docs/validation/2026-10-30-rerun-diagnosis.md)。

线上模型为 gpt-6.1-sol。工作日日报 05:00；周一周报 07:00 首跑、08:00 补偿；月报维持首个周一 14:30，均为北京时间。09:00 为可读目标，仍受平台调度与外部服务影响。真实生产采集和下一次自动生成仍需验证，人工修订及离线 CI 不等同于自动全链路通过。

P0 自动出刊强化已完成代码与本地验证：冻结版本、分阶段附件、卡片／摘要局部恢复、跨运行额度账本、独立候选发布及线上确认均已实现；隔离版和主工作区各 205 项测试通过。Astra max 最终只读复审通过，独立 79 项测试通过。用户已授权提交、同步开源和上线，目前发布进行中；外部截止调度与通知继续不启用，完成状态以发布核验为准。[本地验收](docs/validation/2026-10-30-automation-hardening-implementation.md)；[施工清单](docs/plans/2026-10-30-automation-hardening-implementation.md)。

## 进行中

- P0 发布进行中（用户已授权提交／同步开源／上线）：本地 205 项通过、29／30 号已有内容离线恢复通过；真实 runner 附件恢复、下一次自动生成／交付、Vercel redeploy 和连续 10 工作日 SLA 尚未验证。外部观察器调度及通知暂不启用，P1 少稿政策另定，不声称生产自动自愈已具备。[验收边界](docs/validation/2026-10-30-automation-hardening-implementation.md)。
- 30 号修复及 19 条修订稿已上线，源头采集／新提示词生成及下一次定时发布仍待生产自动全链路验证。本次部署和离线回放未新增 House Daily 模型调用，不能替代下一轮自动生成验收。[验收与限制](docs/validation/2026-10-30-publication-eligibility.md)。
- 30 号生产原料证实 INVH 公告正文取得成功，因已在 29 号发布而按 seen 去重；AMH 本期源检查正常但无当期新稿，新的正文补抓仍待观察。本机与 runner 验证证据分别记录。[本轮证据](docs/validation/2026-10-30-publication-eligibility.md)。
- 30 号真实两阶段生成及诊断 artifact 已验证能运行，定时阶段数字校验连续失败；用户 rerun 的单卡修复成功。稳定在 09:00 前自动出刊仍未实现，不能用一次手动恢复替代稳定性验收。
- 任务内恢复无法解决平台未启动或延迟启动。10 月 29 日 05:36、09:02 及 13:52 生成均未成功发布，后续定时启动和 09:00 可读目标仍需持续观察。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-10-30 17:27 完成 P0 固定版本、冻结阶段、局部写作恢复、跨运行额度账本、候选发布与线上核验，以及三类工作流接入；隔离／主工作区各 205 项及 Astra max 独立 79 项通过。只读截止观察已实现，外部调度／通知未启用；未提交、推送或部署。[施工与交付](docs/plans/2026-10-30-automation-hardening-implementation.md)。

- 2026-10-30 12:51 完成 Astra max 自动出刊只读审查与强化方案；确认 degraded 已刊重建、补文导致编辑缓存漂移、摘要错误扩大写稿失败等缺口，明确阶段附件、候选包与线上确认。官方缓存源码排除了“常见保存服务错误直接阻断”作为主要根因。方案复审可定稿，未改代码／配置／生产，未提交或推送。[审查](docs/validation/2026-10-30-automation-hardening-review.md)。
- 2026-10-30 12:24 经用户明确授权，提交 ca5f11f 并推送开源 main，Vercel 部署成功。30 号 19 条修订稿及出版资格／月份修复上线；生产首页、JS、CSS、latest、30／29 号归档和日期列表逐项 SHA-256 一致。原工作区 56 个受保护文件未变。[生产证据](docs/validation/2026-10-30-publication-production.json)。
- 2026-10-30 12:19 完成本地日报出版资格与月份缩写修复；原料保留独立于出版资格，失败／停源积压可追溯恢复，超期首次发现和明确正文不足拒绝。采纳 Astra 意见防止周月补采重授资格及机构名误授月份。19 条撤稿候选、179 项测试和独立复审通过，未提交或上线。[施工与验收](docs/plans/2026-10-30-publication-eligibility.md)。
- 2026-10-29 19:06 经用户明确授权，将 828c07b、c9be26c 推送 main 并部署至 Vercel；29 号修订稿、跨栏去重、栏目与资产补位、BTR 来源和覆盖说明已上线。更新脚本版本参数使浏览器加载新展示。开源代码、配置、测试、文档及数据同步完成。[验收](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 18:56 本地完成跨栏目事件防重、动态栏目与资产补位、正文导航剔除、INVH／AMH 官方 IR 补文、CRE 资产分类及缺刊覆盖说明。隔离修订稿 20 条，栏目 9／3／1／6／1，FOMC 1 条、INVH 1 条，6 条 CRE 子类明确；advisor 内容和代码复审通过。未提交、推送或上线。[验收](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 16:59 经用户明确授权，提交 fcf48b8 并推送 main，Vercel 部署成功。短编号映射、有界重试与诊断、拒稿规范化、金额连字符修复及 29 号 20 条补稿已上线；advisor 复验通过，保持数字与连续引文校验。65／77 源成功，degraded 和历史覆盖缺口保留。[施工与范围](docs/plans/2026-10-29-model-recovery.md)。
- 2026-10-28 23:07 发布代码 0010673，Vercel 报告部署成功；生产 HTML／JS／CSS 与隔离发布版逐项 SHA-256 一致，最新日报仍为 10 月 28 日。原工作区及无关 CSS、截图、lock 未改写。发布证据见 [生产验收](docs/validation/production-deployment.json)。
- 2026-10-28 23:00 采纳 advisor 意见：05:00 日报、07:00 周报及 08:00 补偿；周报固定北京上周一 05:00 至本周一 05:00，不等待日报模型成功。生成工作流取消 push 触发，独立只读 CI 运行离线测试。
- 2026-10-28 22:37 完成逐源水位、原料指纹恢复、补采标记、周月补查原料持久化；配置 77 个入口（含 46 个研究入口），采用 medium 编辑／low 写作和约 180 字速读摘要。实现及限制见 [详细验收](docs/validation/2026-10-28-morning-deadline.md)。
- 2026-10-28 17:48 将线上及本地模型恢复为 gpt-6.1-sol，补跑日报成功，用户确认 10 月 28 日显示。[运行日志](https://github.com/Freza00/us-housing-daily/actions/runs/40666081378)。

## 最近验证

- 2026-10-30 17:27 Node.js v25.8.0 隔离／主工作区 205／205、Astra max 独立 79／79；5 个 YAML、51 个 ESM 和工作流身份／附件／顺序断言通过，git diff --check 通过。29／30 号已有 20／19 条内容恢复及保存回答离线检查通过，97 个非目标起始文件不变；没有新模型生成、远端 CI、生产部署或连续 SLA 验收。[本地证据及限制](docs/validation/2026-10-30-automation-hardening-implementation.md)。

- 2026-10-30 12:51 核对 Astra max 四个离线 stub 探针的源码、断言与结果：degraded 重入、完成守卫空刊反例、同 ID 证据变化重做编辑、3 张好卡片因坏摘要整阶段失败。核对 GitHub／Vercel 官方平台约束；16 个运行／配置／前端及 56 个受保护数据／前端文件未变，发布目录干净。未新增真实模型调用，未重跑全套或做新生产验收。[结构化证据](docs/validation/2026-10-30-automation-hardening-review.json)。
- 2026-10-30 12:24 [代码 ca5f11f 的 CI](https://github.com/Freza00/us-housing-daily/actions/runs/41002557228) 在 Node.js v22.23.4 通过 179 项测试，0 失败；[Vercel 部署](https://vercel.com/freza00s-projects/news-agent/Fw3q2yQrwVQEF7Byuu2XJfkPRPrK) 成功。线上 30 号 19 条，旧闻移除、截止点 1793307600000、数字／引文／摘要引用及首页／latest／归档一致性通过；无浏览器视觉验收或新模型全链路生成。[结构化证据](docs/validation/2026-10-30-publication-production.json)。
- 2026-10-30 12:19 主工作区和隔离版 Node.js v25.8.0 均通过 179 项测试；Astra 独立 67 项测试及最终复审通过。真实 70 候选中 15 条超期、10 条证据不足被门禁排除，19 条修订候选的数字、引文、摘要引用和首页／归档／latest 一致性通过。两次日期 10 误报已消除，推算 8 和改写引文继续拒绝；根目录 56 个受保护文件未变。无新增生成调用或部署。[验证](docs/validation/2026-10-30-publication-eligibility.md)。
- 2026-10-30 11:26 通过 CLI／API 取得 05:36、09:07 失败及用户成功 rerun 的完整日志，下载可用诊断附件和实际输入；导入实际模块复现日期缩写误报、推算差额拦截及超期旧稿补采入池。生产已是 30 号 20 条，但第 17 条发布日期为 5 月 14 日，内容时效验收不通过。此次分析未新增模型调用或改生产。[证据与结论](docs/validation/2026-10-30-rerun-diagnosis.md)。
- 2026-10-29 19:06 最终代码 c9be26c 的 Node.js 22.23.4 CI 166 项通过、0 失败；Vercel 部署成功。线上首页／JS／CSS／latest／29 号归档／日期列表与候选 SHA-256 全部一致，页面实际引用 /app.js?v=2026-10-29-editorial 内容匹配；FOMC 1 条、BTR 1 条、20 条总数及固定截止点通过。未执行浏览器视觉验收或付费生成。[结构化证据](docs/validation/2026-10-29-editorial-production.json)。
- 2026-10-29 18:56 主工作区和隔离发布候选在 Node.js v25.8.0 各通过 166 项测试；17 个运行脚本语法及 JSON 检查通过，首页内嵌／latest／归档一致。实际 57 条保存决策回放 19 条、FOMC 1 条；人工补查修订 20 条的数字及连续引文通过。两源本机实采 2／2 可读，advisor 独立复审通过；55 个正式文件和原 CSS／水位／pending 未变。不是远端 CI、生产采集或新模型全链路验收。[范围与限制](docs/validation/2026-10-29-editorial-coverage.md)。
- 2026-10-29 16:59 生产首页、latest、29 号 JSON 及日期索引均返回 HTTP 200，SHA-256 与候选逐项一致，日期为 2026-10-29、20 条。[Node.js 22 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40845600776) 127 项通过、0 失败；[Vercel 部署](https://vercel.com/freza00s-projects/news-agent/ChAbePwZpDBsK8fkG9RhpEzJaeUe) 成功。本地 127 项、5 个 YAML、脚本语法及 diff 检查通过，完整补稿与 advisor 复验通过；固定截止点和 14 条截稿后 pending 保留，根工作区 59 个正式文件及无关资源未改。[结构化证据](docs/validation/2026-10-29-production.json)。
- 2026-10-28 23:07 [生产 CI](https://github.com/Freza00/us-housing-daily/actions/runs/40712118581) 在 Node.js 22.23.3 完成 103 项测试，0 失败；生产静态文件和最新数据内容比对通过，周报接口无授权请求返回预期 401，未触发生成。Vercel 部署 [J4XSdDEF2RJ5QyNUZi4fY5EBTqzG](https://vercel.com/freza00s-projects/news-agent/J4XSdDEF2RJ5QyNUZi4fY5EBTqzG) 成功。
- 2026-10-28 23:00 隔离发布版 34 个脚本语法、5 个工作流 YAML 与 Git diff --check 通过；59 个原工作区受保护文件未变，发布目录保留远端 data／state 与首页内嵌数据。
- 2026-10-28 22:39 advisor 复验日报 9 条原料恢复及周月补查保留路径通过。此前 4 组真实模型对照和 31／46 研究入口可读保留为历史证据。

## 已定位问题

10 月 29 日早间两轮均采到 57 条候选，05:40 连接中断，09:04 选稿返回未知 ID 后失败；13:52 的追加调度同样未成功发布。首轮缺少逐次调用记录，无法完整解释其 3 笔记账。29 号现已编辑恢复并上线；自动全链路及定时启动仍待验证，不能将补稿发布等同于调度已修复。

10 月 21 日起旧模型路由返回 get_channel_failed／model_not_found，重试后构建退出；采集和触发正常。[起点日志](https://github.com/Freza00/us-housing-daily/actions/runs/39526464861)。
