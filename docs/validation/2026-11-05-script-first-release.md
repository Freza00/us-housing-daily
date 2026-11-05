# 脚本归栏与双语概览已上线

2026-11-05 16:43，北京时间。用户“提交吧，明天看看 6 号”授权提交、同步开源和上线。

## 发布与验证

已将统一脚本归栏、双语概览／主线和坏卡修复保留合格 metadata 同步开源 main，代码提交 [d5cc9da](https://github.com/Freza00/us-housing-daily/commit/d5cc9dae060479922731b616fdc57db53ce28bed)。发布基线为 77dfb85；使用隔离副本和 24 文件白名单，不覆盖主工作区历史改动。

发布副本 269／269 通过；[GitHub CI](https://github.com/Freza00/us-housing-daily/actions/runs/41996277901) 使用 Node.js v22.23.4，269 项通过、0 失败。[Vercel](https://vercel.com/freza00s-projects/news-agent/2dBUbtZff3LdRFtRMj9xFuSLUj1W) 为 success。首页、新版 app.js、CSS、日报 latest／5 号归档／索引、周月 latest／索引共 10 个线上入口均与发布副本 SHA-256 一致；首页仅升级脚本版本，内嵌内容保持 5 号原 20 条。

5 号 payload 语义散列仍为 e77cd6008025606b6f360cae616591e450480b4477299db8583e864e1138b511。远端 228 个保护文件逐项核对，data／state／CSS 保持，首页仅修改 app 版本；主工作区 304 个非目标起始文件保持。没有新采集、模型请求、手动生成 dispatch 或重签旧冻结附件。

## 6 号观察边界

按既有配置，北京 11 月 6 日 05:00 首触发、09:00 可读目标，另有 Actions 补偿。离线日历探针确认该工作日放行、期号为 2026-11-06；未改调度或新增外部观察器／通知，也不提前生成 6 号。

新语义与双语模型契约仍需 6 号真实自动首跑验证：检查自动出刊、资产和主事件标签、栏目分布、英文摘要／主线及局部修复请求。配置与本地测试通过不等于下一次会准时完成。

本地语义／恢复／语言验收见 [实施记录](2026-11-05-script-first-implementation.md)，生产散列和运行结果见 [发布证据](2026-11-05-script-first-release.json)。
