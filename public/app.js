// 前端主逻辑 — 单文件，无依赖
// 数据：/data/latest.json + /data/YYYY-MM-DD.json + /data/dates.json (静态 JSON, GitHub Actions cron 生成)

const $ = (id) => document.getElementById(id);
const newsList = $('newsList');
const filterbar = $('filterbar');
const datestrip = $('datestrip');
const updatedEl = $('updated');
// 注意：不要缓存 #sourcesCount DOM 引用 — applyLanguage() 会重写 #sourcesInfo 的 innerHTML，
// 销毁原 span。每次写值时 freshly query 才能命中实时 DOM 节点。
const refreshBtn = $('refreshBtn');
const langSeg = $('langSeg');
const calendarDialog = $('calendarDialog');
const calGrid = $('calGrid');
const calTitle = $('calTitle');
const calPrev = $('calPrev');
const calNext = $('calNext');
const calClose = $('calClose');
const digestTabs = $('digestTabs');
const windowBanner = $('windowBanner');
const themesBlock = $('themesBlock');

let currentMode = 'daily'; // 'daily' | 'weekly' | 'monthly'

function digestDataUrl(mode, period) {
  // `period` is optional: weekly = "YYYY-MM-DD" period_start, monthly = "YYYY-MM" label.
  // Without period, return /latest.json which always points to the most recent published period.
  if (mode === 'weekly')  return period ? `/data/weekly/${period}.json`  : '/data/weekly/latest.json';
  if (mode === 'monthly') return period ? `/data/monthly/${period}.json` : '/data/monthly/latest.json';
  return period ? `/data/${encodeURIComponent(period)}.json` : '/data/latest.json';
}

function initialMode() {
  const h = (location.hash || '').replace('#', '');
  return ['weekly', 'monthly'].includes(h) ? h : 'daily';
}

