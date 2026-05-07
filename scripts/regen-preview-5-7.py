#!/usr/bin/env python3
"""一次性脚本 — 用 sample-output.json 重新生成 preview.html (5-7 版)"""
import json, html as h, re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = json.load(open(os.path.join(ROOT, 'sample-output.json')))

# 5-7 全部 20 条手写中文摘要 + imp + dir（URL 精确匹配 sample-output.json）
HW = {
    # === 🏠 全国住宅市场 ===
    'https://www.cnbc.com/video/2026/05/06/zillow-ceo-jeremy-wacksman-affordability-is-still-a-challenge-in-the-housing-market.html': {
        'title_zh': 'Zillow CEO Jeremy Wacksman：affordability 仍是 housing market 核心挑战',
        'summary': 'Zillow CEO 上 CNBC Closing Bell — Q1 业绩 + housing market 现状；mortgage rate 边际松动但购买力仍受压。',
        'imp': 4, 'dir': 'short-neg'},
    'https://www.housingwire.com/articles/jason-waugh-hsf-affiliates-ceo/': {
        'title_zh': 'HomeServices 任命 Jason Waugh 为 HSF Affiliates 下任 CEO',
        'summary': 'HSF Affiliates 现任 CEO Vince Leisey 将于 2027 卸任 — 全美第二大住宅经纪平台领导层换届。',
        'imp': 3, 'dir': 'neutral'},
    'https://www.housingwire.com/articles/colorado-zoning-preemption-limits/': {
        'title_zh': 'Colorado 州 zoning preemption 立法受挫 — 小宗地 single-family 改革停滞',
        'summary': '州议会拟强制城市允许 2,000 SF 小宗地 single-family — 因地方政府阻力本届会期未通过；affordability 改革遭遇瓶颈。',
        'imp': 4, 'dir': 'long-neg'},
    'https://www.bisnow.com/national/news/commercial-real-estate/commercial-property-prices-fall-april-still-up-yoy-134456': {
        'title_zh': 'Commercial Property Prices 4 月环比下跌、YoY 仍 +3.1%',
        'summary': 'CPPI all-property index 4 月小幅回落 — 年比仍 +3.1%；CRE 反弹力度不均、月度震荡明显。',
        'imp': 3, 'dir': 'short-neg'},
    'https://www.bisnow.com/houston/news/construction-development/satya-breaks-ground-st-regis-residences-houston-134462': {
        'title_zh': 'Houston 开发商 Satya 动工 St. Regis Residences — 已售出过半',
        'summary': '高端 lock-and-leave 公寓 — 开发商表态 affordability 不是千万级买家问题；分层市场分化加剧。',
        'imp': 2, 'dir': 'neutral'},
    'https://www.realtor.com/news/trends/high-gas-prices-commuter-tax-homebuyers/': {
        'title_zh': 'Gas prices 上行 → "commute tax" 收缩购房搜索半径',
        'summary': '1.15 亿驾车人受油价冲击 — 远郊 / 通勤型社区需求边际走弱，Sun Belt 远郊新房承压。',
        'imp': 3, 'dir': 'short-neg'},

    # === 🌵 Sunbelt 住宅 ===
    'https://www.multifamilydive.com/news/maa-q1-earnings-sun-belt/819470/': {
        'title_zh': 'MAA Q1 业绩：Sun Belt rent growth 拐点显现',
        'summary': 'Mid-America Apartment Communities (Memphis 总部) — Q1 早期 rent pricing 复苏信号；预计 peak leasing 旺季动能更强。',
        'imp': 5, 'dir': 'long-pos'},
    'https://www.housingwire.com/articles/reverse-mastermind-summit-leadership-sales/': {
        'title_zh': 'Reverse Mastermind Summit (Knoxville, TN)：女性接管反向按揭行业领导',
        'summary': '三位女性高管在 reverse mortgage 行业峰会分享 sales 经验 — 行业领导结构变化。',
        'imp': 2, 'dir': 'neutral'},
    'https://www.realtor.com/news/trends/texas-homeowners-sue-spacex-sonic-booms-property-damage/': {
        'title_zh': '150+ TX 业主集体诉讼 SpaceX — sonic booms 损坏房产',
        'summary': 'Boca Chica 周边业主提两宗诉讼 — Sun Belt 制造业巨投带来邻里赔付风险敞口。',
        'imp': 2, 'dir': 'neutral'},
    'https://www.dmagazine.com/sponsored/2026/05/face-of-residential-real-estate-2/': {
        'title_zh': 'D Magazine sponsored — Bray Real Estate Group 创始人 Chase Bray',
        'summary': 'DFW 经纪人物特写（sponsored content）— 公司在 North Dallas 扩张新办公室。',
        'imp': 1, 'dir': 'neutral'},
    'https://www.realtor.com/news/real-estate-news/ken-griffin-zohran-mamdani-tax-rich-second-home/': {
        'title_zh': '亿万富翁 Ken Griffin 因 pied-à-terre 税威胁把投资从 NYC 转去 Miami',
        'summary': 'NYC 市长 Mamdani 视频抨击富人豪宅 — Griffin 公开放话迁移投资；Sun Belt 富裕迁徙叙事再起。',
        'imp': 3, 'dir': 'long-pos'},

    # === 🏘 全国 BTR / SFR ===
    'https://www.housingwire.com/articles/atlanta-build-to-rent-surge/': {
        'title_zh': 'Atlanta BTR / SFR 大爆发 — 机构投资者持有 SFR 市场 30%',
        'summary': '大型机构持有 Atlanta SFR 市场约 30% — 是全国均值的 10 倍；Sun Belt 龙头从原型期进入主流期。',
        'imp': 5, 'dir': 'long-pos'},

    # === 🏢 全国 CRE ===
    'https://www.yardimatrix.com/blog/pipeline-prompts-revised-multifamily-completions-forecast/': {
        'title_zh': 'Yardi Matrix 上调 2026 multifamily completions 预测 +2%',
        'summary': '在建 pipeline 超预期 — 季度 supply forecast 较 Q1 上修 2%；2026 multifamily 新增供给曲线上行。',
        'imp': 4, 'dir': 'short-neg'},
    'https://therealdeal.com/national/denver/2026/05/06/giant-group-worlds-biggest-bike-maker-moves-hq-to-boulder/': {
        'title_zh': 'Giant Group US HQ 落户 Boulder — 签 44K SF 10 年租约',
        'summary': '全球最大自行车厂 Giant Group US 子公司迁 Boulder — 3825 Walnut Street 44K SF；丹佛 office 需求小幅利好。',
        'imp': 2, 'dir': 'short-pos'},
    'https://therealdeal.com/national/2026/05/06/colliers-branded-tic-deals-spark-state-federal-probes/': {
        'title_zh': 'Colliers 品牌 TIC 交易遭州 / 联邦调查',
        'summary': 'Utah sponsor Millcreek Commercial 旗下 TIC (tenant-in-common) 交易被指对退休投资者销售高风险产品 — CRE 中介品牌合规风险敞口扩大。',
        'imp': 4, 'dir': 'long-neg'},
    'https://rebusinessonline.com/town-lane-gillon-property-acquire-460000-sf-retail-office-property-in-allen-texas/': {
        'title_zh': 'Town Lane + Gillon Property 收购 Allen, TX 的 460K SF retail / office 综合体',
        'summary': 'NYC + DFW 投资合伙人收购 Watters Creek Village (2008 年建、46 英亩) — DFW 东北郊综合体大宗交易。',
        'imp': 3, 'dir': 'short-pos'},
    'https://www.connectcre.com/stories/apartment-management-consultants-rolls-out-prisma-residential-portal-across-portfolio/': {
        'title_zh': 'AMC 在 900+ 多户物业全面部署 Prisma Prop Tech 资管平台',
        'summary': 'Apartment Management Consultants 选择 Prisma 作为 resident portal + payments 平台 — multifamily PropTech 渗透加速。',
        'imp': 2, 'dir': 'neutral'},

    # === 💰 全国机构资本 ===
    'https://www.bisnow.com/austin/news/ai/spacex-plans-to-spend-an-initial-55b-for-terafab-chip-facility-in-texas-134459': {
        'title_zh': 'SpaceX 拟初投 $55B 在 Houston 西北建首期 Terafab 芯片厂',
        'summary': '$55B 制造业巨型投资 (Houston 北 1 小时车程) — 长期带动 Sun Belt 住宅 / multifamily 需求结构性上行。',
        'imp': 5, 'dir': 'long-pos'},
    'https://www.perenews.com/2910-north-arthur-ashe-boulevard-richmond-former-greyhound-bus-station-set-for-multifamily-transformation/': {
        'title_zh': 'Richmond 前 Greyhound 巴士站改造为 multifamily + retail 综合体',
        'summary': '2910 North Arthur Ashe Blvd 站点 adaptive reuse — 多户公寓 + 零售配套；机构资本下沉二线城市改造资产。',
        'imp': 2, 'dir': 'short-pos'},
    'https://www.sec.gov/Archives/edgar/data/1562401/000156240126000028/0001562401-26-000028-index.htm': {
        'title_zh': 'AMH (American Homes 4 Rent) 8-K — Q1 业绩当日 SEC 披露',
        'summary': 'Item 2.02 Results of Operations + 9.01 Financial Statements — 头部 SFR REIT 季报当日 SEC filing；详细数据待 transcript。',
        'imp': 4, 'dir': 'neutral'},

    # 新进的 5-7 item（之前 dry-run 没出现的）
    'https://therealdeal.com/national/boston/2026/05/06/boston-area-school-sells-campus-for-luxury-development/': {
        'title_zh': 'Boston 大学出售半个校园用于 luxury 住宅开发',
        'summary': 'Boston 区域高校剥离闲置校园资产 — 高端住宅 adaptive reuse；高校资产货币化趋势。',
        'imp': 3, 'dir': 'neutral'},
    'https://www.bisnow.com/atlanta/news/neighborhood/while-a-media-mogul-ted-turner-also-made-his-downtown-atlanta-cre-mark-134464': {
        'title_zh': 'Ted Turner 离世，享年 87 — Atlanta CRE 时代标志人物',
        'summary': 'CNN 创始人 Ted Turner 在 downtown Atlanta CRE 留下深刻烙印 — 行业悼念，无即时市场影响。',
        'imp': 2, 'dir': 'neutral'},
    'https://therealdeal.com/national/2026/05/06/starwood-capital-faces-default-on-265m-hotel-portfolio/': {
        'title_zh': 'Starwood Capital 旗下 $265M hotel 资产组合贷款违约',
        'summary': '$265M 酒店组合 mortgage 进入违约程序 — 酒店 CRE 流动性紧张，再添一例机构级压力。',
        'imp': 4, 'dir': 'long-neg'},
    'https://www.redfin.com/news/hottest-neighborhood-2026/': {
        'title_zh': 'Land O\' Lakes, FL — Redfin 2026 全美最热社区 (Top-10)',
        'summary': 'Tampa 北郊 Land O\' Lakes 居 Redfin 2026 全美最热社区榜首 — Sun Belt 远郊 single-family 需求持续涌入。',
        'imp': 3, 'dir': 'long-pos'},
}

