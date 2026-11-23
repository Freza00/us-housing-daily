# 部署与运行

Vercel 托管 `public/`，构建时复制 `data/`。GitHub Actions 生成数据并提交回仓库，主分支推送触发既有 Vercel 集成。生产部署与远端写入需要用户明确授权。

## 配置

GitHub Repository Secrets 使用 `LLM_API_KEY`、`LLM_ENDPOINT`、`LLM_MODEL` 及备用 `LLM_BACKUP_API_KEY`、`LLM_BACKUP_ENDPOINT`。保留已有密钥；当前默认模型配置是 `gpt-6.2-sol`，主通道与备用通道均同步切换：`editor` 与 `writer` 阶段显式请求 `high`（`sol6.2-high`），成稿后的 `reviewer` 审核阶段显式请求 `xhigh`（`sol6.2-xh`），不传 `temperature`。中转兼容性以 `scripts/probe-model.mjs` 的实际结果为准。

SEC EDGAR 来源需要配置真实 `SEC_CONTACT_EMAIL`；未设置时该来源可能拒绝访问，不能把占位联系方式视为已符合要求。可通过 Actions 的环境配置传入；不要将真实密钥写进代码。

可选 Vercel 定时触发使用 `GH_PAT` 和 `CRON_SECRET`：前者需要仓库 dispatch 权限，后者验证定时请求。已启用的 GitHub cron 可独立运行，不必增加一套触发器。两个入口同时触发时，共享并发组和完整期刊守卫负责减少重复生成。

## 日历与重试

时间及周期见 README.md。工作流的 UTC cron 已换成北京时间工作日：

- 日报：Vercel 主触发为 UTC 周日至周四 21:00，即北京周一至周五 05:00；Actions 在 UTC 周日至周四 21:17、22:17、23:17 及周一至周五 00:17 补偿检查。
- 周报：Vercel 主触发为周一 06:00 UTC，即北京周一 14:00；Actions 于周一 06:07／27／47 UTC 补偿。内容固定为完整美东自然周，目标北京 15:00 前可读，不等待日报或月报模型成稿。
- 月报：Vercel 在 UTC 每月 1—3 日 07:00 主触发，即北京 15:00；Actions 同日 07:07／27／47 UTC 补偿，API／流水线守卫仅放行次月首个北京周一至周五，目标 16:00 前可读。日期范围覆盖月初周末顺延，不把首个工作日误写成首个周一，也不另加节假日服务。
- 周末在 API、工作流守卫和生成脚本退出，`force` 也不绕过周末。

通过完整内容校验的同期归档优先复用。周／月报的快照缺口补齐后可按限定窗口自动申请一次 `r2`，由恢复 CLI 复算并核对账本后批准。latest、日期索引或首页缺失／损坏时进入发布修复。无合格归档时恢复冻结阶段，显式 force 可创建新修订。GitHub 定时执行可能延迟，不承诺整点完成。

三类工作流共享 `news-build` 并发组，job 上限 25 分钟，首步写入第 21 分钟的模型停止点 `LLM_JOB_STOP_MS`。PDF 工具缺失时安装 Poppler，再运行测试。旧的失败后等待一小时再触发循环已移除，失败监测工作流只记录告警。

三阶段共用 900,000 ms 模型预算，各阶段最多 3 次请求。请求耗时、退避和未结束请求的预留时长均跨运行累计。编辑／写稿各允许 16,000 completion tokens，首字节／单次总上限为 150／240 秒。终审允许 24,000 completion tokens，首字节／单次总上限为 210／270 秒。三阶段收到数据后连续 90 秒无新数据即中止。首次跨 origin 切换备用免退避，其余重试沿用 15／45 秒。手动直连备用与自动切换均通过 `GITHUB_ENV` 影响同 job 后续进程，主备 Secrets 独立接线。账本未知时停止新增模型调用，仍可使用已验证缓存或候选。终审回退和跳过在 Actions 中告警，已验证的 writer 成品继续进入交付。

## 检查点与故障证据

来源条件请求缓存及按完整模型请求计算的结果缓存使用 Actions cache restore/save；缓存组包含来源配置与解析模块散列，规则变动后不恢复旧解析结果；即使后续模型失败也保存检查点。模型缓存只存已通过校验的结果，重跑时再次校验。来源缓存和模型缓存不写入 Git。Actions cache 的逐出意味着缓存命中不保证，不能作为正确性前提。