// ========== i18n ==========
const I18N = {
  zh: {
    tagline: '美国住宅地产工作日精选',
    cron_info: '北京可读目标：日报 09:00；周报周一 15:00；月报月初首个工作日 16:00',
    sources_label: '信源：',
    sources_unit: '个 OK',
    updated_prefix: '更新于 ',
    timezone_label: '北京',
    loading: '加载中…',
    section_empty: '本期暂无已入选内容',
    no_filter_match: '该 filter 下暂无新闻',
    load_failed: '加载失败',
    load_failed_hint: '请重试，或选择其他日期／期刊。',
    history_unavailable: '目录读取失败',
    history_unavailable_hint: '保留已知日期，点击刷新可重试。',
    archive_missing: p => `该期归档暂不可读取：${p}`,
    source_excerpt: '原文节选',
    excerpt_unavailable: '本条暂无可核验原文节选，请查看原文。',
    invalid_data: '期刊数据与所选类型或日期不符',
    cal_more: '更早',
    cal_close: '关闭',
    cal_legend_has: '有报告',
    cal_title: (y, m) => `${y} 年 ${m + 1} 月`,
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    sec: {
      national: '全国住宅市场',
      sunbelt: 'Sunbelt 住宅',
      btr: '全国 BTR / SFR',
      cre: '全国 CRE',
      institutional: '全国机构资本',
    },
    sec_desc: {
      national: '全国住宅市场、宏观利率、政策、NAR / Realtor / Zillow / Calculated Risk',
      sunbelt: 'Sun Belt 各州住宅与租赁市场',
      btr: 'Build-to-Rent / Single-Family Rental',
      cre: '办公 / 工业 / 数据中心 / 仓储 / 多户 / 酒店等 CRE',
      institutional: 'PE / REIT 募资、并购、IPO、机构持仓',
    },
    filters: {
      __all: '全部', 'btr-sfr': 'BTR/SFR', multifamily: '多户', office: '办公',
      industrial: '工业', 'data-center': '数据中心', 'sun-belt': 'Sun Belt',
      institutional: '机构', rates: '利率', policy: '政策',
    },
    impact: { 'long-pos': '长期利好', 'short-pos': '短期利好', neutral: '中性', 'short-neg': '短期利空', 'long-neg': '长期利空' },
    importance_title: '重要性',
    extended_pill: '扩窗',
    extended_title: '今日 US 房产媒体发稿少（周末或美国假期），此条来自更早的时间窗，以保持栏目完整。',
    button_label: 'EN', // 按钮上显示切换到的语言
    tab_daily: '日报',
    tab_weekly: '周报',
    tab_monthly: '月报',
    themes_weekly_title: '本周主线',
    themes_monthly_title: '本月主线',
    window_banner: (h) => `本期汇总 ${h} 小时内的新闻与研究；周一合并周末，截稿后的消息进入下一期。`,
    window_banner_holiday_today: (name, n, rec) => `今天是美国联邦假期 ${name}，US 房产媒体大面积停发${rec ? `，预计 ${rec} digest 起完全恢复` : ''}。本期含 ${n} 条来自更早时间窗。`,
    window_banner_holiday_shoulder: (name, n, rec) => `昨天是美国联邦假期 ${name}，US 房产媒体仍在恢复发稿${rec ? `，预计 ${rec} digest 完全归位` : ''}。本期含 ${n} 条来自更早时间窗。`,
    period_label_week: '周',
    period_label_month: '月',
    period_month_suffix: '',
    period_empty: '暂无历史',
    monthly_not_yet: '月报暂未发布',
    monthly_not_yet_hint: '月报覆盖上一个完整美东自然月，目标在次月首个工作日北京 16:00 前可读。',
  },
  en: {
    tagline: 'US Housing Daily — Top 20',
    cron_info: 'Beijing reading targets: daily 09:00; weekly Monday 15:00; monthly first weekday 16:00',
    sources_label: 'Sources: ',
    sources_unit: ' OK',
    updated_prefix: 'Updated ',
    timezone_label: 'ET',
    loading: 'Loading…',
    section_empty: 'No selected items in this issue',
    no_filter_match: 'No items matching filter',
    load_failed: 'Failed to load',
    load_failed_hint: 'Try again or choose another date or digest.',
    history_unavailable: 'History unavailable',
    history_unavailable_hint: 'Known dates are retained. Refresh to try again.',
    archive_missing: p => `This archive is unavailable: ${p}`,
    source_excerpt: 'Source excerpt',
    excerpt_unavailable: 'No verified excerpt is available. Read the original article.',
    invalid_data: 'The issue does not match the requested type or period',
    cal_more: 'More',
    cal_close: 'Close',
    cal_legend_has: 'Has data',
    cal_title: (y, m) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m]} ${y}`,
    weekdays: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    sec: {
      national: 'National Residential',
      sunbelt: 'Sunbelt Residential',
      btr: 'BTR / SFR',
      cre: 'National CRE',
      institutional: 'Institutional Capital',
    },
    sec_desc: {
      national: 'National housing market, macro rates, policy — NAR / Realtor / Zillow / Calculated Risk',
      sunbelt: 'Sun Belt residential & rental markets',
      btr: 'Build-to-Rent / Single-Family Rental',
      cre: 'Office / Industrial / Data Center / Multifamily / Hotel',
      institutional: 'PE / REIT fundraising, M&A, IPO, holdings',
    },
    filters: {
      __all: 'All', 'btr-sfr': 'BTR/SFR', multifamily: 'Multifamily', office: 'Office',
      industrial: 'Industrial', 'data-center': 'Data Center', 'sun-belt': 'Sun Belt',
      institutional: 'Institutional', rates: 'Rates', policy: 'Policy',
    },
    impact: { 'long-pos': 'Long-term ↑', 'short-pos': 'Short-term ↑', neutral: 'Neutral', 'short-neg': 'Short-term ↓', 'long-neg': 'Long-term ↓' },
    importance_title: 'Importance',
    extended_pill: '7d ext',
    extended_title: 'US real-estate media is sparse today (weekend or US holiday) — pulled from an earlier window to keep the section complete.',
    button_label: '中',
    tab_daily: 'Daily',
    tab_weekly: 'Weekly',
    tab_monthly: 'Monthly',
    themes_weekly_title: 'Weekly themes',
    themes_monthly_title: 'Monthly themes',
    window_banner: (h) => `This issue covers ${h} hours. Monday combines the weekend; later releases enter the next issue.`,
    window_banner_holiday_today: (name, n, rec) => `Today is the US federal holiday ${name} — US real-estate media is largely paused${rec ? `; full digest expected to resume on ${rec}` : ''}. ${n} item(s) are pulled from an earlier window.`,
    window_banner_holiday_shoulder: (name, n, rec) => `Yesterday was the US federal holiday ${name} — US real-estate media is still resuming${rec ? `; full digest expected by ${rec}` : ''}. ${n} item(s) are pulled from an earlier window.`,
    period_label_week: 'Wk',
    period_label_month: 'Mo',
    period_month_suffix: '',
    period_empty: 'No issues yet',
    monthly_not_yet: 'Monthly digest not yet published',
    monthly_not_yet_hint: 'The monthly digest covers the prior full ET calendar month, with a 16:00 Beijing reading target on the first weekday of the new month.',
  },
};

const LANG_STORAGE_KEY = 'us-housing-lang';
let currentLang = localStorage.getItem(LANG_STORAGE_KEY) || 'zh';
const t = () => I18N[currentLang]; // 当前语言字典快捷方式

const STORAGE_KEY = 'us-housing-active-tag';
let currentData = null;
let loadSerial = 0, activeLoad = null, loadStatus = 'loading', loadFailure = null;
const indexFailures = { daily: false, weekly: false, monthly: false };
let activeTag = sessionStorage.getItem(STORAGE_KEY) || '__all';
let availableDates = new Set();
let selectedDate = null;
let calendarMonth = null;
// Weekly/monthly period navigation
let weeklyPeriods = [];     // ["2026-05-18", ...] — period_start of each saved issue (legacy ET / current Beijing), sorted asc
let monthlyPeriods = [];    // ["2026-05", ...] — YYYY-MM, sorted asc
let selectedWeekly = null;  // currently displayed period_start (weekly mode)
let selectedMonthly = null; // currently displayed YYYY-MM (monthly mode)

// ========== 工具 ==========
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const todayBeijingKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateKey = (y, m0, d) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
// 周日为 0 索引（Date.getUTCDay() 返回 0=Sun, 1=Mon, ..., 6=Sat）
// i18n weekdays 数组按周一开始（中文/英文都是周一一周首）— 用 weekdayLabel(idx) 取
function weekdayLabel(jsDay) {
  // jsDay: 0=Sun ... 6=Sat → 周一首索引
  const idx = jsDay === 0 ? 6 : jsDay - 1;
  return t().weekdays[idx];
}

function articleDate(item) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(item.published_date || '') ? item.published_date : null;
  const validTime = Number.isFinite(item.published_at) && item.published_at > 0;
  const label = day || (validTime ? new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(item.published_at) : '');
  const exact = item.date_precision === 'timestamp' && validTime;
  const title = exact
    ? (currentLang === 'zh' ? '原文发布时间（美东）：' : 'Original publication time (ET): ') + new Intl.DateTimeFormat(currentLang === 'zh' ? 'zh-CN' : 'en-US', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(item.published_at)
    : (currentLang === 'zh' ? '原文发布日期；具体时刻未确认' : 'Original publication date; exact time unconfirmed');
  return {label,title};
}

function periodWindowText(data) {
  const w=data.window,zone=w?.timezone || (data.kind === 'monthly' ? 'America/New_York' : null);
  const prefix=currentLang === 'zh' ? '覆盖：' : 'Coverage: ';
  if(w && Number.isFinite(w.lower) && Number.isFinite(w.upper) && ['Asia/Shanghai','America/New_York'].includes(zone)) {
    const format=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms).replace(',','');
    const name=zone === 'Asia/Shanghai' ? (currentLang === 'zh' ? '北京' : 'Beijing') : (currentLang === 'zh' ? '美东' : 'ET');
    return prefix+format(w.lower)+' '+(currentLang === 'zh' ? '至' : 'to')+' '+format(w.upper)+(currentLang === 'zh' ? '（'+name+'）' : ' ('+name+')');
  }
  return data.period_start && data.period_end ? prefix+data.period_start+' '+(currentLang === 'zh' ? '至' : 'to')+' '+data.period_end : '';
}

// "2026-05-28" → zh "5/28 (周四)" | en "5/28 (Thu)". Null in → null out.
function formatBjRecoveryDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00Z');
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dowZh = ['周日','周一','周二','周三','周四','周五','周六'][d.getUTCDay()];
  const dowEn = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  return currentLang === 'en' ? `${m}/${day} (${dowEn})` : `${m}/${day} (${dowZh})`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========== 渲染：tag chip ==========
// 固定 filter 集 — 行业惯例 + BTR 视角的核心 9 个 tag
// 每天稳定显示，count = 当天数据中匹配的条数；count=0 时灰色 disabled 但保留 chip
const FIXED_FILTERS = [
  { id: '__all',         label: '全部' },
  { id: 'btr-sfr',       label: 'BTR/SFR' },
  { id: 'multifamily',   label: '多户' },
  { id: 'office',        label: '办公' },
  { id: 'industrial',    label: '工业' },
  { id: 'data-center',   label: '数据中心' },
  { id: 'sun-belt',      label: 'Sun Belt' },
  { id: 'institutional', label: '机构' },
  { id: 'rates',         label: '利率' },
  { id: 'policy',        label: '政策' },
];

const SUNBELT_GEOS = new Set(['sun-belt', 'texas', 'dfw', 'houston', 'austin', 'phoenix', 'florida', 'atlanta', 'carolinas', 'nashville', 'las-vegas']);
function filterItems(items, tag) {
  if (tag === '__all') return items;
  return items.filter(it => tag === 'sun-belt' ? (it.tags || []).some(id => SUNBELT_GEOS.has(id)) : (it.tags || []).includes(tag));
}
function retainMatchingFilter(items) {
  if (activeTag !== '__all' && !filterItems(items, activeTag).length) {
    activeTag = '__all'; sessionStorage.setItem(STORAGE_KEY, activeTag);
  }
}

function renderTags(items) {
  // 先算每个 tag 在当天 items 里的频次
  const counter = new Map();
  for (const it of items) {
    for (const t of (it.tags || [])) {
      counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  const sunBeltCount = filterItems(items, 'sun-belt').length;

  filterbar.innerHTML = '';
  for (const f of FIXED_FILTERS) {
    const b = document.createElement('button');
    let count;
    if (f.id === '__all') count = items.length;
    else if (f.id === 'sun-belt') count = sunBeltCount;
    else count = counter.get(f.id) || 0;
    b.className = 'chip' +
      (activeTag === f.id ? ' active' : '') +
      (count === 0 && f.id !== '__all' ? ' disabled' : '');
    b.dataset.tag = f.id;
    b.disabled = count === 0 && f.id !== '__all';
    // i18n filter label
    const label = t().filters[f.id] || f.label;
    b.textContent = `${label} ${count}`;
    filterbar.appendChild(b);
  }
}

// ========== 渲染：一张 card ==========
// 利好利空 pill class（label 由 i18n 提供）
const IMPACT_CLS = {
  'long-pos':  'imp-lp', 'short-pos': 'imp-sp',
  'neutral':   'imp-n',  'short-neg': 'imp-sn', 'long-neg': 'imp-ln',
};
function renderStars(n) {
  const v = Math.max(1, Math.min(5, Math.round(n || 3)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
}

// Canonical UI tags; coverage and dimensions are checked against config/tags.json.
const TAG_DEFINITIONS = {
  "housing": ["asset", "住宅市场", "Housing"],
  "multifamily": ["asset", "多户", "Multifamily"],
  "btr-sfr": ["asset", "BTR/SFR", "BTR/SFR"],
  "office": ["asset", "办公", "Office"],
  "industrial": ["asset", "工业", "Industrial"],
  "data-center": ["asset", "数据中心", "Data Center"],
  "hotel": ["asset", "酒店", "Hotel"],
  "retail": ["asset", "零售", "Retail"],
  "self-storage": ["asset", "自存储", "Self Storage"],
  "senior-housing": ["asset", "老年住房", "Senior Housing"],
  "life-sciences": ["asset", "生命科学", "Life Sciences"],
  "mixed-asset": ["asset", "跨资产", "Mixed-Asset"],
  "national": ["geo", "全国", "National"],
  "sun-belt": ["geo", "Sun Belt", "Sun Belt"],
  "texas": ["geo", "德州", "Texas"],
  "dfw": ["geo", "DFW", "DFW"],
  "houston": ["geo", "Houston", "Houston"],
  "austin": ["geo", "Austin", "Austin"],
  "phoenix": ["geo", "Phoenix", "Phoenix"],
  "florida": ["geo", "佛州", "Florida"],
  "atlanta": ["geo", "Atlanta", "Atlanta"],
  "carolinas": ["geo", "Carolinas", "Carolinas"],
  "nashville": ["geo", "Nashville", "Nashville"],
  "las-vegas": ["geo", "Las Vegas", "Las Vegas"],
  "nyc": ["geo", "NYC", "NYC"],
  "california": ["geo", "California", "California"],
  "rates": ["topic", "利率", "Rates"],
  "macro": ["topic", "宏观", "Macro"],
  "policy": ["topic", "政策", "Policy"],
  "data": ["topic", "数据", "Data"],
  "deals": ["topic", "交易", "Deals"],
  "earnings": ["topic", "业绩", "Earnings"],
  "fundraising": ["topic", "募资", "Fundraising"],
  "ipo": ["topic", "IPO", "IPO"],
  "trend": ["topic", "趋势", "Trend"],
  "construction": ["topic", "新建", "Construction"],
  "distress": ["topic", "违约 / 困境", "Distress"],
  "tech-adoption": ["topic", "技术应用", "Technology Adoption"],
  "regulation": ["topic", "监管动作", "Regulation"],
  "institutional": ["actor", "机构", "Institutional"],
  "homebuilder": ["actor", "建造商", "Homebuilder"],
  "lender": ["actor", "贷款方", "Lender"],
  "landlord": ["actor", "业主", "Landlord"],
  "brokerage": ["actor", "经纪", "Brokerage"],
  "regulator": ["actor", "监管", "Regulator"],
  "developer": ["actor", "开发商", "Developer"],
  "btr-operator": ["actor", "BTR/SFR 运营商", "BTR Operator"],
};
const TAG_LABEL = Object.fromEntries(Object.entries(TAG_DEFINITIONS).map(([id, row]) => [id, row[1]]));
const TAG_LABEL_EN = Object.fromEntries(Object.entries(TAG_DEFINITIONS).map(([id, row]) => [id, row[2]]));
const TAG_DIM = Object.fromEntries(Object.entries(TAG_DEFINITIONS).map(([id, row]) => [id, row[0]]));
const HEAT_TAGS = new Set([
  'btr-sfr','texas','dfw','houston','austin','sun-belt',
  'institutional','policy','rates',
]);
const TAG_DIM_ORDER = ['asset','geo','topic','actor'];
function tagLabel(id) { return TAG_LABEL[id] || id; }
function sortTags(ids) {
  // 先 asset → geo → topic → actor，每组内按字母序
  return [...ids].filter(t => t !== 'national' && TAG_LABEL[t]).sort((a, b) => {
    const da = TAG_DIM_ORDER.indexOf(TAG_DIM[a] || 'topic');
    const db = TAG_DIM_ORDER.indexOf(TAG_DIM[b] || 'topic');
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

function renderCard(it, i) {
  const date = articleDate(it);
  // keyword tags
  const sorted = sortTags(it.tags || []).slice(0, 6);
  const keywordTags = sorted.map(id => {
    const isHeat = HEAT_TAGS.has(id);
    const dim = TAG_DIM[id] || 'topic';
    // tag label — zh 用中文 label，en 用 canonical id（首字母大写）
    const label = currentLang === 'zh' ? tagLabel(id) : tagLabelEn(id);
    return `<span class="card-tag tag-${dim}${isHeat ? ' heat' : ''}" data-id="${escapeHtml(id)}">${escapeHtml(label)}</span>`;
  }).join('');
  const creTag = it.cre_subcategory
    ? `<span class="card-tag cre-cat">${escapeHtml(currentLang === 'zh' ? it.cre_subcategory : creSubcategoryEn(it.cre_subcategory))}</span>`
    : '';
  const numHtml = `<span class="card-num">${i}</span>`;

  // 标题渲染：zh = 中文主标 + 英文副标 + 中文摘要； en = 英文主标 (无副标，无摘要)
  let titleBlock;
  if (currentLang === 'zh' && it.title_zh) {
    titleBlock = `<div class="card-title-zh">${numHtml}${escapeHtml(formatChinese(it.title_zh))}</div>
      <h2 class="card-title">${escapeHtml(it.title)}</h2>`;
  } else {
    // en mode 或 zh 模式但无 title_zh → EN 主标
    titleBlock = `<div class="card-title-zh">${numHtml}${escapeHtml(it.title)}</div>`;
  }
  // Never present source navigation or bylines as an English news summary.
  const quote = typeof it.evidence_quote === 'string' ? it.evidence_quote.trim() : '';
  const summary = currentLang === 'zh' ? formatChinese(it.summary_zh || '')
    : quote && /[A-Za-z]/.test(quote) && !/\p{Script=Han}/u.test(quote)
      ? `${t().source_excerpt}: ${quote}` : t().excerpt_unavailable;

  const stars = `<span class="card-stars" title="${t().importance_title} ${it.importance ?? 3}/5">${renderStars(it.importance)}</span>`;
  const impactLabel = (t().impact[it.impact] || t().impact.neutral);
  const impactCls = IMPACT_CLS[it.impact] || 'imp-n';
  const impactPill = `<span class="impact-pill ${impactCls}">${impactLabel}</span>`;
  const evidencePill = it.evidence_basis === 'title' || it.access === 'preview' || it.evidence_status === 'feed_excerpt' ? `<span class="card-tag">${currentLang === 'zh' ? '公开摘要' : 'Public excerpt'}</span>` : '';
  const extPill = it.extended_window
    ? `<span class="ext-pill" title="${t().extended_title}">${t().extended_pill}</span>`
    : '';
  return `
    <article class="card">
      <a class="card-link" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">
        ${titleBlock}
      </a>
      ${summary ? `<p class="card-summary">${escapeHtml(summary)}</p>` : ''}
      <div class="card-meta">
        ${stars}
        ${impactPill}
        ${evidencePill}${it.late_discovery ? `<span class="card-tag">${currentLang === 'zh' ? '补采' : 'Late discovery'}</span>` : ''}
        ${extPill}
        <span class="card-source">${escapeHtml(it.source_name)}</span>
        <span title="${escapeHtml(date.title)}">${escapeHtml(date.label)}</span>
        ${creTag}
        ${keywordTags}
      </div>
    </article>
  `;
}

// EN 模式下的 tag label (英文、首字母大写)
function tagLabelEn(id) { return TAG_LABEL_EN[id] || id; }
function creSubcategoryEn(zh) {
  return ({ '数据中心': 'Data Center', '生命科学': 'Life Sciences',
    '仓储 / 物流': 'Warehouse', '工业': 'Industrial', '办公': 'Office',
    '零售': 'Retail', '酒店': 'Hotel', '多户': 'Multifamily', '老年住房': 'Senior Housing', '自存储': 'Self Storage', '跨资产': 'Mixed Asset' })[zh] || zh;
}

function renderItems(items) {
  if (items.length === 0) {
    newsList.innerHTML = `<div class="empty">${t().no_filter_match}</div>`;
    return;
  }
  const sections = (currentData && currentData.sections) || [];
  if (sections.length === 0 || activeTag !== '__all') {
    // 1-based numbering — matches the grouped-section path (++globalIdx starting at 1)
    newsList.innerHTML = items.map((it, i) => renderCard(it, i + 1)).join('');
    return;
  }
  const bySection = new Map(sections.map(s => [s.id, []]));
  for (const it of items) {
    const sid = it.section || 'national';
    if (bySection.has(sid)) bySection.get(sid).push(it);
    else bySection.get('national').push(it);
  }
  const blocks = [];
  let globalIdx = 0;
  for (const sec of sections) {
    const arr = bySection.get(sec.id) || [];
    const cardsHtml = arr.length === 0
      ? `<p class="section-empty">${sectionEmptyMessage(currentData, sec.id)}</p>`
      : arr.map(it => renderCard(it, ++globalIdx)).join('');
    const label = t().sec[sec.id] || sec.label;
    const desc = t().sec_desc[sec.id] || sec.description || '';
    blocks.push(`
      <section class="news-section">
        <header class="section-head">
          <span class="section-emoji">${sec.emoji}</span>
          <h3 class="section-label">${escapeHtml(label)}</h3>
          <span class="section-desc">${escapeHtml(desc)}</span>
        </header>
        ${cardsHtml}
      </section>
    `);
  }
  newsList.innerHTML = blocks.join('');
}

function sectionEmptyMessage(data, sectionId) {
  const audit = data?._diagnostics?.editorial_coverage?.sections?.[sectionId];
  if (audit?.source_failures?.length) return currentLang === 'zh'
    ? '本栏部分关键来源尚未取全，不能据此判断没有重要消息。'
    : 'Key sources for this section are incomplete; important news may be missing.';
  if (audit?.qualified > 0) return currentLang === 'zh'
    ? '本栏有可用候选，已合并或因选稿限制未单列。' : 'Candidates were merged or were not selected for this issue.';
  if (audit?.candidates > 0) return currentLang === 'zh'
    ? '本栏已观察到候选，本期未入选。' : 'Candidates were observed; none were selected for this issue.';
  const attempted = Number(data?.sources_attempted), ok = Number(data?.sources_ok);
  if (Number.isFinite(attempted) && attempted > 0 && Number.isFinite(ok) && ok >= 0 && ok < attempted) {
    return currentLang === 'zh' ? '本期有来源未完成检查；本栏暂无已入选内容。' : 'Some sources could not be checked; no items were selected for this section.';
  }
  return t().section_empty;
}

function applyFilter() {
  if (!currentData) return;
  const items = currentData.items || [];
  const filtered = filterItems(items, activeTag);
  renderTags(items);
  renderItems(filtered);
}

// ========== 渲染：顶部 14 天 date strip ==========
function renderDateStrip() {
  const todayKey = todayBeijingKey();
  const today = parseKey(todayKey);
  const cells = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const dayNum = d.getUTCDate();
    const wd = weekdayLabel(d.getUTCDay());
    const has = availableDates.has(key);
    const isToday = key === todayKey;
    const isActive = key === (selectedDate || todayKey) && (has || isToday);
    const cls = ['ds-day'];
    if (has) cls.push('ds-has');
    if (isToday) cls.push('ds-today');
    if (isActive) cls.push('ds-active');
    cells.push(
      `<button class="${cls.join(' ')}" data-date="${key}" ${!has ? 'disabled' : ''}>` +
      `<span class="ds-wd">${wd}</span>` +
      `<span class="ds-num">${dayNum}</span>` +
      `</button>`
    );
  }
  cells.push(`<button class="ds-more" id="dsMore" title="${currentLang === 'zh' ? '查看更早历史' : 'View older history'}">${t().cal_more}</button>`);
  datestrip.innerHTML = cells.join('');
  appendIndexWarning('daily');
  datestrip.scrollLeft = datestrip.scrollWidth;
}

// ========== 渲染：日历 modal ==========
function openCalendar() {
  if (!calendarMonth) {
    const t = parseKey(selectedDate || todayBeijingKey());
    calendarMonth = { year: t.getUTCFullYear(), month: t.getUTCMonth() };
  }
  renderCalendar();
  calendarDialog.showModal();
}

function renderCalendar() {
  const { year, month } = calendarMonth;
  calTitle.textContent = t().cal_title(year, month);
  // 周名 header
  const calWeekdays = $('calWeekdays');
  if (calWeekdays) calWeekdays.innerHTML = t().weekdays.map(w => `<span>${w}</span>`).join('');
  // 周一为一周开始（中文习惯）
  const first = new Date(Date.UTC(year, month, 1));
  let firstWeekday = first.getUTCDay();             // 0 = Sun
  firstWeekday = firstWeekday === 0 ? 6 : firstWeekday - 1; // 转成 Mon=0...Sun=6
  const lastDate = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayKey = todayBeijingKey();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push(`<div class="cal-cell cal-empty"></div>`);
  }
  for (let d = 1; d <= lastDate; d++) {
    const key = dateKey(year, month, d);
    const has = availableDates.has(key);
    const isToday = key === todayKey;
    const isActive = key === selectedDate;
    const cls = ['cal-cell'];
    if (has) cls.push('cal-has');
    if (isToday) cls.push('cal-today');
    if (isActive) cls.push('cal-active');
    cells.push(
      `<button class="${cls.join(' ')}" data-date="${key}" ${!has ? 'disabled' : ''}>${d}</button>`
    );
  }
  calGrid.innerHTML = cells.join('');
}

// ========== 数据加载 ==========
// 静态站点：/data/latest.json (今日) + /data/YYYY-MM-DD.json (历史) + /data/dates.json (索引)
// 数据由 GitHub Actions 每日 cron 生成、commit 并触发 Vercel 自动部署
function formatUpdated(generatedAt) {
  // zh: 北京时间; en: 美东 (EDT/EST 自动)
  const opts = currentLang === 'zh'
    ? { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  const locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
  return t().updated_prefix + new Date(generatedAt).toLocaleString(locale, opts) + ' (' + t().timezone_label + ')';
}

// 首次加载 latest 时优先用预渲染的 inline 数据（pipeline 在 public/index.html 注入）
// 避免首屏闪烁，让 SEO / 分享预览能拿到内容
let initialDataConsumed = false;
function readInlineInitialData() {
  const el = document.getElementById('initial-data');
  if (!el) return null;
  try {
    const txt = el.textContent || '';
    return txt ? JSON.parse(txt) : null;
  } catch { return null; }
}
function applyLoadedData(data) {
  currentData = data; loadStatus = 'ready'; loadFailure = null;
  retainMatchingFilter(data.items || []);
  filterbar.hidden = false;
  rememberLoadedPeriod(data, currentMode);
  renderBrief(data);
  selectedDate = currentData.date || null;
  updatedEl.textContent = formatUpdated(currentData.generated_at);
  const sc = document.getElementById('sourcesCount');
  if (sc) {
    sc.textContent = currentData.sources_ok != null
      ? `${currentData.sources_ok}/${currentData.sources_attempted}`
      : '—';
  }

  // Date strip is mode-aware: daily shows 14 days, weekly shows past weeks, monthly shows past months
  datestrip.hidden = false;
  renderPeriodStrip(currentMode);

  renderWindowBanner(data);

  renderThemes(data);

  applyFilter();
  if (currentMode === 'daily') renderDateStrip();
}

function renderWindowBanner(data) {
  // Holiday / sparse-window banner — daily only.
  // Triggers on: explicit US federal holiday today/yesterday OR pool auto-expand.
  // Copy is picked by priority: today's holiday > yesterday's > generic weekend/sparse.
  // recovery date (BJ digest day that will be fully normal) comes from us-holidays.mjs.
  if (currentMode === 'daily') {
    const diag = data._diagnostics || {};
    const usH = diag.us_holiday || {};
    const extCount = (data.items || []).filter(it => it.extended_window).length;
    const expanded = diag.window_hours > 24;
    const rec = formatBjRecoveryDate(usH.expected_recovery_bj_date);
    let msg = null;
    if (usH.today_us_holiday) {
      msg = t().window_banner_holiday_today(usH.today_us_holiday, extCount, rec);
    } else if (usH.yesterday_us_holiday) {
      msg = t().window_banner_holiday_shoulder(usH.yesterday_us_holiday, extCount, rec);
    } else if (expanded) {
      msg = t().window_banner(diag.window_hours, extCount, rec);
    }
    if (msg) { windowBanner.textContent = msg; windowBanner.hidden = false; }
    else     { windowBanner.hidden = true; }
  } else {
    windowBanner.textContent = periodWindowText(data);
    windowBanner.hidden = !windowBanner.textContent;
  }

}

function isCurrentLoad(request) { return activeLoad === request && currentMode === request.mode; }
function rememberLoadedPeriod(data, mode) {
  const period = mode === 'daily' ? data.date : mode === 'weekly' ? data.period_start : data.period_label;
  if (!period) return;
  if (mode === 'daily') availableDates.add(period);
  else if (mode === 'weekly' && !weeklyPeriods.includes(period)) weeklyPeriods = [...weeklyPeriods, period].sort();
  else if (mode === 'monthly' && !monthlyPeriods.includes(period)) monthlyPeriods = [...monthlyPeriods, period].sort();
}
function clearIssueView() {
  currentData = null;
  for (const id of ['briefBlock', 'coverageNote', 'researchCoverage']) $(id).hidden = true;
  $('briefText').replaceChildren(); $('researchStatus').replaceChildren();
  themesBlock.hidden = true; themesBlock.querySelector('.themes-list').replaceChildren();
  windowBanner.hidden = true; windowBanner.textContent = '';
  filterbar.replaceChildren(); filterbar.hidden = true;
  const count = $('sourcesCount'); if (count) count.textContent = '--';
}
function renderLoadStatus() {
  if (currentData) return;
  updatedEl.textContent = loadStatus === 'error' ? t().load_failed : t().loading;
  const message = document.createElement('div');
  message.className = loadStatus === 'error' ? 'empty' : 'loader';
  if (loadStatus !== 'error') { message.textContent = t().loading; newsList.replaceChildren(message); return; }
  const missingLatestMonth = loadFailure?.missing && activeLoad?.mode === 'monthly' && !activeLoad.period;
  message.textContent = loadFailure?.missing && activeLoad?.period ? t().archive_missing(activeLoad.period)
    : missingLatestMonth ? t().monthly_not_yet : `${t().load_failed}: ${loadFailure?.code === 'invalid_data' ? t().invalid_data : loadFailure?.detail || ''}`;
  const hint = document.createElement('div');
  hint.textContent = missingLatestMonth ? t().monthly_not_yet_hint : t().load_failed_hint;
  newsList.replaceChildren(message, hint);
}
function appendIndexWarning(mode) {
  if (!indexFailures[mode]) return;
  const warning = document.createElement('span'); warning.className = 'ds-empty';
  warning.textContent = t().history_unavailable; warning.title = t().history_unavailable_hint;
  warning.setAttribute('role', 'status'); datestrip.appendChild(warning);
}
async function loadIssueIndex(request) {
  const mode = request.mode, prefix = mode === 'daily' ? '/data' : `/data/${mode}`;
  try {
    const response = await fetch(prefix + '/dates.json', { cache: 'no-store', signal: request.controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid period index');
    if (!isCurrentLoad(request)) return;
    const pattern = mode === 'monthly' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
    const periods = [...new Set(rows.filter(row => typeof row === 'string' && pattern.test(row)))].sort();
    if (mode === 'daily') availableDates = new Set(periods);
    else if (mode === 'weekly') weeklyPeriods = periods;
    else monthlyPeriods = periods;
    indexFailures[mode] = false;
  } catch {
    if (!isCurrentLoad(request)) return;
    indexFailures[mode] = true; // Preserve known dates; unreadable does not mean absent.
  }
  if (!isCurrentLoad(request)) return;
  if (currentData) rememberLoadedPeriod(currentData, mode);
  renderPeriodStrip(mode);
  if (mode === 'daily' && calendarDialog.open) renderCalendar();
}
async function loadIssue(mode, period = null, { useInline = false } = {}) {
  if (!['daily', 'weekly', 'monthly'].includes(mode)) mode = 'daily';
  activeLoad?.controller.abort();
  const request = { id: ++loadSerial, mode, period: period || null, controller: new AbortController() };
  activeLoad = request; currentMode = mode; loadStatus = 'loading'; loadFailure = null;
  if (mode === 'daily') selectedDate = period || null;
  else if (mode === 'weekly') selectedWeekly = period || null;
  else selectedMonthly = period || null;
  for (const button of digestTabs.querySelectorAll('.tab')) {
    const active = button.dataset.tab === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
  }
  const hash = mode === 'daily' ? '' : `#${mode}`;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
  clearIssueView(); renderPeriodStrip(mode); renderLoadStatus();
  const indexTask = loadIssueIndex(request);
  try {
    let data;
    if (mode === 'daily' && !period && useInline && !initialDataConsumed) {
      initialDataConsumed = true; data = readInlineInitialData();
    }
    if (!data) {
      const response = await fetch(digestDataUrl(mode, period), { cache: 'no-store', signal: request.controller.signal });
      if (!response.ok) { const error = new Error('HTTP ' + response.status); error.status = response.status; throw error; }
      data = await response.json();
    }
    if (!isCurrentLoad(request)) return;
    const actualPeriod = mode === 'daily' ? data?.date : mode === 'weekly' ? data?.period_start : data?.period_label;
    if (!data || !Array.isArray(data.items) || (data.kind || 'daily') !== mode || (period && actualPeriod !== period)) {
      const error = new Error('Invalid issue data'); error.code = 'invalid_data'; throw error;
    }
    if (mode === 'daily') selectedDate = actualPeriod || null;
    else if (mode === 'weekly') selectedWeekly = actualPeriod || null;
    else selectedMonthly = actualPeriod || null;
    applyLoadedData(data);
  } catch (error) {
    if (!isCurrentLoad(request)) return;
    clearIssueView();
    loadStatus = 'error'; loadFailure = { missing: error.status === 404, code: error.code, detail: error.message };
    renderLoadStatus();
  }
  await indexTask;
}
async function loadNews(date) { return loadIssue('daily', date, { useInline: !date }); }

