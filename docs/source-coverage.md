# 主流研究覆盖与访问限制

本轮定向核对日期为 2026-11-25。共配置 78 个采集入口，其中 47 个为研究类入口；同一机构可以有多个入口。HAR、Zillow、Realtor.com、NAR 为必需监测源。来源集团归属、URL 和限额以 [sources.json](../config/sources.json) 为准。

表中更新过的行标明本轮本机证据。其余行保留 2026-11-18 的逐源观察。该轮累计有 32 个研究入口取得可读材料。不同日期的定向抽样不作为全源成功率，生产 Actions runner 尚待复测。[2026-11-18 采集证据](validation/research-source-health.json)。

| 研究入口 | 采集形式 | 本轮机器观察 | 限制与口径 |
| --- | --- | --- | --- |
| [Mortgage News Daily — Rate Watch](https://www.mortgagenewsdaily.com/rss/rates) | rss | 可读 15 条 | 每日更新美国 30Y／15Y／FHA／Jumbo 按揭利率追踪，带完整发布时间戳与正文（2026-11-18 实测 HTTP 200，正文 3,476 字符）。 |
| [NAHB Eye on Housing](https://eyeonhousing.org/feed/) | undefined | 可读 18 条 | 每次运行继续核对日期、正文和窗口。 |
| [Calculated Risk (Bill McBride)](https://calculatedrisk.substack.com/feed) | rss | 2026-11-25 本机取得有效时间戳及正文 | 2026-11-24 的 FHFA 和 Case-Shiller 样本通过，部分内容仅公开预览。 |
| [Lance Lambert / ResiClub](https://www.resiclubanalytics.com/archive) | html | 2026-11-25 本机取得免费正文及时间戳 | 11 月 25 日免费稿正文 5,321 字符。11 月 23 日 D.R. Horton PRO 稿仅有订阅入口，正文为 0，拒绝送审。 |
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
| [Fannie Mae ESR](https://www.fanniemae.com/data-and-insights/forecast) | html | 2026-11-25 本机 HTTP 403 | 保留官方入口并标记受限。 |
| [Freddie Mac PMMS](https://www.freddiemac.com/pmms) | page | 可读 1 条 | 每次运行继续核对日期、正文和窗口。 |
| [Freddie Mac Research](https://www.freddiemac.com/research-and-perspectives) | html | 可读 7 条 | 2 条缺少可证发布日期；本轮未检出最近 7 天新稿；与 PMMS 合并计算出版机构限额。 |
| [Texas REALTORS Research](https://www.texasrealestate.com/about-us/newsroom) | html | 2026-11-25 本机取得季度新闻稿正文及元数据日期 | Q3 样本使用官网 2026-10-20 的发布时间。PDF 统计期不代替发布日期。 |
| [MetroTex Market Reports](https://www.mymetrotex.com/post-sitemap2.xml) | html／XML | 2026-11-25 本机取得 13 篇带发布日期的官方文章 | 只从详情页读取日期。2026-10-16 发布 9 月市场更新，正文 3,554 字符。 |
| [Unlock MLS Research](https://www.unlockmls.com/news) | html | 未取得材料：This operation was aborted | 每次运行继续核对日期、正文和窗口。 |
| [Harvard JCHS](https://www.jchs.harvard.edu/blog) | html | 2026-11-25 本机 HTTP 403 | 保留官方入口并标记受限。 |
| [Urban Institute Housing Finance](https://www.urban.org/expertise/housing-finance) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [CBRE Research](https://www.cbre.com/services/property-types/multifamily) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [JLL Research](https://www.jll.com/en-us/insights) | html | 可读 14 条 | 6 条缺少可证发布日期；本轮未检出最近 7 天新稿 |
| [Cushman & Wakefield Research](https://www.cushmanwakefield.com/en/united-states/insights/us-marketbeats) | html | 可读 15 条 | 发现目录超过本轮抓取预算 |
| [Colliers Research](https://www.colliers.com/en/research) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [RealPage Analytics](https://www.realpage.com/analytics/feed/) | rss | 可读 1098 条 | 每次运行继续核对日期、正文和窗口。 |
| [NMHC Research](https://www.nmhc.org/research-insight/quarterly-survey/) | html | 2026-11-25 本机取得 10 篇带日期的调查 | October 22, 2026 来自页面标题日期栏，标为 day 精度。 |
| [NAA Research](https://naahq.org/research) | html | 可读 9 条 | 2 条缺少可证发布日期 |
| [ULI/PwC Emerging Trends](https://www.pwc.com/us/en/about-us/newsroom/press-releases/emerging-trends-in-real-estate-2027.html) | page | 2026-11-25 本机 Node 采集取得 2026-10-27 正式发布稿 | 备用为官方新闻室目录。首次 curl 探针返回 403，实际 Node 采集返回 200。 |
| [MSCI Real Assets Research](https://www.msci.com/research-and-insights/paper/rca-commercial-property-price-indexes-rca-cppi) | page | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [John Burns Research](https://jbrec.com/resources/insights/) | html | 2026-11-25 本机 HTTP 520 | 原入口及 `/insights/` 均返回 520，保留原配置并标记受限。 |
| [Northmarq Research](https://www.northmarq.com/insights) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [Berkadia Research](https://www.berkadia.com/multifamily-reports/) | html | 可读 6 条 | 2 条缺少可证发布日期；本轮未检出最近 7 天新稿 |
| [Arbor/Chandan Research](https://arbor.com/research/latest-reports/) | html | 2026-11-25 本机取得带有效时间戳的官方报告摘要 | 只读取同一报告的摘要，区分目录上相邻报告。Q4 小型多户报告 11 月 13 日发布。官方 RSS 备用另有有效样本。 |
| [Newmark Research](https://www.nmrk.com/insights/market-report) | html | 2026-11-25 本机 HTTP 403 | 保留官方入口并标记受限。 |
| [Cotality / CoreLogic Research](https://www.cotality.com/insights/all-insights) | html | 未取得材料：fetch failed (UND_ERR_CONNECT_TIMEOUT) | 每次运行继续核对日期、正文和窗口。 |
| [ICE Mortgage Monitor](https://mortgagetech.ice.com/resources/data-reports) | html | 可读 3 条 | 本轮未检出最近 7 天新稿 |
| [ATTOM Research](https://www.attomdata.com/news/category/market-trends/) | html | 可读 7 条 | 每次运行继续核对日期、正文和窗口。 |
| [MBA Research](https://www.mba.org/news-and-research/newsroom/weekly-applications-survey) | html | 2026-11-25 本机 HTTP 403 | 保留官方入口并标记受限。 |
| [Apartment List Research](https://www.apartmentlist.com/research) | html | 未取得材料：HTTP 403 | 每次运行继续核对日期、正文和窗口。 |
| [CoStar / Apartments.com Research](https://www.apartments.com/grow/learning-center/market-trends) | html | 可读 13 条 | 本轮未检出最近 7 天新稿 |
| [S&P Cotality Case-Shiller](https://press.spglobal.com/index.php?l=50&s=2429) | html | 可读 4 条 | 已抓到 10 月 27 日发布的 8 月指数报告；发布日期与统计月份分开。 |
| [Zonda Research](https://zondahome.com/new-home-market-update/) | page | 可读 1 条 | 公开固定更新页：10 月 22 日发布，数据对应 9 月。 |
| [Zonda Lot Supply Index](https://zondahome.com/new-home-lot-supply-index-2/) | page | 可读 1 条 | 本轮未检出最近 7 天新稿；公开固定更新页：8 月 13 日发布，数据对应第二季度；本轮无最近 7 天新稿。 |

## 本轮新闻源定向复核

- South Florida Agent Magazine 和 BTR List 的官方入口通过本机严格抽样。BTR List 两条公开正文分别有 3,122 和 2,859 字符，采集路径已切到出版商。The Real Deal National RSS 在本机通过，历史 Actions 观测曾失败。[South Florida Agent Magazine](https://southfloridaagentmagazine.com/feed/) · [BTR List](https://news.btrlist.com/archive) · [The Real Deal](https://therealdeal.com/national/feed/)。
- Inman 与 Multi-Housing News 出版商 RSS 均返回 403，已撤除聚合备用。六个 Houston／Dallas／Austin Business Journal 直连频道均返回 403，和两个 Google News 主题源一同保留为仅发现。PEI 新站能采到有日期的线索，但本轮抽样正文容器为空，标为受限。[Inman](https://www.inman.com/feed/) · [Multi-Housing News](https://www.multihousingnews.com/feed/) · [PERE 新站](https://www.pei-privaterealestate.com/)。
- SEC 两个主入口本机可读，样本为有日期的申报索引。Invitation Homes 和 AMH 两条公司 IR 备用也通过正文及日期的独立抽样。主 SEC 失败而官方 IR 可用时，面板记录首错与回退，不因回退本身降级。[Invitation Homes IR](https://www.invh.com/rss/PressRelease.aspx?LanguageId=1) · [AMH IR](https://investors.amh.com/rss/PressRelease.aspx?LanguageId=1)。

## 覆盖规则

必需监测源在每次生产采集中都尝试读取，检查结果随期刊保存；失败和历史区间缺证据时明确标记 degraded。有效新研究享有候选机会，但不强行刊登每个机构，也不把“没有新稿”和“抓取失败”混为一谈。目录超过预算、发布日期未知、正文不完整、公开预览分别记录。HTTP 403 和付费内容不绕过权限。

三刊共用正文资格校验，聚合外壳、正文不足和订阅占位均不送编辑。仅发现源不占用 72 次补文预算。脚本按出版集团分配候选机会。同一集团通常最多刊登 3 条；必需来源的重大原始研究可额外 1 条，必须记录原因。Harvard、Urban、经纪商研究、全国住宅数据、德州地方研究及 BTR／多户住宅分别有入口，但这些配置不能证明互联网所有重大研究已无遗漏。

## 时间与证据

报告发布日期、统计期与首次发现时间分开保存。固定更新页通过发布日期和正文散列识别版本；旧日期下正文变动列为待核实，不冒充当天报告。只有日期的材料按美东日期落窗，保留 day 精度，页面不显示猜测的具体小时。公开 PDF 使用 pdftotext 提取；只能读取预览时在页面标识证据范围。

HAR 倒序目录已核对，可在取到两个以上有序日期并跨过下界后停止；无已验证排序约定的目录不使用此捷径。周月报优先使用每日完整采集快照，不仅汇总旧日报入选稿。10 月停更期间没有原始时点快照，回溯材料只作为事后重建，不能证明当时完整召回。

## 来源巡检口径

`validate-sources.mjs --enrich` 逐源补取最近两篇，并在可用时保留无日期、正文不足或详情失败样本。`--strict` 需要至少一份有可证日期和合格正文的样本，拒绝聚合入口和全无日期的目标；普通模式校验全局及栏目必需源。观测原件可写入 `.tmp/source-audit/`。

多期体检按唯一期号合并归档、原始快照与冻结输入。旧档无首错时使用 `unknown`，正文淘汰仅统计能归属的旧记录，不能归属的数量另列。高正文淘汰为至少 2 条且占已见证据 50% 或以上。连续零刊出观察阈值分为高频 3 期、低频 12 期、未知频率 6 期；该统计仍需结合实际更新周期及选稿。源站能否由生产 Actions runner 取到同样正文和日期仍待复测。