工作流依次冻结输入、编辑、写稿、审核至 ready，在阶段边界上传 `news-issue-<kind>-<period>-r<revision>-<run>-<attempt>-<phase>`，保留 14 天。附件上传与缓存步骤设 1 分钟上限和 continue-on-error，缓存保存位于发布之后；附件失败仍可用当前 runner 的合格候选继续发布。恢复验证仓库、main 分支、工作流、身份、规则／模型及文件散列，并检查较新但未保存账本的模型阶段。

失败任务另上传 `state/inputs/` 和 `state/snapshots/` 作为 artifact，保留 14 天。成功任务提交每日采集快照和实际候选，可用于周月报与离线比较。缓存和 artifact 不包含 .env 或密钥。

`state/llm-diagnostics/` 忽略 Git，不从 Actions cache 恢复。每次模型尝试记录开始和结束事件，包括阶段、请求散列、本地 UUID、上游请求／响应标识、HTTP 状态、完成原因、耗时、错误原因链和可用 usage。未收到用量时保留 null；失败原始回答最多保留 200 万字符。诊断及进入公开 `_diagnostics.llm` 的事件在保存前使用同一脱敏处理。

三类工作流末尾使用 `always()` 上传 `news-llm-<kind>-<run>-<attempt>`，保留 14 天，覆盖先失败后恢复成功的尝试。诊断上传设为 `continue-on-error`，避免上传服务故障阻塞已经生成的期刊；Actions 日志也记录结构化事件。上线后仍需实际验证 artifact 和脱敏结果。

相关能力依据 [Actions cache 官方说明](https://github.com/actions/cache) 和 [upload-artifact 官方说明](https://github.com/actions/upload-artifact)，当前候选分别使用 v6 和 v7。配置的运行效果仍需一次获准的线上工作流验证。

## 发布与恢复入口

生成工作流使用 `PIPELINE_UNTIL=prepared／editor／writer／ready`，正式发布由 `node scripts/publish.mjs <kind> --push` 完成。发布器在临时克隆中合并当前 main，只提交刊物、索引／首页和约定的采集状态；Git 认证通过进程环境传递，不覆盖生产工作区，不强推或 rebase。线上核验通过后才写独立收据，已推送但生产仍旧会返回失败，不再调用模型。

手动工作流支持 revision、period、cutoff；固定版本恢复不改变期号和截稿。外部截止调度与通知尚未启用；Vercel redeploy 只有显式 `--redeploy` 且提供受保护的 Deploy Hook 时可请求，三类工作流默认不调用。完整命令、失败含义及权限见 [恢复说明](RECOVERY.md)。

## 发布验收

1. 本地测试通过，检查仅包含本次工程改动。
2. 在可联网环境运行研究源探针，检查必需来源、日期、正文和固定 URL 的版本记录。
3. 使用既有路由运行 low／medium 小额参数探针，再执行隔离日报与周报；记录实际 usage、耗时和失败率。
4. 用固定新快照作模型 A/B，缺失日期的事后重建必须单独标注。旧选中稿不能证明原始候选召回。
5. 完成桌面及手机视觉验收后，取得提交、推送和生产部署授权，再发布并核对线上日期和来源状态。

当前未完成的验收以 ROADMAP.md 为准。

## 早间可读目标及检查点

日报 09:00、周报 15:00、月报 16:00 是北京可读目标，不是平台承诺。GitHub 的 schedule 可排队延迟；Vercel Hobby cron 只保证小时内精度，部署前核对套餐。三类刊物均有 Vercel 主触发和 Actions 错峰补偿，同类型相同截止点的合格归档跳过重建，交付另行确认。周／月同日错开一小时首跑，各自校验归档和恢复账本，彼此成功不作为启动条件。

collection-checkpoint.json 记录逐源水位和待处理原料，成功时随 state 提交；collection-cache.json 保留完整最近采集池，由 Actions cache 保存，恢复时按源合并，不覆盖已提交的更新水位；源站与模型缓存不进 Git。恢复检查点时与原始快照一起使用，不用发布成功时间替代采集水位。首次切换若没有检查点，从此前期刊截止点初始化并记录来源；已有游标不做 7 天截断。

代码 push／PR 只运行 Validate Pipeline 离线测试，不携带生产密钥。生成工作流仅由 schedule、workflow_dispatch 或 repository_dispatch 触发，避免晚间部署改写当天早间期刊。
