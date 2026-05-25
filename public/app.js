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
  return '/data/latest.json';
}

function initialMode() {
  const h = (location.hash || '').replace('#', '');
  return ['weekly', 'monthly'].includes(h) ? h : 'daily';
}

// ========== i18n ==========
const I18N = {
  zh: {
    tagline: '美国住宅地产每日 20 条',
    cron_info: '每天北京 09:00 自动更新（数据截止 08:57）',
    sources_label: '信源：',
    sources_unit: '个 OK',
    updated_prefix: '更新于 ',
    timezone_label: '北京',
    loading: '加载中…',
    section_empty: '今日 24h 内无新内容',
    no_filter_match: '该 filter 下暂无新闻',
    load_failed: '加载失败',
    load_failed_hint: '如果首次部署还没有数据，请手动触发一次 GitHub Actions workflow，或等明早 9 点 cron 自动跑。',
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
    extended_title: '今日 24h 内该分类无新闻 — 此条来自 7 天扩窗回退',
    button_label: 'EN', // 按钮上显示切换到的语言
    tab_daily: '日报',
    tab_weekly: '周报',
    tab_monthly: '月报',
    themes_weekly_title: '本周主线',
    themes_monthly_title: '本月主线',
    window_banner: (h, n) => `周末/假日窗口已自动扩展到 ${h}h。本期含 ${n} 条 24h 外稿件。`,
    period_label_week: '周',
    period_label_month: '月',
    period_month_suffix: '',
    period_empty: '暂无历史',
    monthly_not_yet: '月报暂未发布',
    monthly_not_yet_hint: '月报在每月首个周一北京 10:30 自动发布，覆盖上一个自然月。',
  },
  en: {
    tagline: 'US Housing Daily — Top 20',
    cron_info: 'Auto-updates daily ~9:00 PM ET (data cutoff 8:57 PM ET)',
    sources_label: 'Sources: ',
    sources_unit: ' OK',
    updated_prefix: 'Updated ',
    timezone_label: 'ET',
    loading: 'Loading…',
    section_empty: 'No items in 24h window',
    no_filter_match: 'No items matching filter',
    load_failed: 'Failed to load',
    load_failed_hint: 'If this is the first deploy with no data yet, manually trigger the GitHub Actions workflow or wait for the daily cron.',
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
    extended_title: 'No items today in 24h window — fallback to 7-day extended window',
    button_label: '中',
    tab_daily: 'Daily',
    tab_weekly: 'Weekly',
    tab_monthly: 'Monthly',
    themes_weekly_title: 'Weekly themes',
    themes_monthly_title: 'Monthly themes',
    window_banner: (h, n) => `Window auto-expanded to ${h}h (weekend/holiday). ${n} item(s) outside the canonical 24h window.`,
    period_label_week: 'Wk',
    period_label_month: 'Mo',
    period_month_suffix: '',
    period_empty: 'No issues yet',
    monthly_not_yet: 'Monthly digest not yet published',
    monthly_not_yet_hint: 'The monthly digest publishes on the first Monday of each month at 10:30 Beijing time and covers the prior calendar month.',
  },
};

const LANG_STORAGE_KEY = 'us-housing-lang';
let currentLang = localStorage.getItem(LANG_STORAGE_KEY) || 'zh';
const t = () => I18N[currentLang]; // 当前语言字典快捷方式

const STORAGE_KEY = 'us-housing-active-tag';
let currentData = null;
let activeTag = sessionStorage.getItem(STORAGE_KEY) || '__all';
let availableDates = new Set();
let selectedDate = null;
let calendarMonth = null;
// Weekly/monthly period navigation
let weeklyPeriods = [];     // ["2026-05-18", ...] — ET Mon of each period_start, sorted asc
let monthlyPeriods = [];    // ["2026-05", ...] — YYYY-MM, sorted asc
let selectedWeekly = null;  // currently displayed period_start (weekly mode)
let selectedMonthly = null; // currently displayed YYYY-MM (monthly mode)

// ========== 工具 ==========
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const todayUTCKey = () => new Date().toISOString().slice(0, 10);
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

function timeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600_000);
  if (h < 1) return Math.floor(diff / 60_000) + 'm ago';
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
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