// Render the period strip into the datestrip element. Mode-aware:
//   daily   → 14-day strip (existing renderDateStrip)
//   weekly  → list of past weeks (each cell = saved period_start, labeled M/D)
//   monthly → list of past months (each cell = YYYY-MM, labeled `<MM>月`)
function renderPeriodStrip(mode) {
  if (mode === 'daily') {
    renderDateStrip();
    return;
  }
  const periods = mode === 'weekly' ? weeklyPeriods : monthlyPeriods;
  const selected = mode === 'weekly' ? selectedWeekly : selectedMonthly;
  // Safely clear via removeChild loop (hook is sensitive to innerHTML=)
  while (datestrip.firstChild) datestrip.removeChild(datestrip.firstChild);
  if (periods.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'ds-empty';
    empty.textContent = indexFailures[mode] ? t().history_unavailable : t().period_empty;
    if (indexFailures[mode]) empty.title = t().history_unavailable_hint;
    datestrip.appendChild(empty);
    return;
  }
  for (const p of periods) {
    const btn = document.createElement('button');
    btn.className = 'ds-day ds-has';
    if (p === selected) btn.classList.add('ds-active');
    btn.dataset.period = p;
    btn.title = p; btn.setAttribute('aria-label', `${mode === 'weekly' ? t().period_label_week : t().period_label_month} ${p}`);
    const wd = document.createElement('span');
    wd.className = 'ds-wd';
    const num = document.createElement('span');
    num.className = 'ds-num';
    if (mode === 'weekly') {
      const [, mm, dd] = p.split('-');
      wd.textContent = t().period_label_week;
      num.textContent = `${Number(mm)}/${Number(dd)}`;
    } else {
      const [, mm] = p.split('-');
      wd.textContent = t().period_label_month;
      num.textContent = `${Number(mm)}${t().period_month_suffix}`;
    }
    btn.appendChild(wd);
    btn.appendChild(num);
    datestrip.appendChild(btn);
  }
  appendIndexWarning(mode);
  datestrip.scrollLeft = datestrip.scrollWidth;
}

