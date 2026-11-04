# 候选增补与 BTR 标签校验已同步开源并上线

2026-11-05 00:51，北京时间。按用户明确授权，提交 [8cf6579](https://github.com/Freza00/us-housing-daily/commit/8cf6579955cbc6e7ff3fe4b4421601feac06ef09) 并推送开源 main，修复候选空位增补、prepared 冻结前有界补文和 BTR 栏目／资产标签一致性；未改 CI/CD、密钥、调用预算、既有日历及来源配置。

主工作区及隔离发布副本在 5 号当前日期均 255／255，通过[远端 Node.js v22.23.4 CI](https://github.com/Freza00/us-housing-daily/actions/runs/41871352390) 实际 255 项、0 失败。[Vercel](https://vercel.com/freza00s-projects/news-agent/A9CxpKZLC7vb1twEeziPbFuNTFvD) success。

部署后 10 路字节散列与发布副本一致：首页、JS、CSS、日报 latest、4 号归档、日报索引、周报 latest／索引、月报 latest／索引。4 号仍是原 16 条，未重做；新规则未强行迁移旧 r1 或清空账本。原工作区 220 个非目标起始文件保持，生产模型／来源采集请求与手动生成 dispatch 均为 0。

5 号按既有自动流程生成，等待实际候选扩容、BTR 分类与独立资产覆盖、成稿质量、条数、耗时和自动交付验证；不承诺必满 20，也不把本次代码部署成功当作自动出刊成功。未注册新观察器、外部调度或通知。此前自动数据提交缺少部署记录的问题仍单独待查。

本地实现及真实材料离线复验见[修复验收](2026-11-04-candidate-recall-fix.md)，发布结构化证据见[核验结果](2026-11-05-candidate-recall-release.json)。