function renderTags(items) {
  // 先算每个 tag 在当天 items 里的频次
  const counter = new Map();
  for (const it of items) {
    for (const t of (it.tags || [])) {
      counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  // sun-belt 兼容：item 的 tags 没主动加 sun-belt 但有 texas/houston/dfw/austin → 视为 sun-belt
  const sunBeltCount = items.filter(it => {
    const t = it.tags || [];
    return t.includes('sun-belt') || t.includes('texas') || t.includes('dfw') ||
           t.includes('houston') || t.includes('austin') || t.includes('florida');
  }).length;

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

// Tag 体系 — 4 维度 canonical IDs → 中文 label (与 src/tags.ts 对应)
const TAG_LABEL = {
  // 资产
  'housing':'住宅市场','multifamily':'多户','btr-sfr':'BTR/SFR',
  'office':'办公','industrial':'工业','data-center':'数据中心',
  'retail':'零售','hotel':'酒店','mixed-asset':'跨资产',
  // 地理
  'texas':'德州','dfw':'DFW','houston':'Houston','austin':'Austin',
  'sun-belt':'Sun Belt','nyc':'NYC','california':'California',
  // 主题
  'policy':'政策','rates':'利率','macro':'宏观','deals':'交易',
  'data':'数据','trend':'趋势','earnings':'业绩',
  // 主体
  'institutional':'机构','homebuilder':'建造商','landlord':'业主',
  'brokerage':'经纪','regulator':'监管',
};
const HEAT_TAGS = new Set([
  'btr-sfr','texas','dfw','houston','austin','sun-belt',
  'institutional','policy','rates',
]);
const TAG_DIM_ORDER = ['asset','geo','topic','actor'];
const TAG_DIM = {
  // asset
  'housing':'asset','multifamily':'asset','btr-sfr':'asset','office':'asset',
  'industrial':'asset','data-center':'asset','retail':'asset','hotel':'asset','mixed-asset':'asset',
  // geo
  'texas':'geo','dfw':'geo','houston':'geo','austin':'geo','sun-belt':'geo','nyc':'geo','california':'geo',
  // topic
  'policy':'topic','rates':'topic','macro':'topic','deals':'topic','data':'topic','trend':'topic','earnings':'topic',
  // actor
  'institutional':'actor','homebuilder':'actor','landlord':'actor','brokerage':'actor','regulator':'actor',
};
function tagLabel(id) { return TAG_LABEL[id] || id; }
function sortTags(ids) {
  // 先 asset → geo → topic → actor，每组内按字母序
  return [...ids].filter(t => TAG_LABEL[t]).sort((a, b) => {
    const da = TAG_DIM_ORDER.indexOf(TAG_DIM[a] || 'topic');
    const db = TAG_DIM_ORDER.indexOf(TAG_DIM[b] || 'topic');
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

function renderCard(it, i) {
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
    titleBlock = `<div class="card-title-zh">${numHtml}${escapeHtml(it.title_zh)}</div>
      <h2 class="card-title">${escapeHtml(it.title)}</h2>`;
  } else {
    // en mode 或 zh 模式但无 title_zh → EN 主标
    titleBlock = `<div class="card-title-zh">${numHtml}${escapeHtml(it.title)}</div>`;
  }
  // summary：zh 显示 LLM 中文摘要；en 模式从 description 取前 200 字（fallback，无 LLM EN summary）
  const summary = currentLang === 'zh'
    ? it.summary_zh || ''
    : (it.description || '').slice(0, 240) + ((it.description || '').length > 240 ? '…' : '');

  const stars = `<span class="card-stars" title="${t().importance_title} ${it.importance ?? 3}/5">${renderStars(it.importance)}</span>`;
  const impactLabel = (t().impact[it.impact] || t().impact.neutral);
  const impactCls = IMPACT_CLS[it.impact] || 'imp-n';
  const impactPill = `<span class="impact-pill ${impactCls}">${impactLabel}</span>`;
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
        ${extPill}
        <span class="card-source">${escapeHtml(it.source_name)}</span>
        <span>${timeAgo(it.published_at)}</span>
        ${creTag}
        ${keywordTags}
      </div>
    </article>
  `;
}

// EN 模式下的 tag label (英文、首字母大写)
const TAG_LABEL_EN = {
  'housing': 'Housing', 'multifamily': 'Multifamily', 'btr-sfr': 'BTR/SFR',
  'office': 'Office', 'industrial': 'Industrial', 'data-center': 'Data Center',
  'retail': 'Retail', 'hotel': 'Hotel', 'mixed-asset': 'Mixed-Asset',
  'texas': 'Texas', 'dfw': 'DFW', 'houston': 'Houston', 'austin': 'Austin',
  'sun-belt': 'Sun Belt', 'nyc': 'NYC', 'california': 'California',
  'policy': 'Policy', 'rates': 'Rates', 'macro': 'Macro', 'deals': 'Deals',
  'data': 'Data', 'trend': 'Trend', 'earnings': 'Earnings',
  'institutional': 'Institutional', 'homebuilder': 'Homebuilder',
  'landlord': 'Landlord', 'brokerage': 'Brokerage', 'regulator': 'Regulator',
};
function tagLabelEn(id) { return TAG_LABEL_EN[id] || id; }
function creSubcategoryEn(zh) {
  return ({ '数据中心': 'Data Center', '生命科学': 'Life Sciences',
    '仓储 / 物流': 'Warehouse', '工业': 'Industrial', '办公': 'Office',
    '零售': 'Retail', '酒店': 'Hotel', '多户': 'Multifamily' })[zh] || zh;
}

function renderItems(items) {
  if (items.length === 0) {
    newsList.innerHTML = `<div class="empty">${t().no_filter_match}</div>`;
    return;
  }
  const sections = (currentData && currentData.sections) || [];
  if (sections.length === 0 || activeTag !== '__all') {
    newsList.innerHTML = items.map((it, i) => renderCard(it, i)).join('');
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
      ? `<p class="section-empty">${t().section_empty}</p>`
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

function applyFilter() {
  if (!currentData) return;
  const items = currentData.items || [];
  let filtered;
  if (activeTag === '__all') {
    filtered = items;
  } else if (activeTag === 'sun-belt') {
    // Sun Belt 兼容：含 sun-belt / texas / dfw / houston / austin / florida
    filtered = items.filter(it => {
      const t = it.tags || [];
      return t.includes('sun-belt') || t.includes('texas') || t.includes('dfw') ||
             t.includes('houston') || t.includes('austin') || t.includes('florida');
    });
  } else {
    filtered = items.filter(it => (it.tags || []).includes(activeTag));
  }
  renderTags(items);
  renderItems(filtered);
}

// ========== 渲染：顶部 14 天 date strip ==========
function renderDateStrip() {
  const todayKey = todayUTCKey();
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
  datestrip.scrollLeft = datestrip.scrollWidth;
}

// ========== 渲染：日历 modal ==========
function openCalendar() {
  if (!calendarMonth) {
    const t = parseKey(selectedDate || todayUTCKey());
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
  const todayKey = todayUTCKey();
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
  currentData = data;
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

  // Adaptive-window banner — daily only, only when window_hours > 24
  if (currentMode === 'daily' && data._diagnostics?.window_hours > 24) {
    const h = data._diagnostics.window_hours;
    const extCount = (data.items || []).filter(it => it.extended_window).length;
    windowBanner.textContent = t().window_banner(h, extCount);
    windowBanner.hidden = false;
  } else {
    windowBanner.hidden = true;
  }

  // Themes block — weekly / monthly only
  const ul = themesBlock.querySelector('.themes-list');
  while (ul.firstChild) ul.removeChild(ul.firstChild); // safe clear, no innerHTML
  if ((currentMode === 'weekly' || currentMode === 'monthly')
      && Array.isArray(data.themes) && data.themes.length > 0) {
    for (const theme of data.themes) {
      const li = document.createElement('li');
      li.textContent = theme.title; // textContent — XSS-safe even if LLM emits HTML
      ul.appendChild(li);
    }
    themesBlock.querySelector('.themes-title').textContent =
      currentMode === 'weekly' ? t().themes_weekly_title : t().themes_monthly_title;
    themesBlock.hidden = false;
  } else {
    themesBlock.hidden = true;
  }

  applyFilter();
  if (currentMode === 'daily') renderDateStrip();
}

async function loadNews(date) {
  if (!date && !initialDataConsumed) {
    initialDataConsumed = true;
    const inline = readInlineInitialData();
    if (inline) { applyLoadedData(inline); return; }
  }
  newsList.replaceChildren(Object.assign(document.createElement('div'), { className: 'loader', textContent: t().loading }));
  try {
    const url = date ? `/data/${encodeURIComponent(date)}.json` : '/data/latest.json';
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    applyLoadedData(await r.json());
  } catch (e) {
    newsList.innerHTML = `<div class="empty">${t().load_failed}: ${escapeHtml(e.message)}<br><br>${t().load_failed_hint}</div>`;
  }
}

async function loadAvailableDates() {
  try {
    const r = await fetch('/data/dates.json', { cache: 'no-store' });
    const dates = await r.json();
    availableDates = new Set(Array.isArray(dates) ? dates : []);
  } catch {
    availableDates = new Set();
  }
}

async function loadDigest(url, period) {
  newsList.replaceChildren(Object.assign(document.createElement('div'), { className: 'loader', textContent: t().loading }));
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.kind === 'weekly')  selectedWeekly  = data.period_start || period || null;
    if (data.kind === 'monthly') selectedMonthly = data.period_label || period || null;
    applyLoadedData(data);
  } catch (e) {
    const isMissing = /HTTP 404/.test(e.message);
    const msgKey = isMissing && currentMode === 'monthly' ? 'monthly_not_yet' : 'load_failed';
    const hintKey = isMissing && currentMode === 'monthly' ? 'monthly_not_yet_hint' : 'load_failed_hint';
    const errDiv = document.createElement('div');
    errDiv.className = 'empty';
    errDiv.textContent = isMissing ? t()[msgKey] : `${t().load_failed}: ${e.message}`;
    const hintDiv = document.createElement('div');
    hintDiv.textContent = t()[hintKey];
    newsList.replaceChildren(errDiv, hintDiv);
    renderPeriodStrip(currentMode);
    themesBlock.hidden = true;
    windowBanner.hidden = true;
  }
}

async function loadPeriodList(mode) {
  if (mode !== 'weekly' && mode !== 'monthly') return;
  const url = mode === 'weekly' ? '/data/weekly/dates.json' : '/data/monthly/dates.json';
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    if (mode === 'weekly')  weeklyPeriods  = Array.isArray(arr) ? arr.slice().sort() : [];
    if (mode === 'monthly') monthlyPeriods = Array.isArray(arr) ? arr.slice().sort() : [];
  } catch {
    if (mode === 'weekly')  weeklyPeriods  = [];
    if (mode === 'monthly') monthlyPeriods = [];
  }
}

// Render the period strip into the datestrip element. Mode-aware:
//   daily   → 14-day strip (existing renderDateStrip)
//   weekly  → list of past weeks (each cell = ET Mon period_start, labeled M/D)
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
    empty.textContent = t().period_empty;
    datestrip.appendChild(empty);
    return;
  }
  for (const p of periods) {
    const btn = document.createElement('button');
    btn.className = 'ds-day ds-has';
    if (p === selected) btn.classList.add('ds-active');
    btn.dataset.period = p;
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
  datestrip.scrollLeft = datestrip.scrollWidth;
}

async function setDigestMode(mode) {
  if (!['daily', 'weekly', 'monthly'].includes(mode)) mode = 'daily';
  currentMode = mode;
  for (const btn of digestTabs.querySelectorAll('.tab')) {
    const active = btn.dataset.tab === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  const hash = mode === 'daily' ? '' : `#${mode}`;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
  if (mode === 'daily') {
    if (availableDates.size === 0) {
      loadAvailableDates();
    }
    await loadNews();
  } else {
    // Load period list + latest-period digest in parallel
    await Promise.all([loadPeriodList(mode), loadDigest(digestDataUrl(mode))]);
    // Re-render the strip so the active period highlight matches the loaded latest
    renderPeriodStrip(mode);
  }
}

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

refreshBtn.addEventListener('click', async () => {
  if (currentMode === 'daily') {
    await loadAvailableDates();
    await loadNews(selectedDate || undefined);
  } else {
    const selected = currentMode === 'weekly' ? selectedWeekly : selectedMonthly;
    await Promise.all([
      loadPeriodList(currentMode),
      loadDigest(digestDataUrl(currentMode, selected), selected),
    ]);
    renderPeriodStrip(currentMode);
  }
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
    loadDigest(digestDataUrl(currentMode, p), p);
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
    applyFilter();         // 重新渲染卡片 + filter chip 用新语言
    if (currentMode === 'daily') renderDateStrip(); // 重新渲染 weekday header
    // Re-render themes title if visible
    if (!themesBlock.hidden) {
      themesBlock.querySelector('.themes-title').textContent =
        currentMode === 'weekly' ? t().themes_weekly_title : t().themes_monthly_title;
    }
    // Re-render window banner if visible
    if (!windowBanner.hidden && currentData._diagnostics?.window_hours > 24) {
      const h = currentData._diagnostics.window_hours;
      const extCount = (currentData.items || []).filter(it => it.extended_window).length;
      windowBanner.textContent = t().window_banner(h, extCount);
    }
  } else {
    updatedEl.textContent = t().loading;
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
  if (startMode === 'daily') {
    // For daily, load dates index first so date strip is populated
    await loadAvailableDates();
  }
  await setDigestMode(startMode);
})();