async function setDigestMode(mode) { return loadIssue(mode, null, { useInline: mode === 'daily' }); }

digestTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setDigestMode(btn.dataset.tab);
});

window.addEventListener('hashchange', () => setDigestMode(initialMode()));

// ========== 事件 ==========
filterbar.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLButtonElement) || !t.dataset.tag) return;
  activeTag = t.dataset.tag;
  sessionStorage.setItem(STORAGE_KEY, activeTag);
  applyFilter();
});

refreshBtn.addEventListener('click', () => {
  const period = currentMode === 'daily' ? selectedDate : currentMode === 'weekly' ? selectedWeekly : selectedMonthly;
  loadIssue(currentMode, period);
});

datestrip.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.id === 'dsMore') {
    openCalendar();
    return;
  }
  // Weekly/monthly: data-period click → load that specific digest
  if (currentMode !== 'daily' && btn.dataset.period) {
    const p = btn.dataset.period;
    if (currentMode === 'weekly')  selectedWeekly  = p;
    if (currentMode === 'monthly') selectedMonthly = p;
    loadIssue(currentMode, p);
    return;
  }
  // Daily: existing data-date click
  if (btn.classList.contains('ds-day') && btn.dataset.date && !btn.disabled) {
    loadNews(btn.dataset.date);
  }
});