def fb(it):
    return {'title_zh': it['title'][:30] + '（中文译标待 LLM 生成）',
            'summary': '（中文摘要待 LLM 生成 — 5-7 新数据，preview 未手写）',
            'imp': 3, 'dir': 'neutral'}

TAG_LABEL = {'housing':'住宅市场','multifamily':'多户','btr-sfr':'BTR/SFR','office':'办公','industrial':'工业','data-center':'数据中心','retail':'零售','hotel':'酒店','mixed-asset':'跨资产','texas':'德州','dfw':'DFW','houston':'Houston','austin':'Austin','sun-belt':'Sun Belt','nyc':'NYC','california':'California','policy':'政策','rates':'利率','macro':'宏观','deals':'交易','data':'数据','trend':'趋势','earnings':'业绩','institutional':'机构','homebuilder':'建造商','landlord':'业主','brokerage':'经纪','regulator':'监管'}
TAG_DIM = {**{a:'asset' for a in ['housing','multifamily','btr-sfr','office','industrial','data-center','retail','hotel','mixed-asset']}, **{g:'geo' for g in ['texas','dfw','houston','austin','sun-belt','nyc','california']}, **{t:'topic' for t in ['policy','rates','macro','deals','data','trend','earnings']}, **{x:'actor' for x in ['institutional','homebuilder','landlord','brokerage','regulator']}}
HEAT_TAGS = {'btr-sfr','texas','dfw','houston','austin','sun-belt','institutional','policy','rates'}
DIM_ORDER = ['asset','geo','topic','actor']
SEC_DESC = {'national':'全国住宅市场、宏观利率、政策、NAR / Realtor / Zillow / Calculated Risk',
            'sunbelt':'Sun Belt 各州住宅与租赁市场 — 至少一条德州三城',
            'btr':'Build-to-Rent / Single-Family Rental — 至少一条德州三城',
            'cre':'办公 / 工业 / 数据中心 / 仓储 / 多户 / 酒店等 CRE — 至少一条德州三城',
            'institutional':'PE / REIT 募资、并购、IPO、机构持仓 — 至少一条德州三城'}
