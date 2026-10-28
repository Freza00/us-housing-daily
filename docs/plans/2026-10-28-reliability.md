# News reliability implementation

## Objective and boundaries

在不覆盖原工作区样式、截图和既有文档改动的前提下，基于远程 main 完成研究源、选择质量、模型效率、日历和发布完整性优化。用户已授权实施；提交、推送和部署按全局 Git 规则另行取得明确授权。

## Decisions

- 北京时间周六、周日不执行生产采集和模型调用；日报工作日 05:00 启动，以逐源成功水位续接，截稿后已观察内容持久保留供下一期。
- 周报周一 07:00 首跑、08:00 补偿，固定北京上周一 05:00 至本周一 05:00；月报在首个周一 14:30 按已结束美东自然月筛选。提供脚本和触发端双重守卫。
- 正常流程两次模型调用：语义判断 `gpt-6.1-sol/medium`，最终卡片和摘要 `gpt-6.1-sol/low`；参数兼容性须真实验证，不预设中转必然透传。
- 来源按原始出版机构归组；研究必监测、重要新研究优先进入候选，允许有记录的质量例外，不为机构凑日刊配额。
- 弱相似不直接删除；同指标、同地区、同统计期的同一报告与有独立增量的解读分别处理。排除集合不得被补位绕过。
- 每期保存可回放的完整输入、截止时间、来源状态和版本；隔离测试不写生产 data/state。事后重建样本明确标注。
- 日报摘要以 180 字为目标，150～200 字为常态、250 字为上限，句子关联入选新闻 ID。正文不足时不推断数字或因果。

## Tasks and ownership

### S1 — Mainstream housing research sources

目标：验证全国住房与 Texas／都会区主流研究入口，重点 HAR、Zillow Research、Realtor.com Research、NAR Research，补充 Census、FHFA、Fannie Mae、Freddie Mac、NAHB、Redfin、TRERC、Texas REALTORS、MetroTex、Unlock MLS、Harvard JCHS、Urban／Brookings。

工作者仅负责只读研究，不修改文件。必须加载 web-access。交付每机构的官方入口、推荐机器采集路径、最近可见报告 URL／日期、可访问性或已知限制，区分已验证与待验证。不能把 Google News 当原始出版方。验收以实际打开的官网和具体报告为据。

### S2 — Mainstream CRE and institutional research sources

目标：验证 CBRE、JLL、Cushman & Wakefield、Colliers、Yardi Matrix、RealPage、NMHC、NAA、ULI／PwC、MSCI 的研究与 insight 入口，覆盖 BTR／SFR、多户、交易和机构资本。

权限、交付和验收同 S1；只读研究，不写文件，不绕登录或访问限制，不把未实现连接器称为已接入。

### I1 — Implementation (root only)

允许修改 candidate 内 config、scripts、api、public、workflows、vercel 配置、相关工程文档和必要项目依赖；不得覆盖原仓库的用户改动，不改任何密钥，不触发生产发布。实施共享采集、日历、模型客户端、选择和摘要模块，保留既有输出消费兼容性。

### V1 — Verification and advisor review

先运行已有测试，再加入真实回归和故障验证：误合并、重复复活、来源集中、无效／截断 LLM 响应、超时、永久路由错误、周末零调用、周一 72 小时边界、DST、美东周报缺口、摘要证据和格式。来源 live probe 与隔离构建实际执行；固定候选和状态比较旧逻辑与候选。付费试验控制在必要代表样本，不进行无边界重复。

advisor-astra-max 对最终候选只读复审，交付实际问题、验证证据与未解决项。主 Agent 核对后更新 README／ROADMAP 和验证记录，再交付具体变更及发布申请。

## 实测后修正

- 本机命令服务间歇恢复后，完成 low／medium 真实小额协议探针；确认接受参数与返回模型名，不由此推断中转内部实现。
- 完成 43 源首次机器探针；用实际 HAR、NAR、Census HTML 修复导航标题、实际研究路径、嵌套页面和日期时区。访问受阻仍单列，不猜测成功。
- 两轮真实历史回放揭示 JSON 格式、首字等待、引文标点、英文数字词及多余占位 ID 的问题；已补对应回归，第三轮 4 组配对回放均成功，最终校验器复验也通过。引文只容忍标点/空白等价，保留用词和数字验证。标题可作证据时明确记录 basis。选中 ID 白名单之外输出不发布，丢弃项保留诊断；缺选中稿、重复选中稿继续失败。
- 来源限额离线比较 159 期旧存档，旧选中池 126 期超限，新规则 0 期无例外超限；不据此声称原始候选召回或 token 降幅。
- 候选源码已完成本地验收并合并到原工作区，原目录测试复验通过；尚无提交、推送或部署授权。

- HAR 实际目录为按日期倒序的发布稿归档。排除已实证的导航 pid 后，按 source.discovery_order=newest_first 声明已核对的目录顺序；只有实际读到日期单调递减且最旧日期越过窗口下界、没有文章错误时，允许以 ordered_date_horizon 证明本窗口，不要求每次重读全部历史档案。其他无排序证据的截断目录仍不贡献完整覆盖。

- 最终配置 77 个入口（46 个研究入口），累计 31 个取得可读材料；新增 S&P Case-Shiller、Zonda 月报及土地供给公开页已机器实测。15 个来源受限或未发现有效链接，保留真实状态。86 项测试、脚本语法、工作流 YAML、桌面／手机页面验收通过；正式证据见 docs/validation/2026-10-28-reliability.md。
