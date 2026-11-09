# 11 月 9 日 r1 已恢复上线，通用修复通过两轮复审

2026-11-09 10:42，固定规则基线 20a99547d8feb4f0dfc3be80b7089326eaa2b131 下的 2026-11-09 r1 已先行发布，数据提交 eac3fe873ed9da3798899a51efd64f8fd0e94e3c。publish.mjs 内部 latest、当期归档、日期索引和首页四路线上核验全部通过，payload SHA-256 为 626dbb0a17a9b38841e867a0950057f3dfe4f76c6396f83d2cd91b299c9e70e0，20 卡及双语摘要与冻结候选一致；Vercel Production success。回执：/Users/freddiezhang/Documents/Claude/Projects/美国住宅房地产报告/news-agent/.tmp/daily-20261109-fix/frozen-checkout/state/delivery-receipts/daily-2026-11-09-r1.json 。未新增模型或源站采集请求。

sol6.1-xh 首轮指出 F1 姓名所有格误判月份回归；收紧姓名、指标上下文及括号机构名识别后，第二轮独立复核 129 组探针／258 次卡片与 metadata 校验全部通过，结论 approve、阻塞项 0。

通用修复按用户授权紧随数据提交发布；本提交记录的是代码推送前状态，后续 CI／部署及独立生产回归结果写入任务目录 release-summary.json。

## r1 保留原规则及调用账本，零新增生成请求

- `frozen-checkout` 和 `clean-checkout` 均来自指定 `origin/main` 提交 `20a99547d8feb4f0dfc3be80b7089326eaa2b131`。原工作区 HEAD 及其本地远端引用未移动。
- 下载运行 `42526085953`、`42543059356` 的全部 prepared／editor／writer 阶段和 LLM 诊断附件；`restoreCheckpoint` 校验受信任仓库、分支、事件、工作流、修订、规则及阶段散列后安装最新 writer 附件 `13641957373`。API 原始结果及附件文件散列保存在任务目录。
- 原 prepared 为 68 个候选，选中 20 条；恢复前保存 19 张合格卡片及合格双语 metadata。通过旧版逻辑重建第二次 writer 请求，散列精确匹配 `6ba21c165de45aa938d2a8ef5a8aef6dc5b06d7ab252ffc380f5e653efd0046e`。
- 仅把短编号 `9`、稳定 ID `091d03c6e2673f60` 的回答引文开头 `Dallas-Fort Worth’s` 改为 `Dallas’`，该修复引文是原文的连续子串；其他回答字段保持。原 19 卡及双语 metadata 保持，editor／writer 各 2 次，`model_ms = 237026`、`spentMs = 267026`，同版剩余总时间 `392974 ms`。
- 旧版 `validateWritingCard`、`validateWriting`、`validateIssue` 全量通过；13 个出版机构均未超过 3 条，无 cap 例外。栏目为 BTR 1／全国 5／CRE 6／机构资本 4／Sunbelt 4；中文摘要 181 个非空白字符，英文 69 词。
- 本地 `runPipeline('daily', ...)` 在隔离 state 生成 20 卡 `ready.json`，固定 cutoff `1794171600000`、r1 及原规则保持。新增源站和模型请求均为 0；新 state 安装五阶段后通过冷恢复，另启动新 Node.js 进程完成零请求重入，ready／manifest 不变。

## O2：20 卡通过既有校验，其中两处保留规范化匹配差异

20 张卡片均通过未修改的旧版严格校验，其中 18 张引文同时是字节级原文连续子串。以下两张属于恢复前已经通过并保存的 19 张卡片，按本轮约束未改写；不能将本次校验宣称为 20 张全部字节级一致。

- `8304d88890577563`：ATTOM 引文止于 `with sufficient data.`，源文继续为 `with sufficient data for both third quarters.`。旧版去除句号后的文字可连续匹配，但引文句末句号不是原位置标点。
- `b6dc848a8b6abf78`：引文开头为 `The plan`，原文为 `the plan`，仅大小写不同。

未改动引文门禁，未使用模糊匹配、跳词或新模型请求处理上述差异。

## 通用修复及回归验证