calGrid.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.disabled || !t.dataset.date) return;
  loadNews(t.dataset.date);
  calendarDialog.close();
});

calPrev.addEventListener('click', () => {
  if (!calendarMonth) return;
  let { year, month } = calendarMonth;
  month -= 1;
  if (month < 0) { month = 11; year -= 1; }
  calendarMonth = { year, month };
  renderCalendar();
});

calNext.addEventListener('click', () => {
  if (!calendarMonth) return;
  let { year, month } = calendarMonth;
  month += 1;
  if (month > 11) { month = 0; year += 1; }
  calendarMonth = { year, month };
  renderCalendar();
});

calClose.addEventListener('click', () => calendarDialog.close());

// ========== 多语言切换 ==========
// 切语言时刷新 UI chrome (header / footer / calendar / cards / filter)
function applyLanguage() {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en-US';
  document.title = 'US Housing Daily -- ' + t().tagline;
  langSeg.title = currentLang === 'zh' ? '切换语言' : 'Switch language';
  refreshBtn.title = currentLang === 'zh' ? '重新加载' : 'Reload';
  datestrip.setAttribute('aria-label', currentLang === 'zh' ? '选择期刊日期' : 'Choose an issue date');
  $('briefBlock').setAttribute('aria-label', currentLang === 'zh' ? '速读摘要' : 'Executive summary');
  calPrev.setAttribute('aria-label', currentLang === 'zh' ? '上个月' : 'Previous month');
  calNext.setAttribute('aria-label', currentLang === 'zh' ? '下个月' : 'Next month');
  if (calendarDialog.open) renderCalendar();
  // 高亮当前激活的语言按钮
  for (const btn of langSeg.querySelectorAll('.lang-btn')) {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  }
  $('tagline').textContent = t().tagline;
  $('cronInfo').textContent = t().cron_info;
  const cnt = currentData ? `${currentData.sources_ok}/${currentData.sources_attempted}` : '—';
  $('sourcesInfo').innerHTML = `${t().sources_label}<span id="sourcesCount">${cnt}</span>${t().sources_unit}`;
  $('calClose').textContent = t().cal_close;
  $('calLegendText').textContent = t().cal_legend_has;
  // Update digest tab labels
  for (const btn of digestTabs.querySelectorAll('.tab')) {
    const key = `tab_${btn.dataset.tab}`;
    btn.textContent = t()[key] || btn.textContent;
  }
  if (currentData) {
    updatedEl.textContent = formatUpdated(currentData.generated_at);
    renderBrief(currentData);
    applyFilter();         // 重新渲染卡片 + filter chip 用新语言
    renderPeriodStrip(currentMode);
    renderThemes(currentData);
    renderWindowBanner(currentData);
  } else {
    renderLoadStatus(); renderPeriodStrip(currentMode);
  }
}

langSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.lang-btn');
  if (!btn) return;
  const next = btn.dataset.lang;
  if (next === currentLang) return;
  currentLang = next;
  localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  applyLanguage();
});

// ========== 启动 ==========
(async () => {
  applyLanguage();           // 先按保存的语言设 UI chrome
  const startMode = initialMode();
  currentMode = startMode;
  await setDigestMode(startMode);
})();

function renderThemes(data) {
  const ul = themesBlock.querySelector('.themes-list');
  ul.replaceChildren();
  const themes = data.themes || [];
  themesBlock.hidden = currentMode === 'daily' || !themes.length;
  if (themesBlock.hidden) return;
  const available = currentLang === 'zh' || themes.every(row => typeof row.title_en === 'string' && row.title_en.trim() && !/\p{Script=Han}/u.test(row.title_en));
  for (const theme of available ? themes : [{ title_en: 'English themes are unavailable for this archive.' }]) {
    const li = document.createElement('li');
    li.textContent = currentLang === 'zh' ? formatChinese(theme.title) : theme.title_en;
    ul.appendChild(li);
  }
  themesBlock.querySelector('.themes-title').textContent = currentMode === 'weekly' ? t().themes_weekly_title : t().themes_monthly_title;
}

function renderBrief(data) {
  const block=$('briefBlock'), text=$('briefText');
  if(!block||!text)return;
  text.replaceChildren();
  const sentences=data.executive_summary?.sentences||[];
  $('briefTitle').textContent=currentLang==='zh'?'速读摘要':'Executive summary';
  const available = currentLang === 'zh' || sentences.every(row => typeof row.text_en === 'string' && row.text_en.trim() && !/\p{Script=Han}/u.test(row.text_en));
  if (sentences.length && !available) { const p=document.createElement('p'); p.textContent='English summary is unavailable for this archive.'; text.append(p); }
  for(const sentence of available ? sentences : []){const p=document.createElement('p');p.textContent=currentLang==='zh'?formatChinese(sentence.text):sentence.text_en;for(const id of sentence.item_ids||[]){const i=(data.items||[]).findIndex(x=>x.id===id);if(i<0)continue;const a=document.createElement('a');a.href=data.items[i].link;a.target='_blank';a.rel='noopener noreferrer';a.textContent=' ['+(data.items[i].source_name||(currentLang==='zh'?'来源':'Source'))+']';p.append(a);}text.append(p);}
  block.hidden=!sentences.length;
  const note=$('coverageNote');
  if(note){note.hidden=data.publication_status!=='degraded';note.textContent=currentLang==='zh'?'本期部分研究来源或历史材料暂未取全，补齐后可更新。':'Some research sources or historical inputs are incomplete; this issue can be updated.';}
  const research=(data._diagnostics?.source_health||[]).filter(s=>s.research);const details=$('researchCoverage'), list=$('researchStatus');
  if(details&&list){list.replaceChildren();details.hidden=!research.length;$('researchTitle').textContent=(currentLang==='zh'?'研究来源覆盖：':'Research coverage: ')+research.filter(s=>s.status==='ok').length+'/'+research.length;for(const source of research){const li=document.createElement('li');const labels={ok:'已检查',empty_listing:'目录未发现有效条目',unreadable:'正文暂不可读',error:'抓取失败'};li.textContent=source.name+(currentLang==='zh'?'：':': ')+(currentLang==='zh'?(labels[source.status]||source.status):source.status)+(source.undated?' · '+source.undated+(currentLang==='zh'?' 条日期待核实':' date(s) unverified'):'');list.append(li);}}

  const audit = data._diagnostics?.editorial_coverage;
  if (audit && details && list) {
    details.hidden = false;
    $('researchTitle').textContent = currentLang === 'zh' ? '来源与行业覆盖' : 'Source and sector coverage';
    for (const asset of audit.assets || []) {
      const li = document.createElement('li');
      li.textContent = currentLang === 'zh'
        ? asset.label + '：本期 ' + asset.selected + ' 条' + (data.kind === 'daily' ? '；近 5 个工作日已记录 ' + asset.recent_selected + ' 条' : '')
        : tagLabelEn(asset.id) + ': ' + asset.selected + ' selected';
      list.append(li);
    }
    if (audit.unclassified_selected > 0) {
      const li = document.createElement('li');
      li.textContent = currentLang === 'zh' ? '未标注资产类型：本期 ' + audit.unclassified_selected + ' 条。' : 'Unclassified asset type: ' + audit.unclassified_selected + ' selected.';
      list.append(li);
    }
    for (const section of Object.values(audit.sections || {})) for (const source of section.source_failures || []) {
      const li = document.createElement('li');
      li.textContent = source.name + (currentLang === 'zh' ? '：关键来源尚未取全。' : ': key source incomplete.');
      list.append(li);
    }
    if (data.kind === 'daily' && audit.history?.missing_dates?.length) {
      const li = document.createElement('li');
      li.textContent = currentLang === 'zh' ? '近期记录有缺口，不能视为完整行业覆盖。' : 'Recent issue history has gaps; sector coverage is incomplete.';
      list.append(li);
    }
  }

}

function formatChinese(value) {
  return String(value || '').replace(/[—–]/g, '--').replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9%])([\u3400-\u9fff])/g, '$1 $2')
    .replace(/([\u3400-\u9fff])[,:;!?]/g, (m, ch) => ch + ({ ',': '，', ':': '：', ';': '；', '!': '！', '?': '？' }[m.at(-1)]))
    .replace(/[,:;!?](?=[\u3400-\u9fff])/g, ch => ({ ',': '，', ':': '：', ';': '；', '!': '！', '?': '？' }[ch])).replace(/\s*([，。！？；：、])\s*/g, '$1');
}
