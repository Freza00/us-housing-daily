# 主流研究覆盖与访问限制

核对日期：2026-10-28。共配置 77 个采集入口，其中 46 个为研究类入口；同一机构可以有多个入口。HAR、Zillow、Realtor.com、NAR 为必需监测源。来源集团归属、URL 和限额以 [sources.json](../config/sources.json) 为准。

本机机器采集测试累计取得 31 个研究入口的可读材料，另 15 个遇到 403、超时或目录空结果。逐项记录见 [采集证据](validation/research-source-health.json)。这是一次完整探针加修复后的定向复验所得的各源最近观察，不能理解为同一时刻的全源成功率，也不是 GitHub runner 的访问结果。“可读”只代表取得至少一份材料，不证明材料新鲜、发布日期完整或历史覆盖完整。

| 研究入口 | 采集形式 | 本轮机器观察 | 限制与口径 |
| --- | --- | --- | --- |
| [NAHB Eye on Housing](https://eyeonhousing.org/feed/) | undefined | 可读 18 条 | 每次运行继续核对日期、正文和窗口。 |
| [Calculated Risk (Bill McBride)](https://feeds.feedburner.com/CalculatedRisk) | undefined | 可读 25 条 | 本轮未检出最近 7 天新稿；该旧 feed 最近内容停留在 2026 年 1 月；可读不代表仍在更新。 |
| [Lance Lambert / ResiClub](https://lancelambert.substack.com/feed) | undefined | 可读 59 条 | 订阅内容只使用公开正文或预览。 |
| [Logan Mohtashami (HousingWire)](https://www.housingwire.com/author/logan-mohtashami/feed/) | undefined | 可读 10 条 | 与 HousingWire 合并计算出版机构限额。 |
| [Yardi Matrix Blog](https://www.yardimatrix.com/publications/) | html | 可读 3 条 | 本轮未检出最近 7 天新稿；部分全文需登记，只使用公开内容。 |
| [Realtor.com Research](https://www.realtor.com/research/feed/)（必需） | undefined | 可读 10 条 | 每次运行继续核对日期、正文和窗口。 |
| [Redfin News](https://www.redfin.com/news/feed/) | undefined | 可读 6 条 | 每次运行继续核对日期、正文和窗口。 |
| [Texas Real Estate Research Center (TRERC)](https://trerc.tamu.edu/texas-housing-insight/) | html | 可读 18 条 | 发现目录超过本轮抓取预算 |
| [Brookings Institution](https://www.brookings.edu/topics/housing/) | html | 可读 1 条 | 本轮未检出最近 7 天新稿 |
| [HAR Research](https://www.har.com/content/department/newsroom?pid=640)（必需） | html | 可读 4 条 | 按已核实倒序跨过日期下界停止；保留 pid 参数；已核对目录倒序，抓过窗口下界后停止。 |
| [Zillow Research](https://www.zillow.com/research/feed/)（必需） | rss | 可读 10 条 | 每次运行继续核对日期、正文和窗口。 |
| [NAR Research](https://www.nar.realtor/research-and-statistics/research-reports/research-update)（必需） | html | 可读 13 条 | 本轮未检出最近 7 天新稿；追踪统计目录到新闻稿；本轮能读到材料不等于窗口内存在新报告。 |
| [Census New Residential Construction](https://www.census.gov/construction/nrc/current/index.html) | page | 可读 1 条 | 本轮未检出最近 7 天新稿；固定更新页，分别保留发布日期与统计期。 |
| [Census New Residential Sales](https://www.census.gov/construction/nrs/current/index.html) | page | 可读 1 条 | 固定更新页，与 Census construction 合并计算出版机构限额。 |
| [FHFA House Price Index](https://www.fhfa.gov/data/hpi) | html | 可读 1 条 | 每次运行继续核对日期、正文和窗口。 |
| [Fannie Mae ESR](https://www.fanniemae.com/data-and-insights/forecast) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Freddie Mac PMMS](https://www.freddiemac.com/pmms) | page | 可读 1 条 | 每次运行继续核对日期、正文和窗口。 |
| [Freddie Mac Research](https://www.freddiemac.com/research-and-perspectives) | html | 可读 7 条 | 2 条缺少可证发布日期；本轮未检出最近 7 天新稿；与 PMMS 合并计算出版机构限额。 |
| [Texas REALTORS Research](https://www.texasrealestate.com/research/quarterly-housing-report) | html | 可读 9 条 | 9 条缺少可证发布日期；发现目录超过本轮抓取预算；本轮未检出最近 7 天新稿；部分季度入口复用 PDF，必须以文内统计期为准；没有可证日期的条目不进入当日候选。 |
| [MetroTex Market Reports](https://www.mymetrotex.com/market-reports/) | html | 可读 17 条 | 17 条缺少可证发布日期；发现目录超过本轮抓取预算；本轮未检出最近 7 天新稿 |
| [Unlock MLS Research](https://www.unlockmls.com/news) | html | 未取得材料：This operation was aborted | 每次运行继续核对日期、正文和窗口。 |
| [Harvard JCHS](https://www.jchs.harvard.edu/blog) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Urban Institute Housing Finance](https://www.urban.org/expertise/housing-finance) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [CBRE Research](https://www.cbre.com/services/property-types/multifamily) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [JLL Research](https://www.jll.com/en-us/insights) | html | 可读 14 条 | 6 条缺少可证发布日期；本轮未检出最近 7 天新稿 |
| [Cushman & Wakefield Research](https://www.cushmanwakefield.com/en/united-states/insights/us-marketbeats) | html | 可读 15 条 | 发现目录超过本轮抓取预算 |
| [Colliers Research](https://www.colliers.com/en/research) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [RealPage Analytics](https://www.realpage.com/analytics/feed/) | rss | 可读 1098 条 | 每次运行继续核对日期、正文和窗口。 |
| [NMHC Research](https://www.nmhc.org/research-insight/quarterly-survey/) | html | 可读 10 条 | 10 条缺少可证发布日期；本轮未检出最近 7 天新稿；部分调查嵌入 iframe；日期未知不作新报告。 |
| [NAA Research](https://naahq.org/research) | html | 可读 9 条 | 2 条缺少可证发布日期 |
| [ULI/PwC Emerging Trends](https://www.pwc.com/us/en/about-us/newsroom/press-releases.html) | html | 未取得材料：Directory contained no matching links | 静态入口没有匹配报告链接；仍保留官方入口并记录失败，不拿导航页冒充正文。 |
| [MSCI Real Assets Research](https://www.msci.com/research-and-insights/paper/rca-commercial-property-price-indexes-rca-cppi) | page | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [John Burns Research](https://jbrec.com/resources/insights/) | html | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [Northmarq Research](https://www.northmarq.com/insights) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Berkadia Research](https://www.berkadia.com/multifamily-reports/) | html | 可读 6 条 | 2 条缺少可证发布日期；本轮未检出最近 7 天新稿 |
| [Arbor/Chandan Research](https://arbor.com/research/reports/) | html | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [Newmark Research](https://www.nmrk.com/insights/market-report) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Cotality / CoreLogic Research](https://www.cotality.com/insights/all-insights) | html | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [ICE Mortgage Monitor](https://mortgagetech.ice.com/resources/data-reports) | html | 可读 3 条 | 本轮未检出最近 7 天新稿 |
| [ATTOM Research](https://www.attomdata.com/news/category/market-trends/) | html | 可读 7 条 | 每次运行继续核对日期、正文和窗口。 |
| [MBA Research](https://www.mba.org/news-and-research/newsroom/weekly-applications-survey) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Apartment List Research](https://www.apartmentlist.com/research) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [CoStar / Apartments.com Research](https://www.apartments.com/grow/learning-center/market-trends) | html | 可读 13 条 | 本轮未检出最近 7 天新稿 |
| [S&P Cotality Case-Shiller](https://press.spglobal.com/index.php?l=50&s=2429) | html | 可读 4 条 | 已抓到 10 月 27 日发布的 8 月指数报告；发布日期与统计月份分开。 |
| [Zonda Research](https://zondahome.com/new-home-market-update/) | page | 可读 1 条 | 公开固定更新页：10 月 22 日发布，数据对应 9 月。 |
| [Zonda Lot Supply Index](https://zondahome.com/new-home-lot-supply-index-2/) | page | 可读 1 条 | 本轮未检出最近 7 天新稿；公开固定更新页：8 月 13 日发布，数据对应第二季度；本轮无最近 7 天新稿。 |

## 覆盖规则

必需监测源在每次生产采集中都尝试读取，检查结果随期刊保存；失败和历史区间缺证据时明确标记 degraded。有效新研究享有候选机会，但不强行刊登每个机构，也不把“没有新稿”和“抓取失败”混为一谈。目录超过预算、发布日期未知、正文不完整、公开预览分别记录。HTTP 403 和付费内容不绕过权限。

候选先由脚本规范 URL、识别重复、按出版集团分配预算，最多 72 条交给模型。同一集团通常最多刊登 3 条；必需来源的重大原始研究可额外 1 条，必须记录原因。Harvard、Urban、经纪商研究、全国住宅数据、德州地方研究及 BTR／多户住宅分别有入口，但这些配置不能证明互联网所有重大研究已无遗漏。

## 时间与证据

报告发布日期、统计期与首次发现时间分开保存。固定更新页通过发布日期和正文散列识别版本；旧日期下正文变动列为待核实，不冒充当天报告。只有日期的材料按美东日期落窗，保留 day 精度，页面不显示猜测的具体小时。公开 PDF 使用 pdftotext 提取；只能读取预览时在页面标识证据范围。

HAR 倒序目录已核对，可在取到两个以上有序日期并跨过下界后停止；无已验证排序约定的目录不使用此捷径。周月报优先使用每日完整采集快照，不仅汇总旧日报入选稿。10 月停更期间没有原始时点快照，回溯材料只作为事后重建，不能证明当时完整召回。

## 仍需后续处理

15 个不可读入口保留健康状态；如持续失败，应选择机构允许的官方 RSS、公开报告直链或订阅交付方式，再单独实测。Calculated Risk 旧 feed 已陈旧，应另核实其现行公开发布入口；不将其可读状态计作持续有效更新。首次发布后还须在实际 Actions runner 检查访问差异和时区触发行为。