- `pipeline.mjs` 只在距 deadline 减去 180000 ms 后仍大于 0 时收缩预算；预留窗边界、窗内及 deadline 后统一使用同版 660000 ms 总预算。账本已耗尽时仍拒绝新增请求。
- `groundedNumbers` 支持 with／by／before／after／ahead of 和英文月份直／弯引号所有格；`May Capital`、`May's Capital`、`May’s Capital` 等后接大写专有名词的证据不能放行数字月份，月份证据也不能放行百分比。
- 引文不匹配的局部修复提示要求逐字复制连续原文，明确禁止把 `Dallas’` 扩写为 `Dallas-Fort Worth’s`；其他类型错误保持原提示。
- 日报 Actions cron 改为 `17 0,1 * * 1-5`，加入北京 09:17 兜底。
- 新增 26 个回归测试：预算恢复 7 个 deadline 情况 × 3 个 spentMs 情况，以及月份／机构名／真实第 18 条原答／引文提示／cron。正式 fixture 仅存原卡片及 830 字符相关正文片段，无密钥，不依赖任务目录。
- 改动前主工作区 `npm test`：298／298；新测试放回旧代码：43 项中 8 项按预期失败，35 项通过；修复后主工作区、指定基线干净副本的完整 `npm test` 均为 324／324、0 失败。使用本机 Node.js v25.8.0；未执行生产模型探针或源站校验，因为未修改路由参数或来源配置。

## 冻结散列与证据位置

以下使用项目既有 `digest` 口径，即 `SHA-256(JSON.stringify(value))`，区别于格式化 JSON 文件的字节散列。

| 对象 | SHA-256 |
| --- | --- |
| payload | `626dbb0a17a9b38841e867a0950057f3dfe4f76c6396f83d2cd91b299c9e70e0` |
| prepared | `62996b916dd907e637495dc6768a5a1ac4761433577dbef00a7d763a803c4191` |
| editor | `6e98f3077bc33c650ae654bb89bd1c4531724d47b20c4a11a3bddcdbad62c676` |
| cards | `39e7f2f04d747a3fdaf7685dc33a73eab40408ace72641a5be460509b36ccb48` |
| metadata | `66451a8528da2ffa6fdde870bc0549ab6b50e0e2590e485a8ca3fe9823f2ea20` |
| ready | `e7948d7805d1fd561ec73b985e8703ee26a064c24c66bfa43c6f82bbfa6e1315` |

原 cards 阶段为 `815bfd8309f00df48ec45a879b63cb36b2e26c7cf0ba073f095b33720dc8fe6f`；追加第 20 张卡后发生预期变化。prepared／editor／metadata 内容散列保持。`ready.json` 文件字节 SHA-256 为 `508ee41b0e26b6aaca0b4ad1779832abeda0cd1286906506117672e051482a2a`。

候选位于项目 `.tmp/daily-20261109-fix/recovery/state/issues/daily/2026-11-09/r1/ready.json`；详细执行记录为同目录任务根下 `execution-summary.json`，持久摘要见 [结构化记录](2026-11-09-daily-recovery-and-budget-fix.json)。任务目录含起始文件基线、补充 data／state 散列、恢复脚本、原附件、请求重建及双环境测试日志。主工作区非目标文件及 62 个 data／state 文件最终逐项核对；已有样式和正式数据未改变。


## 分步发布与复审记录（2026-11-09 10:42）

sol6.1-xh 首轮指出 F1 姓名所有格误判月份回归；收紧姓名、指标上下文及括号机构名识别后，第二轮独立复核 129 组探针／258 次卡片与 metadata 校验全部通过，结论 approve、阻塞项 0。

O1：预留窗前仍按既定方案保留 3 分钟发布窗口，不另设最小窗口阈值；距截止 180001 ms 时可能仅余 1 ms，真实时钟推进后仍可能耗尽，不能声称所有时间点均可完成请求。O2：20／20 卡通过 validateWritingCard，其中 18／20 引文为逐字连续子串，2 张首轮保留卡通过既有规范化引文匹配，未改写或放宽门禁。

F1 关闭后 editor 文件 SHA-256 为 303d4a1b8b65702e449170fe8da0823d5af995da63b9ba5cffa891b2f10b340a，定向测试文件为 4fed0ef7c7e109675404916eb231d951631f24f0a32aafc2cbdc75fa82ce2c48。主工作区与干净副本均重新运行 npm test，324／324、0 失败；代码提交前在数据提交基线上再次执行。

数据发布回执为 `/Users/freddiezhang/Documents/Claude/Projects/美国住宅房地产报告/news-agent/.tmp/daily-20261109-fix/frozen-checkout/state/delivery-receipts/daily-2026-11-09-r1.json`；数据提交 `eac3fe873ed9da3798899a51efd64f8fd0e94e3c`，四路线上验证及 Vercel success 已取得实际证据。本轮恢复为人工补发，不计为 09:00 前自动出刊；连续 SLA 和后续定时首跑仍待观察。
