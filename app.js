// 稿费记录 · App 主逻辑
import {
  CLOUD_KEY,
  STATUS_META,
  STATUSES,
  computeStats,
  createBackup,
  createState,
  customerServiceBreakdown,
  diffRecords,
  downloadTextFile,
  fileStamp,
  filterRecords,
  formatDate,
  formatDateTime,
  formatMoney,
  groupByMonth,
  inferReceived,
  monthLabel,
  monthlyTrend,
  normalizeRecord,
  normalizeState,
  parseAmount,
  parseBackup,
  pendingRecords,
  platformBreakdown,
  platformOf,
  previousPeriodStats,
  recordsInPeriod,
  recordsToCSV,
  relativeDay,
  todayISO,
  uid,
  visibleRecords
} from './lib.js';
import { CloudClient, describeError, syncOnce } from './sync.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const $ = selector => document.querySelector(selector);
const main = $('#main');
const headerEl = $('#app-header');
const sheetRoot = $('#sheet-root');
const toastEl = $('#toast');
const fab = $('#fab');
const tabbar = $('.tabbar');

const icon = (name, cls = '') =>
  `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const money = value => `¥${formatMoney(value)}`;
const moneyText = (value, empty = '—') =>
  value === null || value === undefined ? empty : money(value);

const isNarrow = () => window.matchMedia('(max-width: 360px)').matches;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function relativeTime(value) {
  if (!value) return '还没同步';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '还没同步';
  if (diff < 60_000) return '刚刚同步';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前同步`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前同步`;
  return `${formatDateTime(value)} 同步`;
}

function todayLabel(value) {
  if (!value) return '未填日期';
  return `${relativeDay(value)} · ${formatDate(value, 'full')}`;
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const ui = {
  tab: 'overview',
  period: 'month',
  query: '',
  filters: { year: '', platformId: '', status: '' },
  selection: null,
  syncing: false,
  syncError: '',
  sheet: null,
  lastSyncAt: ''
};

let state = loadState();
let cloud = createCloud();

function loadState() {
  try {
    const raw = localStorage.getItem('gaofei.state.v1');
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn('读取本地数据失败，使用空数据', error);
  }
  return createState();
}

function persist() {
  try {
    localStorage.setItem('gaofei.state.v1', JSON.stringify(state));
  } catch {
    toast('本机存储空间不足，建议先导出备份');
  }
}

function applyTheme() {
  const root = document.documentElement;
  if (state.settings.theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = state.settings.theme;
  applyThemeMeta();
}

function markDirty(id) {
  if (!id) return;
  if (!state.sync.dirty.includes(id)) state.sync.dirty.push(id);
}

function platformDirty() {
  state.sync.platformDirty = true;
}

function isLoggedIn() {
  return Boolean(cloud.configured && cloud.session);
}

/* ------------------------------------------------------------------ */
/* 云端                                                                */
/* ------------------------------------------------------------------ */

function readCloudConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
  } catch { /* ignore */ }
  const url = String(SUPABASE_URL || saved?.url || '').trim();
  const key = String(SUPABASE_ANON_KEY || saved?.key || '').trim();
  return { url, key };
}

function createCloud() {
  const { url, key } = readCloudConfig();
  return new CloudClient({ url, anonKey: key });
}

function syncStatus() {
  if (!cloud.configured) return { state: 'local', label: '本地' };
  if (!cloud.session) return { state: 'local', label: '未登录' };
  if (ui.syncing) return { state: 'syncing', label: '同步中' };
  if (!navigator.onLine) return { state: 'offline', label: '离线' };
  if (ui.syncError) return { state: 'error', label: '同步失败' };
  if (state.sync.dirty.length) return { state: 'pending', label: `待同步 ${state.sync.dirty.length}` };
  return { state: 'synced', label: relativeTime(state.sync.lastSyncedAt || ui.lastSyncAt) };
}

function paintSyncPill() {
  const pill = $('.sync-pill');
  if (!pill) return;
  const status = syncStatus();
  pill.dataset.state = status.state;
  pill.innerHTML = `<span class="dot"></span>${esc(status.label)}`;
}

let syncTimer = null;

function scheduleSync(delay = 1200) {
  if (!isLoggedIn() || !navigator.onLine) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), delay);
}

async function runSync({ manual = false } = {}) {
  if (ui.syncing) return;
  if (!cloud.configured) {
    if (manual) openSetup();
    return;
  }
  if (!cloud.session) {
    if (manual) openAuth();
    return;
  }
  if (!navigator.onLine) {
    if (manual) toast('现在没有网络，改动已经存在本机，联网后会自动同步');
    paintSyncPill();
    return;
  }
  ui.syncing = true;
  ui.syncError = '';
  paintSyncPill();
  try {
    const result = await syncOnce({ client: cloud, state });
    state.records = result.records;
    state.platforms = result.platforms;
    state.sync.dirty = result.dirty;
    state.sync.platformDirty = result.platformDirty;
    state.sync.lastPulledServerAt = result.cursor;
    state.sync.lastSyncedAt = result.syncedAt;
    ui.lastSyncAt = result.syncedAt;
    persist();
    render();
    if (result.conflicted) {
      toast(`有 ${result.conflicted} 条记录在另一台设备上更新过，已采用较新的版本`);
    } else if (manual) {
      toast(result.pushed || result.added ? '同步完成，数据已是最新' : '同步完成');
    }
  } catch (error) {
    ui.syncError = describeError(error);
    if (manual || !(error instanceof TypeError)) toast(ui.syncError, { timeout: 4200 });
  } finally {
    ui.syncing = false;
    paintSyncPill();
  }
}

/* ------------------------------------------------------------------ */
/* 轻提示                                                              */
/* ------------------------------------------------------------------ */

let toastTimer = null;
let toastAction = null;

function toast(message, { action = null, timeout = 2600 } = {}) {
  clearTimeout(toastTimer);
  toastAction = action;
  toastEl.innerHTML = `${esc(message)}${action ? `<span class="toast-action" data-action="toast-action">${esc(action.label)}</span>` : ''}`;
  toastEl.classList.add('is-show');
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-show');
    toastAction = null;
  }, timeout);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove('is-show');
  toastAction = null;
}

/* ------------------------------------------------------------------ */
/* 弹层                                                                */
/* ------------------------------------------------------------------ */

let sheetOpenedAt = 0;

function openSheet({ title, body, foot = '', onMount = null }) {
  closeSheet(true);
  const node = document.createElement('div');
  node.className = 'sheet-root';
  node.innerHTML = `
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grab"><span></span></div>
      <div class="sheet-head">
        <h2 class="sheet-title">${esc(title)}</h2>
        <button class="sheet-close" type="button" data-action="close-sheet" aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="sheet-body">${body}</div>
      ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}
    </div>`;
  sheetRoot.appendChild(node);
  sheetOpenedAt = Date.now();
  requestAnimationFrame(() => node.classList.add('is-open'));
  document.body.style.overflow = 'hidden';
  ui.sheet = node;
  bindSheetDrag(node);
  if (onMount) onMount(node);
  return node;
}

function closeSheet(immediate = false) {
  const node = ui.sheet;
  ui.sheet = null;
  document.body.style.overflow = '';
  if (!node) return;
  node.classList.remove('is-open');
  const remove = () => node.remove();
  if (immediate) remove();
  else setTimeout(remove, 380);
}

function bindSheetDrag(node) {
  const sheet = node.querySelector('.sheet');
  const grab = node.querySelector('.sheet-grab');
  if (!sheet || !grab) return;
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  const onDown = event => {
    dragging = true;
    startY = event.clientY;
    currentY = 0;
    sheet.classList.add('is-dragging');
    grab.setPointerCapture?.(event.pointerId);
  };
  const onMove = event => {
    if (!dragging) return;
    currentY = Math.max(0, event.clientY - startY);
    sheet.style.transform = `translate(-50%, ${currentY}px)`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
    if (currentY > 110) closeSheet();
    currentY = 0;
  };

  grab.addEventListener('pointerdown', onDown);
  grab.addEventListener('pointermove', onMove);
  grab.addEventListener('pointerup', onUp);
  grab.addEventListener('pointercancel', onUp);
}

/* ------------------------------------------------------------------ */
/* 页面渲染                                                            */
/* ------------------------------------------------------------------ */

const PAGE_TITLES = {
  overview: { kicker: '稿费记录', title: '概览' },
  records: { kicker: '全部记录', title: '明细' },
  settings: { kicker: '账号与数据', title: '我的' }
};

function render() {
  applyTheme();
  renderHeader();
  renderTabs();
  if (ui.tab === 'overview') renderOverview();
  else if (ui.tab === 'records') renderRecords();
  else renderSettings();
  fab.classList.toggle('is-hidden', ui.tab === 'settings');
  paintSyncPill();
}

function renderHeader() {
  const meta = PAGE_TITLES[ui.tab];
  const status = syncStatus();
  headerEl.innerHTML = `
    <div>
      <p class="head-kicker">${meta.kicker}</p>
      <h1 class="head-title">${meta.title}</h1>
    </div>
    <button class="sync-pill" type="button" data-action="sync" data-state="${status.state}" aria-label="同步状态：${esc(status.label)}">
      <span class="dot"></span>${esc(status.label)}
    </button>`;
}

function renderTabs() {
  tabbar.querySelectorAll('.tab').forEach(button => {
    button.classList.toggle('is-active', button.dataset.tab === ui.tab);
  });
  requestAnimationFrame(() => {
    const active = tabbar.querySelector('.tab.is-active');
    const indicator = $('#tab-indicator');
    if (!active || !indicator) return;
    indicator.style.left = `${active.offsetLeft}px`;
    indicator.style.width = `${active.offsetWidth}px`;
  });
}

function switchTab(tab) {
  if (ui.tab === tab) return;
  ui.tab = tab;
  ui.selection = null;
  closeSheet(true);
  render();
  window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

/* ---------------- 概览 ---------------- */

function periodRecords() {
  if (ui.period === 'all') return visibleRecords(state);
  return recordsInPeriod(state.records, ui.period);
}

function deltaText(period, stats, prev) {
  const word = period === 'month' ? '上月' : period === 'year' ? '去年' : '';
  if (!prev) return `共 ${stats.count} 笔记录`;
  if (prev.received <= 0) return `${word}同期还没有记录`;
  const diff = stats.received - prev.received;
  const pct = (diff / prev.received) * 100;
  if (Math.abs(diff) < 0.005) return `与${word}同期持平`;
  const sign = diff > 0 ? '+' : '−';
  return `较${word}同期 <span class="delta-strong">${sign}${formatMoney(Math.abs(diff))}（${sign}${Math.abs(pct).toFixed(1)}%）</span>`;
}

function sparkline(values) {
  const width = 300;
  const height = 36;
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  const points = values.map((value, index) => [
    index * step,
    height - 3 - (value / max) * (height - 8)
  ]);
  const line = smoothLine(points);
  return `<svg class="hero-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--gold);stop-opacity:.22"></stop>
        <stop offset="1" style="stop-color:var(--gold);stop-opacity:0"></stop>
      </linearGradient>
    </defs>
    <path d="${line} L${width},${height} L0,${height} Z" fill="url(#spark-fill)"></path>
    <path d="${line}" fill="none" style="stroke:var(--gold)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>`;
}

