# 地域校验修复与 6 号补发已上线

2026-11-06 10:13，北京时间。用户“上线，更新”授权提交、同步开源和生产发布。

## 发布结果

按既定顺序，先以旧兼容规则发布 [6 号数据 0716b4c](https://github.com/Freza00/us-housing-daily/commit/0716b4ca3874de79be2b84a0af3cb27345150bd3)，首页、latest、归档和索引四路确认一致；其 [Vercel 部署](https://vercel.com/freza00s-projects/news-agent/7aYicXu63NauhdGJ5b3Hun66yaNm) 为 success。随后提交并同步 [通用修复 2e91563](https://github.com/Freza00/us-housing-daily/commit/2e91563465ba1765e073c5e2247b5040602427ed)，其 [Vercel 部署](https://vercel.com/freza00s-projects/news-agent/3BpMcdSa5vC2irPGqyQJRf9B9sdo) 也为 success。未给旧附件改规则散列。

[GitHub CI](https://github.com/Freza00/us-housing-daily/actions/runs/42148592614) 使用 Node.js v22.23.4，282 项通过、0 失败；发布副本本地也为 282／282。代码提交严格采用 13 个工程／文档文件白名单，386 个非目标远端文件逐项散列保持，原工作区 312 个非目标起始文件保持。

代码部署后再次检查首页／app.js／CSS、日报 latest／6 号归档／5 号归档／日期索引、周月 latest／索引共 11 个入口，全部与发布副本 SHA-256 一致。首页内嵌数据与已验收的 6 号 r1 payload 一致，20 条、包含 1 条 BTR；payload 散列仍为 223c80b9c01057b634b3b9b713e704e129c9a589c9b914370406243637c2550a。5 号和周月旧刊保持。

## 修复及恢复边界

本轮发布没有新采集、模型请求或手动生成 dispatch。此前恢复仅新增 writer 1 次、零新增 editor，原 3 笔 editor、r1／截止点／规则和 269859／660000 毫秒预算保持；发布后再次核对恢复 manifest 散列未变。

本次是 09:00 目标之后的人工恢复，不记为准时自动出刊。新规则后续自动运行、上游流稳定性及连续出刊仍待观察；未增加重试额度、外部调度或通知。内部 complete 不代表全部来源成功，本期来源 64／77 正常，页面与诊断保留实际缺口。

最小地域比较修复、Astra-max 审查、真实原回答回放、双语及本地页面验收见 [修复与候选记录](2026-11-06-geography-fix-and-recovery.md)。生产提交、CI、收据和线上散列见 [发布数据](2026-11-06-geography-release.json)。
