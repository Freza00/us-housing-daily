// 前端主逻辑 — 单文件，无依赖
// 数据来自 /api/news 和 /api/dates

const $ = (id) => document.getElementById(id);
const newsList = $('newsList');
const filterbar = $('filterbar');
const datestrip = $('datestrip');
const updatedEl = $('updated');
const sourcesCountEl = $('sourcesCount');
const refreshBtn = $('refreshBtn');
const calendarDialog = $('calendarDialog');
const calGrid = $('calGrid');
const calTitle = $('calTitle');
const calPrev = $('calPrev');
const calNext = $('calNext');
const calClose = $('calClose');

const STORAGE_KEY = 'us-housing-active-tag';
let currentData = null;
let activeTag = sessionStorage.getItem(STORAGE_KEY) || '__all';
let availableDates = new Set();   // YYYY-MM-DD 字符串集合 — 哪些天有数据
let selectedDate = null;          // 当前正在看哪一天（null = 最新）
let calendarMonth = null;         // 日历 modal 当前显示的 {year, month0Indexed}

// ========== 工具 ==========
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const todayUTCKey = () => new Date().toISOString().slice(0, 10);
const dateKey = (y, m0, d) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

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
// 固定 filter 集 — 行业惯例 +  BTR 视角的核心 9 个 tag
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
    b.textContent = `${f.label} ${count}`;
    filterbar.appendChild(b);
  }
}

// ========== 渲染：一张 card ==========
// 利好利空 pill 配置
const IMPACT_LABELS = {
  'long-pos':  { text: '长期利好', cls: 'imp-lp' },
  'short-pos': { text: '短期利好', cls: 'imp-sp' },
  'neutral':   { text: '中性',     cls: 'imp-n'  },
  'short-neg': { text: '短期利空', cls: 'imp-sn' },
  'long-neg':  { text: '长期利空', cls: 'imp-ln' },
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
  // keyword tags — 用 canonical ID 渲染中文 label，按 4 维度排序
  const sorted = sortTags(it.tags || []).slice(0, 6);
  const keywordTags = sorted.map(id => {
    const isHeat = HEAT_TAGS.has(id);
    const dim = TAG_DIM[id] || 'topic';
    return `<span class="card-tag tag-${dim}${isHeat ? ' heat' : ''}" data-id="${escapeHtml(id)}">${escapeHtml(tagLabel(id))}</span>`;
  }).join('');
  // CRE 子类作为前置 prominent tag (仅在 CRE section 出现)
  const creTag = it.cre_subcategory
    ? `<span class="card-tag cre-cat">${escapeHtml(it.cre_subcategory)}</span>`
    : '';
  const numHtml = `<span class="card-num">${i}</span>`;
  const titleZh = it.title_zh
    ? `<div class="card-title-zh">${numHtml}${escapeHtml(it.title_zh)}</div>`
    : '';
  const titleEn = it.title_zh
    ? `<h2 class="card-title">${escapeHtml(it.title)}</h2>`
    : `<h2 class="card-title">${numHtml}${escapeHtml(it.title)}</h2>`;
  const stars = `<span class="card-stars" title="重要性 ${it.importance ?? 3}/5">${renderStars(it.importance)}</span>`;
  const impactCfg = IMPACT_LABELS[it.impact] || IMPACT_LABELS['neutral'];
  const impactPill = `<span class="impact-pill ${impactCfg.cls}">${impactCfg.text}</span>`;
  const extPill = it.extended_window
    ? `<span class="ext-pill" title="今日 24h 内该分类无新闻 — 此条来自 7 天扩窗回退">扩窗</span>`
    : '';
  return `
    <article class="card">
      <a class="card-link" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">
        ${titleZh}
        ${titleEn}
      </a>
      <p class="card-summary">${escapeHtml(it.summary_zh)}</p>
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

function renderItems(items) {
  if (items.length === 0) {
    newsList.innerHTML = '<div class="empty">这个标签下暂无新闻</div>';
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
      ? `<p class="section-empty">今日 24h 内无新内容</p>`
      : arr.map(it => renderCard(it, ++globalIdx)).join('');
    blocks.push(`
      <section class="news-section">
        <header class="section-head">
          <span class="section-emoji">${sec.emoji}</span>
          <h3 class="section-label">${escapeHtml(sec.label)}</h3>
          <span class="section-desc">${escapeHtml(sec.description || '')}</span>
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
    const wd = WEEKDAY_ZH[d.getUTCDay()];
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
  cells.push(`<button class="ds-more" id="dsMore" title="查看更早历史">更早</button>`);
  datestrip.innerHTML = cells.join('');
  // 自动滚到最右边（最新一天）
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
  calTitle.textContent = `${year} 年 ${month + 1} 月`;
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
async function loadNews(date) {
  newsList.innerHTML = '<div class="loader">加载中…</div>';
  try {
    const url = date ? `/data/${encodeURIComponent(date)}.json` : '/data/latest.json';
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    currentData = await r.json();
    selectedDate = currentData.date || null;
    updatedEl.textContent = '更新于 ' + new Date(currentData.generated_at).toLocaleString('zh-CN', {
      timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }) + ' (CT)';
    sourcesCountEl.textContent = `${currentData.sources_ok}/${currentData.sources_attempted}`;
    applyFilter();
    renderDateStrip();
  } catch (e) {
    newsList.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}<br><br>如果首次部署还没有数据，请手动触发一次 GitHub Actions workflow，或等明早 9 点 cron 自动跑。</div>`;
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

// ========== 事件 ==========
filterbar.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLButtonElement) || !t.dataset.tag) return;
  activeTag = t.dataset.tag;
  sessionStorage.setItem(STORAGE_KEY, activeTag);
  applyFilter();
});

refreshBtn.addEventListener('click', async () => {
  await loadAvailableDates();
  await loadNews(selectedDate || undefined);
});

datestrip.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'dsMore') {
    openCalendar();
    return;
  }
  if (t.classList.contains('ds-day') && t.dataset.date && !t.disabled) {
    loadNews(t.dataset.date);
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

// ========== 启动 ==========
(async () => {
  await loadAvailableDates();
  await loadNews();
})();
