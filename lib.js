// 稿费记录 · 纯逻辑层（无 DOM 依赖，可在 Node 中测试）
export const APP_NAME = '稿费记录';
export const BACKUP_APP_ID = '稿费记录';
export const STATE_KEY = 'gaofei.state.v1';
export const CLOUD_KEY = 'gaofei.cloud.v1';
export const SESSION_KEY = 'gaofei.session.v1';
export const SCHEMA_VERSION = 1;

export const STATUSES = ['已完成', '进行中', '待修改', '待确认', '已取消', '未标记'];

export const STATUS_META = {
  '已完成': { tone: 'ok', dot: '#3c8c6a', label: '已完成' },
  '进行中': { tone: 'info', dot: '#4a7fb5', label: '进行中' },
  '待修改': { tone: 'warn', dot: '#b7791f', label: '待修改' },
  '待确认': { tone: 'muted', dot: '#8e8e93', label: '待确认' },
  '已取消': { tone: 'muted', dot: '#b9b9c0', label: '已取消' },
  '未标记': { tone: 'muted', dot: '#9a9aa3', label: '未标记' }
};

export const DEFAULT_PLATFORMS = [
  { id: 'plat-fanmiao', name: '帆淼写作设计', color: '#b08a57', sort: 1 },
  { id: 'plat-xianzu', name: '仙租顺利通过代写服务', color: '#7a8b99', sort: 2 },
  { id: 'plat-lanling', name: '澜翎幻境商务设计', color: '#8c7e9b', sort: 3 },
  { id: 'plat-wechat', name: '微信', color: '#7e9b8a', sort: 4 }
];

/** 内置平台的初始时间，故意设得很早：别的设备改过名字时以云端为准 */
export const BASE_TIME = '2025-01-01T00:00:00.000Z';

/* ---------------- 基础工具 ---------------- */