IMPACT = {'long-pos':('长期利好','imp-lp'), 'short-pos':('短期利好','imp-sp'),
          'neutral':('中性','imp-n'), 'short-neg':('短期利空','imp-sn'), 'long-neg':('长期利空','imp-ln')}

def stars(n):
    n = max(1, min(5, int(n)))
    return '★'*n + '☆'*(5-n)

def time_ago(p, now):
    if not p: return ''
    d = (now - p) / 1000
    hh = int(d/3600)
    if hh < 1: return f'{int(d/60)}m ago'
    if hh < 24: return f'{hh}h ago'
    return f'{int(hh/24)}d ago'

def render_tags(tags, sub):
    sids = sorted([t for t in tags if t in TAG_LABEL], key=lambda t: (DIM_ORDER.index(TAG_DIM[t]), t))
    chips = []
    if sub:
        chips.append(f'<span class="card-tag cre-cat">{sub}</span>')
    for t in sids[:6]:
        c = f'card-tag tag-{TAG_DIM[t]}' + (' heat' if t in HEAT_TAGS else '')
        chips.append(f'<span class="{c}">{TAG_LABEL[t]}</span>')
    return '\n      '.join(chips)

def render_card(it, n, now):
    info = HW.get(it['link'], fb(it))
    txt, cls = IMPACT[info['dir']]
    ext = '<span class="ext-pill">扩窗</span>' if it.get('extended_window') else ''
    tags = render_tags(it.get('tags', []), it.get('cre_subcategory'))
    return f'''  <article class="card">
    <a class="card-link" href="{h.escape(it['link'])}" target="_blank" rel="noopener">
      <div class="card-title-zh"><span class="card-num">{n}</span>{h.escape(info['title_zh'])}</div>
      <h2 class="card-title">{h.escape(it['title'])}</h2>
    </a>
    <p class="card-summary">{h.escape(info['summary'])}</p>
    <div class="card-meta">
      <span class="card-stars">{stars(info['imp'])}</span>
      <span class="impact-pill {cls}">{txt}</span>
      {ext}
      <span class="card-source">{h.escape(it['source_name'])}</span><span>{time_ago(it.get('published_at'), now)}</span>
      {tags}
    </div>
  </article>'''

