# ROADMAP

## 当前状态

11 月 2 日完整美东周／月周期、下午错峰及固定原文日期已提交 d160c43、同步开源 main 并上线。Node.js 22 CI 的 237 项通过，Vercel success；线上新版 HTML／JS／CSS、周／月中英文固定日期与真实窗口均核验通过，七个已刊数据路由散列不变。本期周报保留原截止点和稿件，不重做新修订；北京 11 月 2 日 05:00 至 13:00 的 8 小时仅为本次周报切换未补发的过渡窗口，日报和月报仍各按自身规则收录。新周报从 11 月 9 日观察，月报下次为 12 月 1 日；未注册额外观察器或通知。[生产验收](docs/validation/2026-11-02-periodical-calendar-production.md)。

11 月 2 日周报、10 月月报均已恢复并上线，各 20 条；latest、当期归档和日期列表逐项与冻结候选一致。摘要／月份修复及来源状态去重／100 MiB 文件门禁已同步开源 main，代码合入提交 23cc0fd；Node.js 22 CI 的 225 项通过，Vercel success。实际月报输入从 188.7 MB 降到 1.0 MB，全部不同来源观测、覆盖缺口、payload／冻结附件／账本保持。本轮新增模型及源站采集请求均为 0；原工作区正式数据保持，11 月 2 日线上日报及首页资源未改变。[发布验收](docs/validation/2026-11-02-periodicals-release.md)。

11 月 2 日日报首跑失败后，同版冻结阶段与 18 张合格卡片被自动恢复，08:51:43 完成 20 条线上核验，形成首个强化后的真实恢复样本；来源 66／77 成功，HAR 超时，本期 degraded。周报此前三次摘要超长、writer 额度用尽，现已用完整句候选恢复；月报此前生成成功但输入文件过大导致推送受阻，现已修复并恢复交付。两者属于人工恢复发布，不能记为准时自动出刊。[原日志与双顾问对照](docs/validation/2026-11-02-advisor-comparison.md)。

线上模型为 gpt-6.1-sol。北京时间工作日日报 05:00 首跑、09:00 可读目标；周报周一 14:00 首跑、15:00 目标；月报次月首个周一至周五 15:00 首跑、16:00 目标，不另排除法定节假日。周报与月报采用完整美东自然周期，同日错峰且互不依赖对方成功；调度和外部服务仍可能使发布延后。新配置已部署接受，下一次真实 cron 执行、连续 SLA 及实际 redeploy 尚待后续验证。

P0 自动出刊强化已完成代码与本地验证：冻结版本、分阶段附件、卡片／摘要局部恢复、跨运行额度账本、独立候选发布及线上确认均已实现；隔离版和主工作区各 205 项测试通过。Astra max 最终只读复审通过，独立 79 项测试通过。已按用户授权提交 69a45a1、同步开源 main 并上线 Vercel，Node.js 22 CI 的 205 项通过，生产内容核验通过。独立外部截止调度与通知继续不启用。[生产证据](docs/validation/2026-10-30-automation-hardening-production.md)。[本地验收](docs/validation/2026-10-30-automation-hardening-implementation.md)；[施工清单](docs/plans/2026-10-30-automation-hardening-implementation.md)。

## 进行中

- 新配置已上线，等待 11 月 9 日周报（北京 14:00／15:00）及 12 月 1 日月报（15:00／16:00）的实际首跑；本期旧刊保留，周报 8 小时过渡窗口不补发、不自动移入下一自然周。本次没有新采集或模型请求。[施工与边界](docs/plans/2026-11-02-periodical-calendar-trial.md)。

- 日报真实 runner 阶段上传／恢复、同版续写与线上交付已验证一次；周／月报人工恢复发布和生产交付也已验证。实际 redeploy、连续 10 工作日 SLA 及周月报修复后的自动首跑仍待观察。外部观察器调度和通知继续不启用，P1 少稿政策另定。
- 30 号生产原料证实 INVH 公告正文取得成功，因已在 29 号发布而按 seen 去重；AMH 本期源检查正常但无当期新稿，新的正文补抓仍待观察。本机与 runner 验证证据分别记录。[本轮证据](docs/validation/2026-10-30-publication-eligibility.md)。
- 30 号真实两阶段生成及诊断 artifact 已验证能运行，定时阶段数字校验连续失败；用户 rerun 的单卡修复成功。稳定在 09:00 前自动出刊仍未实现，不能用一次手动恢复替代稳定性验收。
- 任务内恢复无法解决平台未启动或延迟启动。10 月 29 日 05:36、09:02 及 13:52 生成均未成功发布，后续定时启动和 09:00 可读目标仍需持续观察。
- 15 个研究入口仍有访问或发现障碍；31／46 可读是此前本机探针结果，不代表生产已全部覆盖。Vercel CLI 现有 token 无效，未独立读取账号套餐和线上 cron 注册表；部署已接受仓库 cron 配置，Actions 补偿配置已上线。