function smoothLine(points) {
  if (points.length < 2) return '';
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = ((previous[0] + current[0]) / 2).toFixed(1);
    path += ` C${midX},${previous[1].toFixed(1)} ${midX},${current[1].toFixed(1)} ${current[0].toFixed(1)},${current[1].toFixed(1)}`;
  }
  return path;
}

function trendCard(trend) {
  const max = Math.max(...trend.map(item => item.received), 1);
  const currentKey = todayISO().slice(0, 7);
  const bars = trend.map((item, index) => {
    const percent = item.received > 0 ? Math.max(4, Math.round((item.received / max) * 100)) : 2;
    const isCurrent = item.key === currentKey;
    return `<button class="bar-col${isCurrent ? ' is-current' : ''}${item.received ? '' : ' is-empty'}"
        type="button" data-action="month" data-key="${item.key}"
        aria-label="${item.year}年${item.month}月 到手${formatMoney(item.received)}">
        <span class="bar-track"><span class="bar" style="height:${percent}%"></span></span>
        <span class="bar-label">${item.month}</span>
      </button>`;
  }).join('');
  const total = trend.reduce((sum, item) => sum + item.received, 0);
  const pad = value => String(value).padStart(2, '0');
  const first = trend[0];
  const last = trend[trend.length - 1];
  const range = `${first.year}.${pad(first.month)} – ${last.year}.${pad(last.month)}`;
  return `<section class="card">
    <div class="section-head">
      <div>
        <h2 class="section-title">近 12 个月</h2>
        <p class="section-sub">${range} · 到手 ${money(total)}</p>
      </div>
      <span class="section-sub">${trend.filter(item => item.received > 0).length} 个月有进账</span>
    </div>
    <div class="trend">${bars}</div>
  </section>`;
}

function breakdownCard(title, sub, rows, action) {
  if (!rows.length) {
    return `<section class="card"><div class="section-head"><h2 class="section-title">${title}</h2></div>
      <p class="section-sub">还没有数据</p></section>`;
  }
  const max = Math.max(...rows.map(row => row.received), 1);
  return `<section class="card">
    <div class="section-head">
      <div><h2 class="section-title">${title}</h2><p class="section-sub">${sub}</p></div>
      ${action || ''}
    </div>
    <div class="breakdown">
      ${rows.map(row => `
        <button class="breakdown-row" type="button" data-action="${row.action || ''}" data-value="${esc(row.key ?? '')}" ${row.action ? '' : 'tabindex="-1"'}>
          <span class="breakdown-top">
            <span class="breakdown-name">${esc(row.name)}<span class="count">${row.count} 笔</span></span>
            <span class="breakdown-amount">${money(row.received)}</span>
          </span>
          <span class="meter"><span class="meter-fill${row.soft ? ' is-soft' : ''}" style="width:${Math.max(3, Math.round((row.received / max) * 100))}%"></span></span>
        </button>`).join('')}
    </div>
  </section>`;
}

function renderOverview() {
  const all = visibleRecords(state);
  const records = periodRecords();
  const stats = computeStats(records);
  const prev = previousPeriodStats(state.records, ui.period);
  const trend = monthlyTrend(all, new Date(), 12);
  const platforms = platformBreakdown(all, state.platforms);
  const services = customerServiceBreakdown(all).slice(0, 5);
  const diffs = diffRecords(all);
  const pending = pendingRecords(all);
  const pendingSum = pending.reduce((sum, record) => sum + Number(record.commission || 0), 0);
  const recent = filterRecords(all, {}).slice(0, 3);
  const diffSum = diffs.reduce((sum, item) => sum + item.diff, 0);

  const platformRows = platforms.filter(item => item.count).map(item => ({
    name: item.name,
    count: item.count,
    received: item.received,
    key: item.id,
    action: 'platform-detail'
  }));
  const serviceRows = services.map(item => ({
    name: item.name,
    count: item.count,
    received: item.received,
    key: item.name,
    action: 'service-detail',
    soft: true
  }));

  const recentHtml = recent.length ? `
    <section class="card">
      <div class="section-head">
        <h2 class="section-title">最近记录</h2>
        <button class="section-action" type="button" data-action="go-records">全部 ${icon('chevron')}</button>
      </div>
      <div class="plain-list">
        ${recent.map(record => `
          <button class="plain-row" type="button" data-action="open-record" data-id="${record.id}">
            <span class="grow">
              <span class="name">${esc(record.title || '未填作品')}</span>
              <span class="sub">${formatDate(record.orderedAt, 'short')} · ${esc(record.customerService || '未填客服')} · ${esc(platformOf(state, record.platformId).name)}</span>
            </span>
            <span class="amount">${record.received === null ? '<span class="muted">待到账</span>' : money(record.received)}</span>
          </button>`).join('')}
      </div>
    </section>` : '';

  const pendingHtml = pending.length ? `
    <section class="card reconcile" style="padding:16px 18px">
      <span class="reconcile-icon">${icon('wallet')}</span>
      <span class="reconcile-main">
        <span class="reconcile-title">${pending.length} 笔还没填到手</span>
        <span class="reconcile-sub">合计佣金 ${money(pendingSum)}，补全后统计更准</span>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" data-action="pending-detail">去补</button>
    </section>` : '';

  const diffHtml = diffs.length ? `
    <section class="card reconcile" data-action="open-reconcile" role="button" tabindex="0" style="cursor:pointer">
      <span class="reconcile-icon">${icon('sparkle')}</span>
      <span class="reconcile-main">
        <span class="reconcile-title">差额核对</span>
        <span class="reconcile-sub">${diffs.length} 笔的到手金额与佣金不一致</span>
      </span>
      <span class="reconcile-value">${money(diffSum)}</span>
    </section>` : '';

  const heroValue = formatMoney(stats.received);
  const heroClass = heroValue.length > 8 ? ' is-long' : '';

  main.innerHTML = `
    <div class="page stack stagger">
      <section class="hero">
        <div class="hero-top">
          <span class="hero-label">${ui.period === 'month' ? '本月到手' : ui.period === 'year' ? '本年到手' : '累计到手'}</span>
          <div class="segmented" role="tablist" aria-label="统计周期">
            <button type="button" data-action="period" data-value="month" class="${ui.period === 'month' ? 'is-active' : ''}">本月</button>
            <button type="button" data-action="period" data-value="year" class="${ui.period === 'year' ? 'is-active' : ''}">本年</button>
            <button type="button" data-action="period" data-value="all" class="${ui.period === 'all' ? 'is-active' : ''}">全部</button>
          </div>
        </div>
        <div class="hero-amount"><span class="cny">¥</span><span class="value${heroClass}" data-count="${stats.received}">0</span></div>
        <p class="hero-delta">${deltaText(ui.period, stats, prev)}</p>
        <div class="hero-metrics">
          <div class="metric"><span class="metric-label">接单佣金</span><span class="metric-value">${money(stats.commission)}</span></div>
          <div class="metric"><span class="metric-label">差额</span><span class="metric-value ${Math.abs(stats.diff) > 0.004 ? 'gold' : 'muted'}">${stats.diff === 0 ? '¥0' : money(stats.diff)}</span></div>
          <div class="metric"><span class="metric-label">单数</span><span class="metric-value">${stats.count}</span></div>
        </div>
        ${sparkline(trend.map(item => item.received))}
      </section>

      ${pendingHtml}
      ${trendCard(trend)}
      ${breakdownCard('平台构成', `共 ${platforms.reduce((sum, item) => sum + item.count, 0)} 笔`, platformRows)}
      ${breakdownCard('客服排行', '按到手金额排序', serviceRows)}
      ${diffHtml}
      ${recentHtml}
    </div>`;

  runCountUp();
}