# 按 section 分组
secs = {}
for it in data['items']:
    secs.setdefault(it['section'], []).append(it)

# 渲染
blocks = []
n = 0
for sec in data['sections']:
    items = secs.get(sec['id'], [])
    if items:
        cards = []
        for it in items:
            n += 1
            cards.append(render_card(it, n, data['generated_at']))
        body = '\n\n'.join(cards)
    else:
        body = '  <p class="section-empty">今日 24h 内无新内容</p>'
    blocks.append(f'''<!-- {sec["emoji"]} {sec["label"]} -->
<section class="news-section">
  <header class="section-head">
    <span class="section-emoji">{sec["emoji"]}</span><h3 class="section-label">{sec["label"]}</h3>
    <span class="section-desc">{SEC_DESC.get(sec["id"], "")}</span>
  </header>

{body}
</section>''')

# 重新生成 preview.html
orig = open(os.path.join(ROOT, 'preview.html'), encoding='utf-8').read()

# 替换 main
new_main = '<main class="news-list">\n\n' + '\n\n'.join(blocks) + '\n</main>'
new_html = re.sub(r'<main[\s\S]*?</main>', lambda m: new_main, orig, count=1)

# 替换 header tagline & meta
new_html = re.sub(
    r'<span class="tagline">[^<]*</span>',
    '<span class="tagline">美国住宅地产每日 20 条</span>',
    new_html, count=1)
new_html = re.sub(
    r'<div class="meta">[^<]*</div>',
    '<div class="meta">2026-05-07 · 24h 窗内 121 候选 → 实体级去重 109 → top 20</div>',
    new_html, count=1)

# 替换 datestrip — 5-7 周四 active
strip_new = '''<nav class="datestrip">
  <button class="ds-day" disabled><span class="ds-wd">五</span><span class="ds-num">24</span></button>
  <button class="ds-day" disabled><span class="ds-wd">六</span><span class="ds-num">25</span></button>
  <button class="ds-day" disabled><span class="ds-wd">日</span><span class="ds-num">26</span></button>
  <button class="ds-day" disabled><span class="ds-wd">一</span><span class="ds-num">27</span></button>
  <button class="ds-day" disabled><span class="ds-wd">二</span><span class="ds-num">28</span></button>
  <button class="ds-day" disabled><span class="ds-wd">三</span><span class="ds-num">29</span></button>
  <button class="ds-day" disabled><span class="ds-wd">四</span><span class="ds-num">30</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">五</span><span class="ds-num">1</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">六</span><span class="ds-num">2</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">日</span><span class="ds-num">3</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">一</span><span class="ds-num">4</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">二</span><span class="ds-num">5</span></button>
  <button class="ds-day ds-has"><span class="ds-wd">三</span><span class="ds-num">6</span></button>
  <button class="ds-day ds-has ds-today ds-active"><span class="ds-wd">四</span><span class="ds-num">7</span></button>
  <button class="ds-more">更早</button>
</nav>'''
new_html = re.sub(r'<nav class="datestrip">[\s\S]*?</nav>',
                  lambda m: strip_new, new_html, count=1)

open(os.path.join(ROOT, 'preview.html'), 'w', encoding='utf-8').write(new_html)
print(f'preview.html updated for 5-7')
print(f'sections: {[(s["label"], len(secs.get(s["id"], []))) for s in data["sections"]]}')