export function uid(prefix = 'rec') {
  const raw = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${raw}`;
}

export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateFromISO(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

export function monthKey(value) {
  return String(value || '').slice(0, 7);
}

export function monthLabel(key) {
  const [year, month] = String(key || '').split('-');
  if (!year || !month) return '';
  return `${year}年${Number(month)}月`;
}

export function parseAmount(value) {
  const text = String(value ?? '').replace(/[¥￥,\s]/g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

export function formatMoney(value, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const decimals = options.decimals ?? (Number.isInteger(number) ? 0 : 2);
  return number.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 2)
  });
}

export function formatDate(value, style = 'full') {
  const date = dateFromISO(value);
  if (!date) return '未填日期';
  if (style === 'short') return `${date.getMonth() + 1}/${date.getDate()}`;
  if (style === 'month') return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeDay(value) {
  const days = Math.round((dateFromISO(todayISO()) - dateFromISO(value)) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return `${days} 天前`;
  return formatDate(value, 'short');
}

/* ---------------- 归一化 ---------------- */

export function normalizeStatus(value) {
  const status = String(value || '').trim();
  if (!status) return '未标记';
  const map = {
    完结: '已完成', 完成: '已完成', 已完结: '已完成', 已完成: '已完成', 已交付: '已完成',
    已创建: '进行中', 进行中: '进行中', 写作中: '进行中', 制作中: '进行中',
    待修改: '待修改', 修改: '待修改', 返修: '待修改',
    待确认: '待确认',
    取消: '已取消', 已取消: '已取消', 作废: '已取消',
    未标记: '未标记'
  };
  return map[status] || '待确认';
}

export function normalizePlatform(item = {}, index = 0) {
  const fallback = DEFAULT_PLATFORMS[index % DEFAULT_PLATFORMS.length];
  const name = String(item.name || item.platform || fallback.name).trim();
  if (!name) throw new Error('平台名称不能为空');
  return {
    id: String(item.id || uid('plat')),
    name,
    color: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : fallback.color,
    sort: Number.isFinite(Number(item.sort)) ? Number(item.sort) : index + 1,
    updatedAt: item.updatedAt || BASE_TIME,
    deletedAt: item.deletedAt || null
  };
}

export function normalizeRecord(item = {}) {
  const orderedAt = normalizeDate(item.orderedAt ?? item.ordered_at) || todayISO();
  const commission = Math.max(0, parseAmount(item.commission));
  const rawReceived = item.received ?? item.received_amount;
  const hasReceived = rawReceived !== null && rawReceived !== undefined && rawReceived !== '';
  const received = hasReceived ? Math.max(0, parseAmount(rawReceived)) : null;
  const now = new Date().toISOString();
  return {
    id: String(item.id || uid()),
    platformId: String(item.platformId || item.platform_id || ''),
    orderedAt,
    orderNo: String(item.orderNo ?? item.order_no ?? '').trim(),
    externalId: String(item.externalId ?? item.external_id ?? '').trim(),
    customerService: String(item.customerService ?? item.customer_service ?? '').trim(),
    title: String(item.title ?? '').trim(),
    commission,
    received,
    receivedInferred: Boolean(item.receivedInferred ?? item.received_inferred),
    note: String(item.note ?? '').trim(),
    status: normalizeStatus(item.status),
    createdAt: item.createdAt || item.created_at || `${orderedAt}T00:00:00.000Z`,
    updatedAt: item.updatedAt || item.updated_at || now,
    deletedAt: item.deletedAt ?? item.deleted_at ?? null,
    source: item.source && typeof item.source === 'object' ? {
      year: String(item.source.year || ''),
      file: String(item.source.file || ''),
      sheet: String(item.source.sheet || ''),
      row: Number(item.source.row) || 0
    } : null
  };
}

export function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return todayISO(value);
  const text = String(value || '').trim();
  if (!text) return '';
  const matched = text.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (matched) {
    const [, y, m, d] = matched;
    const candidate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return dateFromISO(candidate) ? candidate : '';
  }
  const direct = text.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return direct && dateFromISO(text) ? direct[0] : '';
}

/* ---------------- 状态 ---------------- */

export function createState() {
  return {
    version: SCHEMA_VERSION,
    platforms: DEFAULT_PLATFORMS.map((item, index) => normalizePlatform(item, index)),
    records: [],
    settings: { theme: 'system', lastBackupAt: '', onboarded: false },
    sync: {
      lastPulledServerAt: '', lastSyncedAt: '', dirty: [],
      platformDirty: false, userId: '', email: ''
    }
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.records)) {
    throw new Error('备份文件缺少有效的记录数据');
  }
  const platforms = [];
  const seen = new Set();
  (Array.isArray(value.platforms) ? value.platforms : []).forEach((item, index) => {
    try {
      const platform = normalizePlatform(item, index);
      if (!seen.has(platform.id)) {
        seen.add(platform.id);
        platforms.push(platform);
      }
    } catch { /* 跳过非法平台 */ }
  });
  DEFAULT_PLATFORMS.forEach((item, index) => {
    if (!seen.has(item.id)) {
      platforms.push(normalizePlatform(item, index));
      seen.add(item.id);
    }
  });
  const platformIds = new Set(platforms.map(item => item.id));
  const records = [];
  const recordIds = new Set();
  value.records.forEach(item => {
    try {
      const record = normalizeRecord(item);
      if (!record.platformId || !platformIds.has(record.platformId)) {
        record.platformId = platforms[0].id;
      }
      if (!recordIds.has(record.id)) {
        recordIds.add(record.id);
        records.push(record);
      }
    } catch { /* 跳过非法记录 */ }
  });
  const dirty = Array.isArray(value.sync?.dirty) ? value.sync.dirty.filter(id => recordIds.has(id)) : [];
  return {
    version: SCHEMA_VERSION,
    platforms: platforms.sort((a, b) => a.sort - b.sort),
    records,
    settings: {
      theme: ['light', 'dark', 'system'].includes(value.settings?.theme) ? value.settings.theme : 'system',
      lastBackupAt: value.settings?.lastBackupAt || '',
      onboarded: Boolean(value.settings?.onboarded)
    },
    sync: {
      lastPulledServerAt: value.sync?.lastPulledServerAt || '',
      lastSyncedAt: value.sync?.lastSyncedAt || '',
      dirty: [...new Set(dirty)],
      platformDirty: Boolean(value.sync?.platformDirty),
      userId: value.sync?.userId || '',
      email: value.sync?.email || ''
    }
  };
}

export function visibleRecords(state) {
  return state.records.filter(record => !record.deletedAt);
}

export function platformName(state, platformId) {
  return state.platforms.find(item => item.id === platformId)?.name || '未分类';
}

export function platformOf(state, platformId) {
  return state.platforms.find(item => item.id === platformId) ||
    { id: platformId, name: '未分类', color: '#9a9aa3' };
}

/* ---------------- 金额推定 ---------------- */

/** 已完成、没备注、没填到手 ⇒ 视为全额到手 */
export function inferReceived(record) {
  if (record.received !== null && record.received !== undefined) {
    return { received: record.received, inferred: Boolean(record.receivedInferred) };
  }
  if (record.status === '已完成' && !String(record.note || '').trim()) {
    return { received: Number(record.commission) || 0, inferred: true };
  }
  return { received: null, inferred: false };
}

/* ---------------- 统计 ---------------- */

export function computeStats(records) {
  const list = records.filter(record => !record.deletedAt);
  const withReceived = list.filter(record => record.received !== null && record.received !== undefined);
  const sum = key => list.reduce((total, record) => total + (Number(record[key]) || 0), 0);
  const received = withReceived.reduce((total, record) => total + Number(record.received || 0), 0);
  const commission = sum('commission');
  const diff = withReceived.reduce(
    (total, record) => total + (Number(record.commission) || 0) - (Number(record.received) || 0),
    0
  );
  return {
    count: list.length,
    commission,
    received,
    diff,
    pendingCount: list.length - withReceived.length,
    pendingCommission: list.filter(record => record.received === null || record.received === undefined)
      .reduce((total, record) => total + Number(record.commission || 0), 0),
    inferredCount: withReceived.filter(record => record.receivedInferred).length,
    doneCount: list.filter(record => record.status === '已完成').length,
    activeCount: list.filter(record => ['进行中', '待修改', '待确认'].includes(record.status)).length,
    avgReceived: withReceived.length ? received / withReceived.length : 0
  };
}

export function monthlyTrend(records, now = new Date(), months = 12) {
  const result = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const items = records.filter(record =>
      !record.deletedAt && monthKey(record.orderedAt) === key
    );
    result.push({
      key,
      label: `${date.getMonth() + 1}月`,
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      commission: items.reduce((total, record) => total + (Number(record.commission) || 0), 0),
      received: items.reduce((total, record) => total + (Number(record.received) || 0), 0),
      count: items.length
    });
  }
  return result;
}

export function platformBreakdown(records, platforms) {
  return platforms.map(platform => {
    const items = records.filter(record => !record.deletedAt && record.platformId === platform.id);
    return {
      ...platform,
      count: items.length,
      commission: items.reduce((total, record) => total + (Number(record.commission) || 0), 0),
      received: items.reduce((total, record) => total + (Number(record.received) || 0), 0)
    };
  }).sort((a, b) => b.received - a.received || b.count - a.count);
}

export function customerServiceBreakdown(records) {
  const map = new Map();
  records.filter(record => !record.deletedAt).forEach(record => {
    const name = record.customerService || '未填客服';
    const current = map.get(name) || { name, count: 0, received: 0 };
    current.count += 1;
    current.received += Number(record.received) || 0;
    map.set(name, current);
  });
  return [...map.values()].sort((a, b) => b.received - a.received || b.count - a.count);
}

export function statusBreakdown(records) {
  return STATUSES.map(status => ({
    status,
    ...STATUS_META[status],
    count: records.filter(record => !record.deletedAt && record.status === status).length
  }));
}

export function diffRecords(records) {
  return records
    .filter(record => !record.deletedAt && record.received !== null && record.received !== undefined)
    .map(record => ({ record, diff: (Number(record.commission) || 0) - (Number(record.received) || 0) }))
    .filter(item => Math.abs(item.diff) > 0.004)
    .sort((a, b) => b.diff - a.diff);
}

export function pendingRecords(records) {
  return records
    .filter(record => !record.deletedAt && (record.received === null || record.received === undefined))
    .sort((a, b) => String(b.orderedAt).localeCompare(String(a.orderedAt)));
}

/* ---------------- 筛选与分组 ---------------- */

export function filterRecords(records, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return records
    .filter(record => {
      if (record.deletedAt) return false;
      if (filters.platformId && record.platformId !== filters.platformId) return false;
      if (filters.status && filters.status !== '全部' && record.status !== filters.status) return false;
      if (filters.year && monthKey(record.orderedAt).slice(0, 4) !== String(filters.year)) return false;
      if (filters.month && monthKey(record.orderedAt) !== String(filters.month)) return false;
      if (filters.startDate && record.orderedAt < filters.startDate) return false;
      if (filters.endDate && record.orderedAt > filters.endDate) return false;
      if (query) {
        const haystack = [
          record.title, record.orderNo, record.externalId,
          record.customerService, record.note, record.status
        ].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const byDate = String(b.orderedAt).localeCompare(String(a.orderedAt));
      if (byDate !== 0) return byDate;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

export function groupByMonth(records) {
  const map = new Map();
  records.forEach(record => {
    const key = monthKey(record.orderedAt) || '未填日期';
    const group = map.get(key) || { key, label: monthLabel(key) || '未填日期', records: [], received: 0, commission: 0 };
    group.records.push(record);
    group.received += Number(record.received) || 0;
    group.commission += Number(record.commission) || 0;
    map.set(key, group);
  });
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

export function periodRange(period, now = new Date()) {
  const end = todayISO(now);
  if (period === 'month') {
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    return { startDate: start, endDate: end };
  }
  if (period === 'year') return { startDate: `${now.getFullYear()}-01-01`, endDate: end };
  if (period === '90') return { startDate: todayISO(addDays(now, -89)), endDate: end };
  return { startDate: '', endDate: '' };
}

export function recordsInPeriod(records, period, now = new Date()) {
  return filterRecords(records, periodRange(period, now));
}

export function previousPeriodStats(records, period, now = new Date()) {
  if (period === 'month') {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return computeStats(recordsInPeriod(records, 'month', prev));
  }
  if (period === 'year') {
    const year = now.getFullYear() - 1;
    return computeStats(filterRecords(records, {
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`
    }));
  }
  return null;
}

/* ---------------- 备份与导出 ---------------- */

export function createBackup(state) {
  return JSON.stringify({
    app: BACKUP_APP_ID,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    platforms: state.platforms,
    records: state.records,
    settings: state.settings
  }, null, 2);
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('无法读取备份，请选择本 App 导出的 JSON 文件');
  }
  if (data && data.app && data.app !== BACKUP_APP_ID) {
    throw new Error('这不是「稿费记录」的备份文件');
  }
  return normalizeState(data);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function recordsToCSV(state, records = visibleRecords(state)) {
  const names = new Map(state.platforms.map(item => [item.id, item.name]));
  const headers = [
    '订单时间', '平台', '订单号', '订单id', '客服', '作品',
    '接单佣金', '到手金额', '到手来源', '状态', '备注'
  ];
  const rows = records.map(record => [
    record.orderedAt,
    names.get(record.platformId) || '',
    record.orderNo,
    record.externalId,
    record.customerService,
    record.title,
    record.commission,
    record.received ?? '',
    record.received === null ? '' : (record.receivedInferred ? '自动全额' : '已记录'),
    record.status,
    record.note
  ]);
  return `\ufeff${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function fileStamp(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