function runCountUp() {
  const node = main.querySelector('[data-count]');
  if (!node) return;
  const target = Number(node.dataset.count) || 0;
  if (reduceMotion()) {
    node.textContent = formatMoney(target);
    return;
  }
  const duration = 620;
  const start = performance.now();
  const tick = now => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = formatMoney(target * eased);
    if (progress < 1) requestAnimationFrame(tick);
    else node.textContent = formatMoney(target);
  };
  requestAnimationFrame(tick);
}

/* ---------------- 明细 ---------------- */

function activeFilterCount() {
  return Object.values(ui.filters).filter(Boolean).length;
}

function renderChips() {
  const platformName = ui.filters.platformId ? platformOf(state, ui.filters.platformId).name : '全部平台';
  const statusName = ui.filters.status || '全部状态';
  return `
    <button class="chip ${ui.filters.year ? 'is-active' : ''}" type="button" data-action="filter-year">
      ${ui.filters.year || '全部年份'}${icon('chevron', 'sm')}
    </button>
    <button class="chip ${ui.filters.platformId ? 'is-active' : ''}" type="button" data-action="filter-platform">
      ${esc(platformName)}${icon('chevron', 'sm')}
    </button>
    <button class="chip ${ui.filters.status ? 'is-active' : ''}" type="button" data-action="filter-status">
      ${esc(statusName)}${icon('chevron', 'sm')}
    </button>
    ${ui.selection ? `<button class="chip is-active" type="button" data-action="exit-selection">取消选择</button>`
      : `${activeFilterCount() ? '<button class="chip is-ghost" type="button" data-action="clear-filters">清除筛选</button>' : ''}
         <button class="chip is-ghost" type="button" data-action="enter-selection">整理</button>`}`;
}

function filteredRecords() {
  return filterRecords(state.records, {
    query: ui.query,
    year: ui.filters.year,
    platformId: ui.filters.platformId,
    status: ui.filters.status
  });
}

function recordRow(record) {
  const platform = platformOf(state, record.platformId);
  const meta = STATUS_META[record.status] || STATUS_META['未标记'];
  const selected = ui.selection ? ui.selection.has(record.id) : false;
  const pending = record.received === null || record.received === undefined;
  return `<div class="record-wrap${selected ? ' is-selected' : ''}" data-id="${record.id}">
    <button class="record-delete" type="button" data-action="delete-record" data-id="${record.id}">删除</button>
    <div class="record" role="button" tabindex="0" aria-label="${esc(record.title || '未填作品')}">
      ${ui.selection ? `<span class="record-check">${icon('check', 'sm')}</span>` : ''}
      <span class="record-main">
        <span class="record-title${record.title ? '' : ' is-empty'}">${esc(record.title || '未填作品')}</span>
        <span class="record-meta">
          <span>${formatDate(record.orderedAt, 'short')}</span>
          <span class="sep"></span>
          <span>${esc(record.customerService || '未填客服')}</span>
          <span class="sep"></span>
          <span>${esc(platform.name)}</span>
        </span>
      </span>
      <span class="record-right">
        <span class="record-amount${pending ? ' is-pending' : ''}">${pending ? '待到账' : money(record.received)}</span>
        <span class="status-dot"><i style="background:${meta.dot}"></i>${record.status}${record.receivedInferred ? ' · 自动' : ''}</span>
      </span>
    </div>
  </div>`;
}

function renderRecordGroups() {
  const host = $('#record-groups');
  if (!host) return;
  const records = filteredRecords();
  if (!records.length) {
    host.innerHTML = `<div class="card empty">
      <svg class="empty-art" viewBox="0 0 100 64" aria-hidden="true">
        <rect x="18" y="12" width="64" height="42" rx="9" fill="none" style="stroke:var(--hairline-strong)" stroke-width="1.4"/>
        <path d="M30 26h40M30 34h28M30 42h20" fill="none" style="stroke:var(--ink-4)" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <p class="empty-title">${activeFilterCount() || ui.query ? '没有符合筛选的记录' : '还没有记录'}</p>
      <p class="empty-desc">${activeFilterCount() || ui.query ? '换个条件试试，或者清除筛选' : '点右下角的 +，先记下第一笔稿费'}</p>
      <button class="btn btn-primary btn-sm" type="button" data-action="new">记一笔</button>
    </div>`;
    return;
  }
  const groups = groupByMonth(records);
  host.innerHTML = groups.map(group => `
    <section class="month-group">
      <div class="month-head">
        <span class="month-label">${group.label}</span>
        <span class="month-sum">到手 ${money(group.received)} · ${group.records.length} 笔</span>
      </div>
      <div class="record-list">${group.records.map(recordRow).join('')}</div>
    </section>`).join('');
}

function renderSelectionBar() {
  const host = $('#selection-bar');
  if (!host) return;
  if (!ui.selection) {
    host.innerHTML = '';
    return;
  }
  const count = ui.selection.size;
  host.innerHTML = `<div class="selection-bar">
    <span class="selection-count">已选 ${count} 笔</span>
    <button class="btn btn-primary btn-sm" type="button" data-action="bulk-complete" ${count ? '' : 'disabled'}>标记已完成</button>
    <button class="btn btn-secondary btn-sm" type="button" data-action="exit-selection">取消</button>
  </div>`;
}

function renderRecords() {
  const total = filteredRecords();
  const sum = total.reduce((acc, record) => acc + (Number(record.received) || 0), 0);
  main.innerHTML = `
    <div class="page stack-tight">
      <label class="search-bar">
        ${icon('search', 'sm')}
        <input id="search-input" type="search" inputmode="search" placeholder="搜作品、订单号、客服、备注" value="${esc(ui.query)}" autocomplete="off">
      </label>
      <div class="filter-row">${renderChips()}</div>
      <p class="section-sub" style="padding:2px 4px 0" id="records-summary">${total.length} 笔 · 到手 ${money(sum)}</p>
      <div id="record-groups"></div>
      <div id="selection-bar"></div>
    </div>`;
  renderRecordGroups();
  renderSelectionBar();
  const input = $('#search-input');
  if (input && ui.query) input.value = ui.query;
}

/* ---------------- 设置 ---------------- */

function settingsRow({ action, iconName, label, value = '', arrow = true, id = '' }) {
  return `<button class="settings-row" type="button" data-action="${action}"${id ? ` data-id="${id}"` : ''}>
    <span class="settings-icon">${icon(iconName)}</span>
    <span class="settings-main"><span class="settings-label">${esc(label)}</span>${value ? `<span class="settings-value">${esc(value)}</span>` : ''}</span>
    ${arrow ? `<span class="chevron">${icon('chevron')}</span>` : ''}
  </button>`;
}

function renderSettings() {
  const logged = isLoggedIn();
  const status = syncStatus();
  const email = cloud.session?.email || state.sync.email || '';
  const totalRecords = visibleRecords(state).length;
  const themeLabel = state.settings.theme === 'system' ? '跟随系统' : state.settings.theme === 'light' ? '浅色' : '深色';
  const host = (() => {
    try { return new URL(cloud.url).host; } catch { return ''; }
  })();

  main.innerHTML = `
    <div class="page stack stagger">
      <section class="card profile-card">
        <div class="profile-top">
          <span class="avatar">${email ? esc(email.slice(0, 1).toUpperCase()) : '本'}</span>
          <div style="flex:1;min-width:0">
            <p class="profile-name">${email ? esc(email.split('@')[0]) : '本地模式'}</p>
            <p class="profile-sub">${email ? esc(email) : '数据只在这台设备上，登录后可多设备同步'}</p>
          </div>
        </div>
        <div class="hero-metrics" style="margin-top:0;padding-top:14px">
          <div class="metric"><span class="metric-label">记录</span><span class="metric-value">${totalRecords} 笔</span></div>
          <div class="metric"><span class="metric-label">同步</span><span class="metric-value ${status.state === 'error' ? 'tone-danger' : ''}">${esc(status.label)}</span></div>
          <div class="metric"><span class="metric-label">待上传</span><span class="metric-value">${state.sync.dirty.length} 条</span></div>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn ${logged ? 'btn-secondary' : 'btn-primary'} btn-sm" style="flex:1" type="button" data-action="${logged ? 'sync' : 'open-auth'}">
            ${logged ? '立即同步' : '登录云端'}
          </button>
          ${logged ? `<button class="btn btn-secondary btn-sm" type="button" data-action="logout">退出</button>` : ''}
        </div>
      </section>

      <section class="settings-group">
        ${settingsRow({ action: 'open-import', iconName: 'upload', label: '导入备份', value: '选择 App 导出的 JSON 文件' })}
        ${settingsRow({ action: 'export-backup', iconName: 'download', label: '导出备份', value: '换机、清缓存前先存一份' })}
        ${settingsRow({ action: 'export-csv', iconName: 'download', label: '导出 CSV', value: '可用 Excel 打开' })}
      </section>

      <section class="settings-group">
        ${settingsRow({ action: 'open-platforms', iconName: 'list', label: '平台管理', value: `${state.platforms.length} 个平台` })}
        ${settingsRow({ action: 'open-setup', iconName: 'cloud', label: '云端配置', value: host || '还没配置 Supabase' })}
        ${settingsRow({ action: 'open-diagnostics', iconName: 'shield', label: '同步诊断', value: '网络、登录、读写自检' })}
      </section>

      <section class="settings-group">
        ${settingsRow({ action: 'cycle-theme', iconName: 'sparkle', label: '外观', value: themeLabel })}
        ${settingsRow({ action: 'open-install', iconName: 'info', label: '安装到桌面', value: '像 App 一样全屏使用' })}
        ${settingsRow({ action: 'open-about', iconName: 'info', label: '关于稿费记录', value: 'v1.0 · 本地优先' })}
      </section>

      <p class="about-note">
        数据默认只保存在本机浏览器；开启云端同步后，每台设备登录同一账号即可自动同步。<br>
        换手机、清理浏览器数据前，请先导出一份 JSON 备份。
      </p>
    </div>`;

  paintSyncPill();
}