## 最近完成

- 2026-11-02 19:17 提交 d160c43 并同步 main、Vercel 上线；完整美东周／月周期、14:00／15:00 错峰首跑、15:00／16:00 可读目标、固定原文日期与真实归档窗口生效。237 项 CI 通过，线上资源与四种刊物／语言组合核验通过；本期旧刊及账本保持，无新采集或模型。[生产验收](docs/validation/2026-11-02-periodical-calendar-production.md)。

- 2026-11-02 17:34 先以 c646632／bd26ff8 发布本期周报和 10 月月报，各 20 条，再将摘要／月份修复、恢复状态去重和发布大小门禁同步 main（23cc0fd），Vercel 上线成功。月报输入从 188,733,460 降至 1,005,059 字节，不改候选和账本；两刊六路及现有日报／首页核验通过，无新模型或采集调用。[发布验收](docs/validation/2026-11-02-periodicals-release.md)。

- 2026-11-02 15:51 完成反重力 Argon High 与 Astra max 的只读对照及离线复现；确认恢复／额度保护有效，区分摘要契约、草稿上下文、月份误拦与既定策略，给出保留 20 卡的零新增模型候选路径。仅形成报告，未实施或补发。[综合诊断](docs/validation/2026-11-02-advisor-comparison.md)。

- 2026-10-30 17:59 提交 69a45a1 并同步开源 main、Vercel 上线成功；P0 冻结阶段、局部恢复、跨运行额度及交付核验正式上线。生产 30 号 19 条及 29 号归档保持，未新增模型生成或启用独立调度／通知。[发布证据](docs/validation/2026-10-30-automation-hardening-production.md)。

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

- 2026-11-02 19:17 [Node.js v22.23.4 CI](https://github.com/Freza00/us-housing-daily/actions/runs/41435127322) 的 237／237、0 失败；[Vercel](https://vercel.com/freza00s-projects/news-agent/EUvSHtoQwNcz8GibhaJ4qT5QQbYK) success。线上 HTML、新版 JS／CSS 与发布候选散列一致，七个期刊数据路由不变；周报桌面和月报手机的中英文均显示 20 个固定日期，旧窗口真实，无 pageerror 或横向溢出。134 个非目标起始文件保持，无重刊／模型调用；未触发下一期或设置外部观察器。[结构化证据](docs/validation/2026-11-02-periodical-calendar-production.json)。

- 2026-11-02 18:14 主工作区和隔离版各 237／237、0 失败；104 个连续周、24 个月初、57 个脚本语法、JSON／YAML 及 diff 通过。实际 CLI dry-run 周／月各 20 条，四种桌面／手机组合的中英文、20 张固定日期、旧窗口和无横向溢出检查通过；116 个非目标起始文件、原业务数据与首页内嵌数据保持。[结构化证据](docs/validation/2026-11-02-periodical-calendar-trial.json)。

- 2026-11-02 17:34 主工作区、隔离版及合并版本地均 225 项通过；[Node.js 22 CI](https://github.com/Freza00/us-housing-daily/actions/runs/41421525772) 成功，0 失败，[Vercel](https://vercel.com/freza00s-projects/news-agent/9ySZuio5SP1RcXAH5GuCTgi5nnQ2) success。周／月 latest、归档、索引与候选一致，11 月 2 日日报 20 条、首页内嵌数据、JS／CSS 散列保持；122 个非目标起始文件及正式 data／state／public 未变。没有新的模型／采集、浏览器视觉验收或长期 SLA 验收。[生产证据](docs/validation/2026-11-02-periodicals-release.json)。

- 2026-11-02 15:51 Astra 14 组独立探针与 6 组比较探针通过，主 agent 复跑后确认三稿前缀 171／171／188 的完整写稿校验、全部 20 卡不变、250 边界及原始阶段散列／规则匹配。报告前 121 个受保护文件不变，无新增 House Daily 调用或外部写入；只更新审查记录与进度。[证据](docs/validation/2026-11-02-advisor-comparison.json)。

- 2026-10-30 17:59 [本轮 CI](https://github.com/Freza00/us-housing-daily/actions/runs/41037034837) 在 Node.js v22.23.4 通过 205 项、0 失败；[Vercel](https://vercel.com/freza00s-projects/news-agent/FNDBn9fXLLtFvxFdPMAzFn97u5Kx) success。生产 7 个路由内容散列匹配候选，首页／latest／归档一致，只读观察返回 online_verified；原工作区 112 个受保护文件不变，无生成工作流或浏览器视觉验收。[结构化证据](docs/validation/2026-10-30-automation-hardening-production.json)。

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