/* ------------------------------------------------------------------ */
/* 记录表单                                                            */
/* ------------------------------------------------------------------ */

let draft = null;

function defaultPlatformId() {
  return state.platforms[0]?.id || '';
}

function openRecordForm(record = null) {
  const isEdit = Boolean(record && record.id);
  const base = record || normalizeRecord({
    id: '',
    platformId: defaultPlatformId(),
    orderedAt: todayISO(),
    status: '已完成',
    commission: 0,
    received: null
  });
  draft = {
    id: record?.id || '',
    platformId: base.platformId || defaultPlatformId(),
    orderedAt: base.orderedAt || todayISO(),
    status: base.status || '已完成',
    title: base.title || '',
    customerService: base.customerService || '',
    orderNo: base.orderNo || '',
    externalId: base.externalId || '',
    commissionText: record ? String(base.commission ?? '') : '',
    // 之前按「全额自动」算出来的到手不要预填，否则改了佣金后到手会被冻结成旧值
    receivedText: record && base.received !== null && !base.receivedInferred ? String(base.received) : '',
    note: base.note || '',
    createdAt: base.createdAt,
    source: base.source || null,
    openMore: Boolean(record)
  };
  const body = `
    <div class="amount-field">
      <p class="amount-label">接单佣金</p>
      <div class="amount-input-wrap">
        <span class="cny">¥</span>
        <input class="amount-input" id="commission-input" type="text" inputmode="decimal" placeholder="0" value="${esc(draft.commissionText)}" data-field="commissionText" autocomplete="off" aria-label="接单佣金">
      </div>
    </div>

    <div class="field">
      <div class="field-label">平台</div>
      <div class="chip-select" data-group="platform">
        ${state.platforms.map(platform => `<button class="chip-option ${platform.id === draft.platformId ? 'is-active' : ''}" type="button" data-pick="platformId" data-value="${platform.id}"><i style="background:${platform.color}"></i>${esc(platform.name)}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <div class="field-label">状态</div>
      <div class="chip-select" data-group="status">
        ${STATUSES.map(status => `<button class="chip-option ${status === draft.status ? 'is-active' : ''}" type="button" data-pick="status" data-value="${status}"><i style="background:${STATUS_META[status].dot}"></i>${status}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <div class="field-label">订单时间</div>
      <div class="chip-select" style="margin-bottom:9px">
        <button class="chip-option" type="button" data-date-quick="0">今天</button>
        <button class="chip-option" type="button" data-date-quick="1">昨天</button>
      </div>
      <input class="field-input" type="date" data-field="orderedAt" value="${draft.orderedAt}">
    </div>

    <div id="inferred-slot"></div>

    <button class="more-toggle${draft.openMore ? ' is-open' : ''}" type="button" data-action="toggle-more">
      <span>作品、客服、备注等</span>${icon('chevron')}
    </button>

    <div class="more-body${draft.openMore ? ' is-open' : ''}" id="more-body">
      <div class="field">
        <div class="field-label">作品 <span class="optional">选填</span></div>
        <input class="field-input" type="text" data-field="title" value="${esc(draft.title)}" placeholder="例如：乡村振兴调研报告" autocomplete="off">
      </div>
      <div class="field">
        <div class="field-grid">
          <div><div class="field-label">客服</div><input class="field-input" type="text" data-field="customerService" value="${esc(draft.customerService)}" placeholder="例如：陈慧" autocomplete="off"></div>
          <div><div class="field-label">订单号</div><input class="field-input" type="text" data-field="orderNo" value="${esc(draft.orderNo)}" placeholder="平台订单号" autocomplete="off"></div>
        </div>
      </div>
      <div class="field">
        <div class="field-label">客户 ID <span class="optional">原表「订单id」</span></div>
        <input class="field-input" type="text" data-field="externalId" value="${esc(draft.externalId)}" placeholder="例如：tb79571727" autocomplete="off">
      </div>
      <div class="field">
        <div class="field-label">到手金额 <span class="optional">留空 = 按全额自动</span></div>
        <input class="field-input" type="text" inputmode="decimal" data-field="receivedText" value="${esc(draft.receivedText)}" placeholder="不填就按接单佣金算全额" autocomplete="off">
      </div>
      <div class="field">
        <div class="field-label">备注 <span class="optional">选填</span></div>
        <textarea class="field-textarea" data-field="note" placeholder="退款、查重费、修改要求…">${esc(draft.note)}</textarea>
      </div>
    </div>`;

  const foot = `
    <button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="save-record" data-continue="1">保存并继续</button>
    <button class="btn btn-primary btn-sm" style="flex:1.4" type="button" data-action="save-record">${isEdit ? '保存修改' : '保存'}</button>`;

  openSheet({
    title: isEdit ? '编辑记录' : '记一笔',
    body,
    foot,
    onMount: node => {
      refreshInferred(node);
      if (!isEdit) {
        const input = node.querySelector('#commission-input');
        input?.focus({ preventScroll: true });
      }
    }
  });
}

function draftCommission() {
  return Math.max(0, parseAmount(draft.commissionText));
}

function refreshInferred(node = ui.sheet) {
  const slot = node?.querySelector('#inferred-slot');
  if (!slot) return;
  const commission = draftCommission();
  const note = draft.note.trim();
  const receivedText = draft.receivedText.trim();
  if (receivedText !== '' || commission <= 0) {
    slot.innerHTML = '';
    return;
  }
  const guess = inferReceived({
    status: draft.status,
    note,
    received: null,
    commission
  });
  if (!guess.inferred) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `<div class="inferred-row">
    <span>按「已完成 + 无备注」自动算：到手 <strong>${money(guess.received)}</strong></span>
    <button class="btn btn-ghost" type="button" data-action="fill-received">改为手填</button>
  </div>`;
}

function openEditRecord(id) {
  const record = state.records.find(item => item.id === id && !item.deletedAt);
  if (!record) return;
  openRecordForm(record);
}

function saveDraft({ continueNext = false } = {}) {
  if (!draft) return;
  if (!draft.platformId) {
    toast('先选一个平台');
    return;
  }
  const commission = draftCommission();
  const note = draft.note.trim();
  const receivedText = draft.receivedText.trim();
  let received = receivedText === '' ? null : Math.max(0, parseAmount(receivedText));
  let inferred = false;
  if (received === null) {
    const guess = inferReceived({ status: draft.status, note, received: null, commission });
    received = guess.received;
    inferred = guess.inferred;
  }
  const now = new Date().toISOString();
  const existing = draft.id ? state.records.find(item => item.id === draft.id) : null;
  const record = normalizeRecord({
    id: draft.id || uid(),
    platformId: draft.platformId,
    orderedAt: draft.orderedAt || todayISO(),
    orderNo: draft.orderNo,
    externalId: draft.externalId,
    customerService: draft.customerService,
    title: draft.title,
    commission,
    received,
    receivedInferred: inferred,
    note,
    status: draft.status,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    source: existing?.source || null
  });

  if (existing) state.records = state.records.map(item => (item.id === record.id ? record : item));
  else state.records = [...state.records, record];
  markDirty(record.id);
  persist();
  scheduleSync();

  if (continueNext && !draft.id) {
    draft.commissionText = '';
    draft.title = '';
    draft.note = '';
    draft.receivedText = '';
    draft.orderNo = '';
    draft.externalId = '';
    openRecordForm();
    toast('已保存，继续记下一笔');
  } else {
    closeSheet();
    toast(draft.id ? '已保存修改' : '已记入本机');
  }
  render();
}

function deleteRecord(id, { silent = false } = {}) {
  const record = state.records.find(item => item.id === id);
  if (!record || record.deletedAt) return;
  const now = new Date().toISOString();
  record.deletedAt = now;
  record.updatedAt = now;
  markDirty(id);
  persist();
  render();
  scheduleSync();
  if (!silent) {
    toast('已删除', {
      action: {
        label: '撤销',
        run: () => {
          const target = state.records.find(item => item.id === id);
          if (!target) return;
          target.deletedAt = null;
          target.updatedAt = new Date().toISOString();
          markDirty(id);
          persist();
          render();
          scheduleSync();
        }
      },
      timeout: 4200
    });
  }
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

function openDetail(id) {
  const record = state.records.find(item => item.id === id && !item.deletedAt);
  if (!record) return;
  const platform = platformOf(state, record.platformId);
  const meta = STATUS_META[record.status] || STATUS_META['未标记'];
  const pending = record.received === null || record.received === undefined;
  const diff = pending ? 0 : (Number(record.commission) || 0) - (Number(record.received) || 0);
  const amountHtml = pending
    ? '<p class="detail-amount is-pending">待到账</p>'
    : `<p class="detail-amount"><span class="cny">¥</span>${formatMoney(record.received)}</p>`;
  const body = `
    <div class="detail-hero">
      ${amountHtml}
      <p class="detail-title">${esc(record.title || '未填作品')}</p>
      <div class="detail-badges">
        <span class="badge"><i style="background:${meta.dot};color:${meta.dot}"></i>${record.status}</span>
        <span class="badge">${esc(platform.name)}</span>
        ${record.receivedInferred ? '<span class="badge is-gold">按全额推定</span>' : ''}
      </div>
    </div>
    <dl class="detail-list">
      <div class="detail-row"><dt>日期</dt><dd>${formatDate(record.orderedAt, 'full')}</dd></div>
      <div class="detail-row"><dt>客服</dt><dd>${esc(record.customerService || '—')}</dd></div>
      <div class="detail-row"><dt>订单号</dt><dd class="mono">${esc(record.orderNo || '—')}</dd></div>
      <div class="detail-row"><dt>客户 ID</dt><dd>${esc(record.externalId || '—')}</dd></div>
      <div class="detail-row"><dt>接单佣金</dt><dd class="mono">${money(record.commission)}</dd></div>
      <div class="detail-row"><dt>到手金额</dt><dd class="mono">${pending ? '待到账' : money(record.received)}</dd></div>
      ${Math.abs(diff) > 0.004 ? `<div class="detail-row"><dt>差额</dt><dd class="mono gold">${money(diff)}</dd></div>` : ''}
      <div class="detail-row"><dt>备注</dt><dd>${esc(record.note || '—')}</dd></div>
      <div class="detail-row"><dt>更新时间</dt><dd>${formatDateTime(record.updatedAt)}</dd></div>
    </dl>
    <div class="detail-actions">
      <button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="edit-record" data-id="${record.id}">${icon('edit')}编辑</button>
      <button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="copy-record" data-id="${record.id}">${icon('copy')}复制</button>
      <button class="btn btn-danger btn-sm" type="button" data-action="delete-record" data-id="${record.id}" style="padding:0 16px">${icon('trash')}</button>
    </div>`;
  openSheet({ title: '记录详情', body });
}

/* ------------------------------------------------------------------ */
/* 筛选项 / 列表弹层                                                    */
/* ------------------------------------------------------------------ */

let pendingPick = null;

function openOptionSheet({ title, options, value, onPick }) {
  pendingPick = onPick;
  const body = `<div class="plain-list">
    ${options.map(option => `<button class="plain-row" type="button" data-action="option-pick" data-value="${esc(option.value)}">
      <span class="grow"><span class="name">${esc(option.label)}</span>${option.sub ? `<span class="sub">${esc(option.sub)}</span>` : ''}</span>
      ${option.value === value ? `<span class="gold">${icon('check', 'sm')}</span>` : ''}
    </button>`).join('')}
  </div>`;
  openSheet({ title, body });
}

function openFilterYear() {
  const years = [...new Set(visibleRecords(state).map(record => record.orderedAt.slice(0, 4)))].sort().reverse();
  openOptionSheet({
    title: '按年份',
    value: ui.filters.year,
    options: [{ label: '全部年份', value: '' }, ...years.map(year => ({ label: `${year} 年`, value: year }))],
    onPick: value => {
      ui.filters.year = value;
      render();
    }
  });
}

function openFilterPlatform() {
  openOptionSheet({
    title: '按平台',
    value: ui.filters.platformId,
    options: [
      { label: '全部平台', value: '' },
      ...state.platforms.map(platform => ({ label: platform.name, value: platform.id }))
    ],
    onPick: value => {
      ui.filters.platformId = value;
      render();
    }
  });
}

function openFilterStatus() {
  openOptionSheet({
    title: '按状态',
    value: ui.filters.status,
    options: [{ label: '全部状态', value: '' }, ...STATUSES.map(status => ({ label: status, value: status }))],
    onPick: value => {
      ui.filters.status = value;
      render();
    }
  });
}

function openRecordsSheet(title, records) {
  const sum = records.reduce((acc, record) => acc + (Number(record.received) || 0), 0);
  const body = `${records.length ? `<div class="plain-list">${records.map(record => `
    <button class="plain-row" type="button" data-action="open-record" data-id="${record.id}">
      <span class="grow">
        <span class="name">${esc(record.title || '未填作品')}</span>
        <span class="sub">${formatDate(record.orderedAt, 'short')} · ${esc(platformOf(state, record.platformId).name)}${record.receivedInferred ? ' · 自动全额' : ''}</span>
      </span>
      <span class="amount">${record.received === null ? '<span class="muted">待到账</span>' : money(record.received)}</span>
    </button>`).join('')}</div>`
    : '<div class="empty"><p class="empty-title">这里还没有记录</p></div>'}
    <p class="about-note">共 ${records.length} 笔 · 到手 ${money(sum)}</p>`;
  openSheet({ title, body });
}

/* ------------------------------------------------------------------ */
/* 登录 / 云端配置 / 诊断                                               */
/* ------------------------------------------------------------------ */

let authMode = 'signin';

function openAuth() {
  if (!cloud.configured) {
    openSetup();
    return;
  }
  authMode = 'signin';
  openSheet({
    title: '登录云端',
    body: authBody(),
    foot: `<button class="btn btn-primary btn-block" type="button" data-action="auth-submit">登录</button>`,
    onMount: node => {
      node.querySelector('#auth-email')?.focus({ preventScroll: true });
    }
  });
}

function authBody() {
  return `
    <div class="auth-tabs">
      <div class="segmented" style="width:100%">
        <button type="button" data-auth-mode="signin" class="${authMode === 'signin' ? 'is-active' : ''}" style="flex:1">登录</button>
        <button type="button" data-auth-mode="signup" class="${authMode === 'signup' ? 'is-active' : ''}" style="flex:1">注册</button>
      </div>
    </div>
    <div class="field" style="margin-top:0">
      <div class="field-label">邮箱</div>
      <input class="field-input" id="auth-email" type="email" inputmode="email" placeholder="you@example.com" autocomplete="email">
    </div>
    <div class="field">
      <div class="field-label">密码 <span class="optional">至少 6 位</span></div>
      <input class="field-input" id="auth-password" type="password" placeholder="" autocomplete="current-password">
    </div>
    <div class="form-error" id="auth-error"></div>
    <p class="auth-note">
      用一个免费 Supabase 项目存放数据：登录后手机和电脑会共用同一份稿费记录。<br>
      第一次用请先到 Supabase → Authentication → Providers → Email 关闭「Confirm email」。
    </p>`;
}

async function submitAuth() {
  const email = ui.sheet?.querySelector('#auth-email')?.value.trim() || '';
  const password = ui.sheet?.querySelector('#auth-password')?.value || '';
  const errorBox = ui.sheet?.querySelector('#auth-error');
  const setError = message => {
    if (errorBox) errorBox.textContent = message;
  };
  setError('');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setError('请填写有效的邮箱地址');
    return;
  }
  if (password.length < 6) {
    setError('密码至少 6 位');
    return;
  }
  const button = ui.sheet?.querySelector('[data-action="auth-submit"]');
  if (button) {
    button.disabled = true;
    button.textContent = authMode === 'signin' ? '登录中…' : '注册中…';
  }
  try {
    const session = authMode === 'signin'
      ? await cloud.signIn(email, password)
      : await cloud.signUp(email, password);
    state.sync.email = session.email || email;
    state.sync.userId = session.userId;
    state.sync.lastPulledServerAt = '';
    persist();
    closeSheet();
    toast(authMode === 'signin' ? '已登录，开始同步' : '注册成功，开始同步');
    render();
    runSync();
  } catch (error) {
    setError(describeError(error));
    if (button) {
      button.disabled = false;
      button.textContent = authMode === 'signin' ? '登录' : '注册';
    }
  }
}

function openSetup() {
  const config = readCloudConfig();
  openSheet({
    title: '连接 Supabase',
    body: `
      <div class="field" style="margin-top:0">
        <div class="field-label">Project URL</div>
        <input class="field-input" id="setup-url" type="url" inputmode="url" placeholder="https://xxxx.supabase.co" value="${esc(config.url)}">
      </div>
      <div class="field">
        <div class="field-label">anon public key</div>
        <input class="field-input" id="setup-key" type="text" placeholder="eyJhbGciOi…" value="${esc(config.key)}">
      </div>
      <div class="form-error" id="setup-error"></div>
      <p class="auth-note">
        这两个值在 Supabase 项目 → Project Settings → API 里。<br>
        anon key 是公开的，数据安全由数据库的行级权限保证，不会泄露给别人。
      </p>`,
    foot: `
      <button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="test-setup">测试连接</button>
      <button class="btn btn-primary btn-sm" style="flex:1.3" type="button" data-action="save-setup">保存</button>`
  });
}

async function testSetup() {
  const url = ui.sheet?.querySelector('#setup-url')?.value.trim().replace(/\/+$/, '') || '';
  const key = ui.sheet?.querySelector('#setup-key')?.value.trim() || '';
  const box = ui.sheet?.querySelector('#setup-error');
  if (!url || !key) {
    if (box) box.textContent = 'URL 和 key 都要填';
    return;
  }
  if (box) {
    box.textContent = '正在连接…';
    box.classList.remove('form-ok');
  }
  try {
    const test = new CloudClient({ url, anonKey: key, store: cloud.store });
    await test.request('/auth/v1/health', { auth: false });
    if (box) {
      box.textContent = '连接成功，可以保存了';
      box.classList.add('form-ok');
    }
  } catch (error) {
    if (box) box.textContent = `连接失败：${describeError(error)}`;
  }
}

function saveSetup() {
  const url = ui.sheet?.querySelector('#setup-url')?.value.trim().replace(/\/+$/, '') || '';
  const key = ui.sheet?.querySelector('#setup-key')?.value.trim() || '';
  const box = ui.sheet?.querySelector('#setup-error');
  if (!/^https?:\/\//.test(url) || !key) {
    if (box) box.textContent = 'URL 需要以 https:// 开头，key 不能为空';
    return;
  }
  localStorage.setItem(CLOUD_KEY, JSON.stringify({ url, key }));
  cloud = createCloud();
  closeSheet();
  toast('云端配置已保存');
  render();
  if (!cloud.session) setTimeout(() => openAuth(), 320);
}

async function openDiagnostics() {
  openSheet({
    title: '同步诊断',
    body: `
      <p class="section-sub" style="margin-bottom:8px">逐项检查手机到云端的链路。</p>
      <div id="diag-list">
        ${[
          ['config', '云端配置'],
          ['network', '网络可达'],
          ['auth', '登录状态'],
          ['read', '读取数据'],
          ['write', '写入测试']
        ].map(([key, label]) => `<div class="check-row" data-check="${key}">
          <span>${label}</span>
          <span class="check-status">等待</span>
        </div>`).join('')}
      </div>`,
    foot: `<button class="btn btn-primary btn-block" type="button" data-action="run-diagnostics">开始检查</button>`
  });
}

async function runDiagnostics() {
  const set = (key, status, text) => {
    const row = ui.sheet?.querySelector(`[data-check="${key}"]`);
    if (!row) return;
    row.classList.toggle('is-ok', status === 'ok');
    row.classList.toggle('is-fail', status === 'fail');
    const target = row.querySelector('.check-status');
    if (target) target.textContent = text;
  };
  ['config', 'network', 'auth', 'read', 'write'].forEach(key => set(key, '', '等待'));

  if (!cloud.configured) {
    set('config', 'fail', '未配置');
    return;
  }
  set('config', 'ok', '已配置');

  try {
    const probe = new CloudClient({ url: cloud.url, anonKey: cloud.anonKey, store: cloud.store });
    await probe.request('/auth/v1/health', { auth: false });
    set('network', 'ok', '正常');
  } catch (error) {
    set('network', 'fail', error.status ? `HTTP ${error.status}` : '连不上');
    return;
  }

  if (!cloud.session) {
    set('auth', 'fail', '未登录');
    return;
  }
  try {
    await cloud.ensureSession();
    set('auth', 'ok', '已登录');
  } catch (error) {
    set('auth', 'fail', describeError(error));
    return;
  }

  try {
    await cloud.pullRows('records', { limit: 3 });
    set('read', 'ok', '正常');
  } catch (error) {
    set('read', 'fail', describeError(error));
    return;
  }

  try {
    const id = `diag-${Date.now()}`;
    const now = new Date().toISOString();
    await cloud.upsertRows('records', [{
      id,
      platform_id: state.platforms[0].id,
      ordered_at: todayISO(),
      order_no: '',
      external_id: '',
      customer_service: '',
      title: '诊断记录',
      commission: 0,
      received: null,
      received_inferred: false,
      note: '',
      status: '未标记',
      created_at: now,
      updated_at: now,
      deleted_at: null
    }]);
    await cloud.request(`/rest/v1/records?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    set('write', 'ok', '正常');
  } catch (error) {
    set('write', 'fail', describeError(error));
  }
}

/* ------------------------------------------------------------------ */
/* 平台管理                                                            */
/* ------------------------------------------------------------------ */

function openPlatforms() {
  const body = `<div class="plain-list">
    ${state.platforms.map(platform => {
      const count = state.records.filter(record => !record.deletedAt && record.platformId === platform.id).length;
      return `<button class="plain-row" type="button" data-action="edit-platform" data-id="${platform.id}">
        <span class="grow">
          <span class="name"><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${platform.color};margin-right:7px"></i>${esc(platform.name)}</span>
          <span class="sub">${count} 笔记录</span>
        </span>
        <span class="chevron muted">${icon('chevron', 'sm')}</span>
      </button>`;
    }).join('')}
  </div>
  <button class="btn btn-secondary btn-block" style="margin-top:16px" type="button" data-action="add-platform">新增平台</button>`;
  openSheet({ title: '平台管理', body });
}

function openPlatformEditor(platform = null) {
  const isEdit = Boolean(platform);
  openSheet({
    title: isEdit ? '编辑平台' : '新增平台',
    body: `
      <div class="field" style="margin-top:0">
        <div class="field-label">名称</div>
        <input class="field-input" id="platform-name" type="text" value="${esc(platform?.name || '')}" placeholder="例如：小红书代写">
      </div>
      <div class="form-error" id="platform-error"></div>
      <p class="auth-note">平台只是给记录分类，不影响金额。改名会同步到其他设备。</p>`,
    foot: isEdit
      ? `<button class="btn btn-danger btn-sm" type="button" data-action="delete-platform" data-id="${platform.id}">删除</button>
         <button class="btn btn-primary btn-sm" style="flex:1" type="button" data-action="save-platform" data-id="${platform.id}">保存</button>`
      : `<button class="btn btn-primary btn-block" type="button" data-action="save-platform">创建</button>`,
    onMount: node => node.querySelector('#platform-name')?.focus({ preventScroll: true })
  });
}

function savePlatform(id = '') {
  const name = ui.sheet?.querySelector('#platform-name')?.value.trim() || '';
  const errorBox = ui.sheet?.querySelector('#platform-error');
  if (!name) {
    if (errorBox) errorBox.textContent = '名称不能为空';
    return;
  }
  if (id) {
    const platform = state.platforms.find(item => item.id === id);
    if (platform) {
      platform.name = name;
      platform.updatedAt = new Date().toISOString();
    }
  } else {
    state.platforms.push({
      id: uid('plat'),
      name,
      color: ['#b08a57', '#7a8b99', '#8c7e9b', '#7e9b8a', '#a06a6a'][state.platforms.length % 5],
      sort: state.platforms.length + 1,
      updatedAt: new Date().toISOString(),
      deletedAt: null
    });
  }
  platformDirty();
  persist();
  closeSheet();
  render();
  scheduleSync();
  toast(id ? '平台已更新' : '平台已创建');
}

function deletePlatform(id) {
  const platform = state.platforms.find(item => item.id === id);
  if (!platform) return;
  const count = state.records.filter(record => !record.deletedAt && record.platformId === id).length;
  if (count) {
    toast(`这个平台下还有 ${count} 笔记录，先改到别的平台再删`);
    return;
  }
  platform.deletedAt = new Date().toISOString();
  platform.updatedAt = new Date().toISOString();
  state.platforms = state.platforms.filter(item => item.id !== id);
  platformDirty();
  persist();
  closeSheet();
  render();
  scheduleSync();
  toast('平台已删除');
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

const fileInput = $('#file-input');

function openImport() {
  fileInput.value = '';
  fileInput.click();
}

let pendingImported = null;

function mergeImported(imported) {
  const byId = new Map(state.records.map(record => [record.id, record]));
  imported.records.forEach(record => byId.set(record.id, record));
  state.records = [...byId.values()];

  const platformIds = new Set(state.platforms.map(platform => platform.id));
  imported.platforms.forEach(platform => {
    if (!platformIds.has(platform.id)) state.platforms.push(platform);
  });
  state.platforms.sort((a, b) => a.sort - b.sort);
  imported.records.forEach(record => markDirty(record.id));
  persist();
  render();
  return imported.records.length;
}

async function importFile(file) {
  try {
    const text = await file.text();
    const imported = parseBackup(text);
    pendingImported = imported;
    openSheet({
      title: '确认导入',
      body: `<p class="onboard-desc">将导入 <strong>${imported.records.length}</strong> 条记录、<strong>${imported.platforms.length}</strong> 个平台。<br>
        ID 相同的记录会以备份文件为准；导入后本机记录会标记为待同步。</p>
        <p class="auth-note">导入不会删除本机其他记录。如果只是想在手机上恢复数据，也可以直接登录云端拉取。</p>`,
      foot: `<button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="close-sheet">取消</button>
             <button class="btn btn-primary btn-sm" style="flex:1.3" type="button" data-action="confirm-import">导入</button>`
    });
  } catch (error) {
    toast(error.message || '导入失败');
  }
}

function confirmImport() {
  if (!pendingImported) return;
  const imported = pendingImported;
  pendingImported = null;
  const count = mergeImported(imported);
  closeSheet();
  toast(`已导入 ${count} 笔记录${isLoggedIn() ? '，正在同步' : ''}`);
  if (isLoggedIn()) runSync();
}

function exportBackup() {
  state.settings.lastBackupAt = new Date().toISOString();
  persist();
  downloadTextFile(`稿费记录-备份-${fileStamp()}.json`, createBackup(state), 'application/json;charset=utf-8');
  toast('备份已导出');
}

function exportCSV() {
  downloadTextFile(`稿费记录-${fileStamp()}.csv`, recordsToCSV(state), 'text/csv;charset=utf-8');
  toast('CSV 已导出');
}

/* ------------------------------------------------------------------ */
/* 说明弹层                                                            */
/* ------------------------------------------------------------------ */

function openInstallHelp() {
  openSheet({
    title: '安装到桌面',
    body: `
      <div class="detail-list" style="border-top:0">
        <div class="detail-row"><dt>Android</dt><dd>Chrome 打开本页 → 右上角 ⋮ → 「安装应用」或「添加到主屏幕」</dd></div>
        <div class="detail-row"><dt>iPhone</dt><dd>Safari 打开 → 分享 → 「添加到主屏幕」</dd></div>
        <div class="detail-row"><dt>电脑</dt><dd>Chrome / Edge 地址栏右侧的安装图标</dd></div>
      </div>
      <p class="auth-note">装好后可以离线打开，数据仍然保存在本机；开启云端同步后多设备共用一份数据。</p>`
  });
}

function openAbout() {
  openSheet({
    title: '关于',
    body: `
      <p class="onboard-title" style="font-size:20px">稿费记录</p>
      <p class="onboard-desc">为代写接单设计的稿费账本：本地优先、断网可用、可选免费云端同步。</p>
      <div class="detail-list" style="margin-top:18px">
        <div class="detail-row"><dt>版本</dt><dd>v1.0.0</dd></div>
        <div class="detail-row"><dt>数据位置</dt><dd>本机浏览器 + 你的 Supabase</dd></div>
        <div class="detail-row"><dt>设计口径</dt><dd>已完成 + 无备注 + 无到手 = 全额到手</dd></div>
      </div>
      <p class="auth-note">所有金额、作品、客服信息只属于你；云端用行级权限隔离，别人拿不到。</p>`
  });
}

/* ------------------------------------------------------------------ */
/* 引导                                                                */
/* ------------------------------------------------------------------ */

const ONBOARD_STEPS = [
  {
    kicker: '01 / 03',
    title: '把每一笔稿费，记清楚',
    desc: '接单佣金、到手金额、退款差额、客户和客服，一条记录全收好。已完成又没填到手的，按全额自动算。'
  },
  {
    kicker: '02 / 03',
    title: '本机优先，断网也能用',
    desc: '数据先存在这台设备上，网络不好也能记。想换手机、想多设备同步时，再打开免费的云端同步。'
  },
  {
    kicker: '03 / 03',
    title: '开始你的第一笔',
    desc: '可以先导入历史备份，也可以直接点 + 记一笔。之后随时能在「我的」里登录云端。'
  }
];

let onboardIndex = 0;

function openOnboarding() {
  onboardIndex = 0;
  const node = document.createElement('div');
  node.className = 'onboard';
  node.id = 'onboard';
  document.body.appendChild(node);
  paintOnboarding();
}

function paintOnboarding() {
  const node = $('#onboard');
  if (!node) return;
  const step = ONBOARD_STEPS[onboardIndex];
  node.innerHTML = `
    <div class="onboard-card">
      <p class="onboard-step">${step.kicker}</p>
      <h2 class="onboard-title">${step.title}</h2>
      <p class="onboard-desc">${step.desc}</p>
      <div class="onboard-actions">
        <button class="btn btn-secondary btn-sm" style="flex:1" type="button" data-action="onboard-skip">跳过</button>
        <button class="btn btn-primary btn-sm" style="flex:1.5" type="button" data-action="onboard-next">
          ${onboardIndex === ONBOARD_STEPS.length - 1 ? '开始使用' : '继续'}
        </button>
      </div>
      <div class="onboard-dots">
        ${ONBOARD_STEPS.map((_, index) => `<i class="${index === onboardIndex ? 'is-active' : ''}"></i>`).join('')}
      </div>
    </div>`;
}

function finishOnboarding() {
  state.settings.onboarded = true;
  persist();
  $('#onboard')?.remove();
  render();
}

/* ------------------------------------------------------------------ */
/* 交互事件                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('click', async event => {
  const tab = event.target.closest('.tab');
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }

  const recordEl = event.target.closest('.record');
  if (recordEl && !event.target.closest('.record-delete')) {
    if (recordEl.classList.contains('is-open')) {
      recordEl.classList.remove('is-open');
      return;
    }
    const wrap = recordEl.closest('.record-wrap');
    if (wrap) {
      const id = wrap.dataset.id;
      if (ui.selection) toggleSelection(id);
      else openDetail(id);
      return;
    }
  }

  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  switch (action) {
    case 'close-sheet':
      if (Date.now() - sheetOpenedAt < 260) break;
      closeSheet();
      break;
    case 'toast-action':
      if (toastAction) {
        const run = toastAction.run;
        hideToast();
        run();
      }
      break;
    case 'new':
      openRecordForm();
      break;
    case 'sync':
      if (!cloud.configured) openSetup();
      else if (!cloud.session) openAuth();
      else runSync({ manual: true });
      break;
    case 'period':
      ui.period = actionEl.dataset.value;
      render();
      break;
    case 'month': {
      const key = actionEl.dataset.key;
      const records = filterRecords(state.records, { month: key });
      openRecordsSheet(monthLabel(key), records);
      break;
    }
    case 'platform-detail': {
      const platformId = actionEl.dataset.value;
      const records = visibleRecords(state).filter(record => record.platformId === platformId);
      openRecordsSheet(platformOf(state, platformId).name, records);
      break;
    }
    case 'service-detail': {
      const name = actionEl.dataset.value;
      const records = visibleRecords(state).filter(record => (record.customerService || '未填客服') === name);
      openRecordsSheet(name, records);
      break;
    }
    case 'open-reconcile':
      openRecordsSheet('差额核对', diffRecords(visibleRecords(state)).map(item => item.record));
      break;
    case 'pending-detail':
      openRecordsSheet(`待补到手 · ${pendingRecords(visibleRecords(state)).length} 笔`, pendingRecords(visibleRecords(state)));
      break;
    case 'go-records':
      switchTab('records');
      break;
    case 'open-record':
      if (ui.selection) {
        toggleSelection(actionEl.dataset.id);
      } else {
        openDetail(actionEl.dataset.id);
      }
      break;
    case 'edit-record':
      closeSheet(true);
      openEditRecord(actionEl.dataset.id);
      break;
    case 'copy-record': {
      const source = state.records.find(item => item.id === actionEl.dataset.id);
      if (source) {
        closeSheet(true);
        openRecordForm({ ...source, id: '', createdAt: undefined, updatedAt: undefined, receivedInferred: false });
      }
      break;
    }
    case 'delete-record':
      closeSheet(true);
      deleteRecord(actionEl.dataset.id);
      break;
    case 'save-record':
      saveDraft({ continueNext: actionEl.dataset.continue === '1' });
      break;
    case 'fill-received':
      draft.receivedText = String(draftCommission());
      {
        const input = ui.sheet?.querySelector('[data-field="receivedText"]');
        if (input) input.value = draft.receivedText;
        refreshInferred();
      }
      break;
    case 'toggle-more': {
      const button = actionEl;
      const bodyEl = ui.sheet?.querySelector('#more-body');
      const open = button.classList.toggle('is-open');
      bodyEl?.classList.toggle('is-open', open);
      break;
    }
    case 'filter-year':
      openFilterYear();
      break;
    case 'filter-platform':
      openFilterPlatform();
      break;
    case 'filter-status':
      openFilterStatus();
      break;
    case 'clear-filters':
      ui.filters = { year: '', platformId: '', status: '' };
      ui.query = '';
      render();
      break;
    case 'enter-selection':
      ui.selection = new Set();
      render();
      break;
    case 'exit-selection':
      ui.selection = null;
      render();
      break;
    case 'bulk-complete':
      bulkComplete();
      break;
    case 'option-pick':
      if (pendingPick) {
        const pick = pendingPick;
        pendingPick = null;
        closeSheet();
        pick(actionEl.dataset.value);
      }
      break;
    case 'open-auth':
      openAuth();
      break;
    case 'auth-submit':
      submitAuth();
      break;
    case 'logout':
      await logout();
      break;
    case 'open-setup':
      openSetup();
      break;
    case 'test-setup':
      testSetup();
      break;
    case 'save-setup':
      saveSetup();
      break;
    case 'open-diagnostics':
      openDiagnostics();
      break;
    case 'run-diagnostics':
      runDiagnostics();
      break;
    case 'open-platforms':
      openPlatforms();
      break;
    case 'add-platform':
      openPlatformEditor();
      break;
    case 'edit-platform':
      openPlatformEditor(state.platforms.find(item => item.id === actionEl.dataset.id));
      break;
    case 'save-platform':
      savePlatform(actionEl.dataset.id || '');
      break;
    case 'delete-platform':
      deletePlatform(actionEl.dataset.id);
      break;
    case 'open-import':
      openImport();
      break;
    case 'confirm-import':
      confirmImport();
      break;
    case 'export-backup':
      exportBackup();
      break;
    case 'export-csv':
      exportCSV();
      break;
    case 'open-install':
      openInstallHelp();
      break;
    case 'open-about':
      openAbout();
      break;
    case 'cycle-theme':
      state.settings.theme = state.settings.theme === 'system' ? 'light' : state.settings.theme === 'light' ? 'dark' : 'system';
      persist();
      render();
      toast(`外观：${state.settings.theme === 'system' ? '跟随系统' : state.settings.theme === 'light' ? '浅色' : '深色'}`);
      break;
    case 'onboard-next':
      if (onboardIndex >= ONBOARD_STEPS.length - 1) finishOnboarding();
      else {
        onboardIndex += 1;
        paintOnboarding();
      }
      break;
    case 'onboard-skip':
      finishOnboarding();
      break;
    default:
      break;
  }
});

document.addEventListener('click', event => {
  const mode = event.target.closest('[data-auth-mode]');
  if (!mode) return;
  authMode = mode.dataset.authMode;
  const tabs = mode.closest('.auth-tabs');
  tabs?.querySelectorAll('[data-auth-mode]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.authMode === authMode);
  });
  const submit = ui.sheet?.querySelector('[data-action="auth-submit"]');
  if (submit) submit.textContent = authMode === 'signin' ? '登录' : '注册';
});

document.addEventListener('click', event => {
  const pick = event.target.closest('[data-pick]');
  if (pick && ui.sheet) {
    const field = pick.dataset.pick;
    draft[field] = pick.dataset.value;
    pick.closest('.chip-select')?.querySelectorAll('[data-pick]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.value === pick.dataset.value);
    });
    refreshInferred();
    return;
  }
  const quick = event.target.closest('[data-date-quick]');
  if (quick && ui.sheet) {
    const offset = Number(quick.dataset.dateQuick) || 0;
    const date = new Date();
    date.setDate(date.getDate() - offset);
    draft.orderedAt = todayISO(date);
    const input = ui.sheet.querySelector('[data-field="orderedAt"]');
    if (input) input.value = draft.orderedAt;
  }
});

const onFieldInput = event => {
  const field = event.target.closest('[data-field]');
  if (!field || !draft) return;
  draft[field.dataset.field] = field.value;
  if (['commissionText', 'receivedText', 'note', 'status'].includes(field.dataset.field)) {
    refreshInferred();
  }
};
document.addEventListener('input', onFieldInput);
document.addEventListener('change', onFieldInput);

document.addEventListener('input', event => {
  if (event.target.id !== 'search-input') return;
  ui.query = event.target.value;
  renderRecordGroups();
  const summary = $('#records-summary');
  if (summary) {
    const list = filteredRecords();
    const sum = list.reduce((acc, record) => acc + (Number(record.received) || 0), 0);
    summary.textContent = `${list.length} 笔 · 到手 ${money(sum)}`;
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) importFile(file);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSheet();
});

window.addEventListener('online', () => {
  paintSyncPill();
  if (isLoggedIn()) runSync();
});
window.addEventListener('offline', () => paintSyncPill());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isLoggedIn()) {
    const last = new Date(state.sync.lastSyncedAt || 0).getTime();
    if (Date.now() - last > 60_000) runSync();
  }
});

async function logout() {
  if (!cloud.session) return;
  await cloud.signOut();
  state.sync.userId = '';
  persist();
  render();
  toast('已退出登录，本机数据保留');
}

function toggleSelection(id) {
  if (!ui.selection) ui.selection = new Set();
  if (ui.selection.has(id)) ui.selection.delete(id);
  else ui.selection.add(id);
  render();
}

function bulkComplete() {
  if (!ui.selection || !ui.selection.size) return;
  const now = new Date().toISOString();
  let touched = 0;
  state.records = state.records.map(record => {
    if (!ui.selection.has(record.id) || record.deletedAt) return record;
    touched += 1;
    const next = { ...record, status: '已完成', updatedAt: now };
    const guess = inferReceived({ status: next.status, note: next.note, received: next.received, commission: next.commission });
    next.received = guess.received;
    next.receivedInferred = guess.inferred;
    markDirty(next.id);
    return next;
  });
  persist();
  ui.selection = null;
  render();
  scheduleSync();
  toast(`已标记 ${touched} 笔为已完成${touched ? '，没填到手的按全额补上' : ''}`);
}

/* ---------------- 滑动删除 / 长按多选 ---------------- */

let gesture = null;
let pressTimer = null;
let suppressClickUntil = 0;

function suppressClicks(ms = 150) {
  suppressClickUntil = Date.now() + ms;
}

document.addEventListener('pointerdown', event => {
  const record = event.target.closest('.record');
  if (!record) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const wrap = record.closest('.record-wrap');
  if (!wrap) return;
  gesture = {
    wrap,
    record,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    active: false,
    moved: false
  };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!gesture || gesture.moved) return;
    const id = wrap.dataset.id;
    if (!ui.selection) {
      ui.selection = new Set([id]);
      suppressClicks(600);
      if (navigator.vibrate) navigator.vibrate(8);
      render();
    }
    gesture = null;
  }, 520);
}, { passive: true });

document.addEventListener('pointermove', event => {
  if (!gesture) return;
  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
    gesture.moved = true;
    clearTimeout(pressTimer);
  }
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
    gesture.active = true;
    gesture.dx = Math.min(0, Math.max(-96, dx));
    gesture.record.style.transition = 'none';
    gesture.record.style.transform = `translateX(${gesture.dx}px)`;
  }
}, { passive: true });

document.addEventListener('pointerup', () => {
  clearTimeout(pressTimer);
  if (!gesture) return;
  const { record, dx, active } = gesture;
  record.style.transition = '';
  record.style.transform = '';
  if (active) {
    record.classList.toggle('is-open', dx < -52);
    suppressClicks(180);
  }
  gesture = null;
});

document.addEventListener('pointercancel', () => {
  clearTimeout(pressTimer);
  if (gesture) {
    gesture.record.style.transition = '';
    gesture.record.style.transform = '';
  }
  gesture = null;
});

document.addEventListener('click', event => {
  if (Date.now() < suppressClickUntil) {
    event.stopPropagation();
    event.preventDefault();
  }
}, true);

/* ---------------- 下拉同步 ---------------- */

let pull = null;
let pullHint = null;

function ensurePullHint() {
  if (!pullHint) {
    pullHint = document.createElement('div');
    pullHint.className = 'pull-hint';
    document.body.appendChild(pullHint);
  }
  return pullHint;
}

window.addEventListener('touchstart', event => {
  if (ui.sheet || window.scrollY > 0 || event.touches.length !== 1) return;
  pull = { startY: event.touches[0].clientY, dy: 0 };
}, { passive: true });

window.addEventListener('touchmove', event => {
  if (!pull) return;
  pull.dy = event.touches[0].clientY - pull.startY;
  if (pull.dy > 0) {
    const hint = ensurePullHint();
    const progress = Math.min(1, pull.dy / 90);
    hint.textContent = pull.dy > 64 ? '松开同步' : '下拉同步';
    hint.style.opacity = String(progress);
    hint.style.transform = `translate(-50%, ${Math.min(28, pull.dy / 3)}px)`;
  }
}, { passive: true });

window.addEventListener('touchend', () => {
  if (!pull) return;
  const shouldSync = pull.dy > 64;
  const hint = pullHint;
  if (hint) {
    hint.style.opacity = '0';
    hint.style.transform = 'translate(-50%, 0)';
  }
  pull = null;
  if (shouldSync) {
    if (isLoggedIn()) runSync({ manual: true });
    else toast('还没登录云端；数据已保存在本机');
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function applyThemeMeta() {
  const dark = state.settings.theme === 'dark' ||
    (state.settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#090a0d' : '#f3f3f5');
}

async function maybeLoadDevSeed() {
  const params = new URLSearchParams(location.search);
  if (!params.has('dev')) return;
  state.settings.onboarded = true;
  if (visibleRecords(state).length) return;
  try {
    const response = await fetch('./private/seed.json', { cache: 'no-store' });
    if (!response.ok) return;
    const text = await response.text();
    const imported = parseBackup(text);
    mergeImported(imported);
    console.info(`开发种子已载入：${imported.records.length} 笔`);
  } catch {
    /* 部署环境没有 private 目录，正常 */
  }
}

function openSheetFromQuery() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const tab = params.get('tab');
  if (tab && PAGE_TITLES[tab]) switchTab(tab);
  if (view === 'new') openRecordForm();
  else if (view === 'detail') {
    const first = filterRecords(state.records, {})[0];
    if (first) openDetail(first.id);
  } else if (view === 'auth') openAuth();
  else if (view === 'settings') switchTab('settings');
  const theme = params.get('theme');
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      if (registration.waiting) {
        toast('有新版本可用', { action: { label: '刷新', run: () => location.reload() }, timeout: 8000 });
      }
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('有新版本可用', { action: { label: '刷新', run: () => location.reload() }, timeout: 8000 });
          }
        });
      });
    } catch {
      /* 离线或不支持时忽略 */
    }
  });
}

async function boot() {
  applyTheme();
  applyThemeMeta();
  render();
  await maybeLoadDevSeed();
  render();
  if (!state.settings.onboarded) openOnboarding();
  openSheetFromQuery();
  if (!new URLSearchParams(location.search).has('dev')) registerServiceWorker();
  setTimeout(() => $('#boot')?.classList.add('is-hidden'), 420);
  if (isLoggedIn()) runSync();
  setInterval(() => {
    if (document.visibilityState === 'visible' && isLoggedIn()) {
      const last = new Date(state.sync.lastSyncedAt || 0).getTime();
      if (Date.now() - last > 90_000) runSync();
    }
  }, 60_000);
}

boot();

// 让测试/调试可以拿到内部状态
window.__gaofei = {
  get state() { return state; },
  ui,
  render,
  openRecordForm,
  openDetail,
  openSheetQuery: openSheetFromQuery
};
