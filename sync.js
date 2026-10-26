// 稿费记录 · Supabase 同步客户端（零依赖，直接调 GoTrue + PostgREST）
import { normalizeRecord, SESSION_KEY } from './lib.js';

export class CloudError extends Error {
  constructor(message, { status = 0, code = '', paused = false } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.paused = paused;
  }
}

export function memoryStore() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

function browserStore() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* 隐私模式等 */ }
  return memoryStore();
}

export function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function timeValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function toRemoteRecord(record) {
  return {
    id: record.id,
    platform_id: record.platformId,
    ordered_at: record.orderedAt,
    order_no: record.orderNo || '',
    external_id: record.externalId || '',
    customer_service: record.customerService || '',
    title: record.title || '',
    commission: Number(record.commission) || 0,
    received: record.received === undefined ? null : record.received,
    received_inferred: Boolean(record.receivedInferred),
    note: record.note || '',
    status: record.status || '未标记',
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    deleted_at: record.deletedAt || null
  };
}

export function mapRemoteRecord(row) {
  return normalizeRecord({
    id: row.id,
    platformId: row.platform_id,
    orderedAt: row.ordered_at,
    orderNo: row.order_no,
    externalId: row.external_id,
    customerService: row.customer_service,
    title: row.title,
    commission: row.commission,
    received: row.received,
    receivedInferred: row.received_inferred,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  });
}

export function toRemotePlatform(platform) {
  return {
    id: platform.id,
    name: platform.name,
    color: platform.color,
    sort: Number(platform.sort) || 0,
    updated_at: platform.updatedAt || new Date().toISOString(),
    deleted_at: platform.deletedAt || null
  };
}

export function mapRemotePlatform(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sort: Number(row.sort) || 0,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
}

/** 拉回来的远端记录与本地合并：更新时间更晚的一方获胜（LWW） */
export function mergeRecords(localRecords, remoteRows, dirtyIds = []) {
  const dirty = new Set(dirtyIds);
  const byId = new Map(localRecords.map(record => [record.id, record]));
  let remoteWins = 0;
  let added = 0;
  let conflicted = 0;

  remoteRows.forEach(row => {
    const incoming = mapRemoteRecord(row);
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      added += 1;
      return;
    }
    if (timeValue(incoming.updatedAt) > timeValue(current.updatedAt)) {
      if (dirty.has(current.id)) {
        dirty.delete(current.id);
        conflicted += 1;
      }
      byId.set(incoming.id, { ...incoming, source: current.source || null });
      remoteWins += 1;
    }
  });

  return { records: [...byId.values()], dirty: [...dirty], remoteWins, added, conflicted };
}

export function mergePlatforms(localPlatforms, remoteRows) {
  const byId = new Map(localPlatforms.map(platform => [platform.id, platform]));
  let changed = 0;
  remoteRows.forEach(row => {
    const incoming = mapRemotePlatform(row);
    const current = byId.get(incoming.id);
    if (!current || timeValue(incoming.updatedAt) > timeValue(current.updatedAt)) {
      byId.set(incoming.id, incoming);
      changed += 1;
    }
  });
  return [...byId.values()].sort((a, b) => a.sort - b.sort);
}

export function describeError(error) {
  if (!error) return '未知错误';
  const message = String(error.message || '');
  if (error.paused) {
    return '云端项目已暂停（免费版 7 天无请求会自动暂停）。打开 supabase.com/dashboard 点「Resume project」恢复，再回来同步。';
  }
  if (error.code === 'NO_SESSION') return '还没有登录云端账号。';
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不对。';
  if (/user already registered/i.test(message)) return '这个邮箱已经注册过了，直接登录就行。';
  if (/email not confirmed/i.test(message)) return '邮箱还没确认：去 Supabase → Authentication → Providers → Email 关闭 Confirm email，或点确认邮件里的链接。';
  if (/password should be at least/i.test(message)) return '密码太短，至少 6 位。';
  if (/invalid api key|no api key|jwt/i.test(message) && error.status === 401) return 'anon key 不对，检查「云端配置」。';
  if (/relation .* does not exist/i.test(message)) return '云端表不存在，请先在 Supabase SQL Editor 执行 supabase/schema.sql。';
  if (error.status === 401) return '登录已过期，请重新登录。';
  if (error.status === 403) return '没有权限（可能是数据库权限脚本没执行完整）。';
  if (error.status === 404) return '云端表不存在，请先在 Supabase SQL Editor 执行 supabase/schema.sql。';
  if (error.status === 409) return '数据冲突，请再同步一次。';
  if (error.status === 429) return '请求太频繁，稍等几分钟再试。';
  if (error.status >= 500) return `云端服务异常（HTTP ${error.status}），稍后再试。`;
  if (error instanceof TypeError) return '网络不可用，已保存到本机，联网后会自动同步。';
  return message || '同步失败';
}

export class CloudClient {
  constructor({ url = '', anonKey = '', store = null, storageKey = SESSION_KEY, fetchImpl = null, now = () => Date.now() } = {}) {
    this.url = normalizeUrl(url);
    this.anonKey = String(anonKey || '').trim();
    this.store = store || browserStore();
    this.storageKey = storageKey;
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.now = now;
    this.session = this.loadSession();
  }

  get configured() {
    return Boolean(this.url && this.anonKey);
  }

  loadSession() {
    try {
      const raw = this.store.getItem(this.storageKey);
      if (!raw) return null;
      const session = JSON.parse(raw);
      return session && session.accessToken ? session : null;
    } catch {
      return null;
    }
  }

  saveSession(session) {
    this.session = session;
    try {
      this.store.setItem(this.storageKey, JSON.stringify(session));
    } catch { /* 存不下也不影响本次使用 */ }
  }

  clearSession() {
    this.session = null;
    try {
      this.store.removeItem(this.storageKey);
    } catch { /* ignore */ }
  }

  applyAuth(data) {
    const session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: this.now() + (Number(data.expires_in) || 3600) * 1000,
      userId: data.user?.id || '',
      email: data.user?.email || ''
    };
    this.saveSession(session);
    return session;
  }

  async request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const requestHeaders = {
      apikey: this.anonKey,
      'Content-Type': 'application/json',
      ...headers
    };
    if (auth && this.session?.accessToken) {
      requestHeaders.Authorization = `Bearer ${this.session.accessToken}`;
    }
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 200) };
      }
    }
    if (!response.ok) {
      const message = data?.msg || data?.message || data?.error_description || data?.error || `HTTP ${response.status}`;
      const paused = response.status === 540 || /paused/i.test(String(message));
      throw new CloudError(String(message), { status: response.status, code: data?.code || '', paused });
    }
    return data;
  }

  async signIn(email, password) {
    const data = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      auth: false,
      body: { email, password }
    });
    return this.applyAuth(data);
  }

  async signUp(email, password) {
    const data = await this.request('/auth/v1/signup', {
      method: 'POST',
      auth: false,
      body: { email, password }
    });
    if (!data?.access_token) {
      throw new CloudError('注册成功，但项目开启了邮箱确认。请到 Supabase → Authentication → Providers → Email 关闭「Confirm email」后再登录。');
    }
    return this.applyAuth(data);
  }

  async refresh() {
    if (!this.session?.refreshToken) {
      throw new CloudError('登录状态已失效，请重新登录。', { status: 401, code: 'NO_SESSION' });
    }
    const data = await this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      auth: false,
      body: { refresh_token: this.session.refreshToken }
    });
    return this.applyAuth(data);
  }

  async ensureSession() {
    if (!this.session) {
      throw new CloudError('还没有登录云端账号。', { code: 'NO_SESSION' });
    }
    if (this.session.expiresAt - 60_000 > this.now()) return this.session;
    try {
      return await this.refresh();
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  async signOut() {
    try {
      await this.request('/auth/v1/logout', { method: 'POST' });
    } catch { /* 本地退出优先 */ }
    this.clearSession();
  }

  async rest(path, options = {}) {
    await this.ensureSession();
    try {
      return await this.request(path, options);
    } catch (error) {
      if (error instanceof CloudError && error.status === 401) {
        await this.refresh();
        return this.request(path, options);
      }
      throw error;
    }
  }

  /** 增量拉取：按服务器时间游标翻页 */
  async pullRows(table, { cursor = '', limit = 500 } = {}) {
    const rows = [];
    let pageCursor = cursor;
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams();
      params.set('select', '*');
      params.set('order', 'server_updated_at.asc,id.asc');
      params.set('limit', String(limit));
      if (pageCursor) params.set('server_updated_at', `gt.${pageCursor}`);
      const batch = await this.rest(`/rest/v1/${table}?${params.toString()}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      rows.push(...batch);
      if (batch.length < limit) break;
      pageCursor = batch[batch.length - 1].server_updated_at;
    }
    return rows;
  }

  async upsertRows(table, rows, { onConflict = 'id' } = {}) {
    if (!rows.length) return 0;
    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      await this.rest(`/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        body: chunk,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
      });
    }
    return rows.length;
  }

  /** 取某张表最新的服务器时间，用于把游标推到当下，避免每次同步都全量拉 */
  async latestServerTime(table) {
    const params = new URLSearchParams();
    params.set('select', 'server_updated_at');
    params.set('order', 'server_updated_at.desc');
    params.set('limit', '1');
    const rows = await this.rest(`/rest/v1/${table}?${params.toString()}`);
    return Array.isArray(rows) && rows[0] ? rows[0].server_updated_at : '';
  }
}

/** 一次完整同步：先拉后推，返回合并后的本地状态 */
export async function syncOnce({ client, state, onStage = () => {} }) {
  await client.ensureSession();
  const cursor = state.sync.lastPulledServerAt || '';

  onStage('pull');
  const [recordRows, platformRows] = await Promise.all([
    client.pullRows('records', { cursor }),
    client.pullRows('platforms', { cursor })
  ]);
  const cursors = [
    recordRows.at(-1)?.server_updated_at,
    platformRows.at(-1)?.server_updated_at
  ].filter(Boolean).sort();
  const nextCursor = cursors.length ? cursors[cursors.length - 1] : cursor;

  const merged = mergeRecords(state.records, recordRows, state.sync.dirty);
  const platforms = mergePlatforms(state.platforms, platformRows);

  onStage('push');
  const dirtyRecords = merged.records.filter(record => merged.dirty.includes(record.id));
  const pushedRecords = await client.upsertRows('records', dirtyRecords.map(toRemoteRecord));
  const shouldPushPlatforms = Boolean(state.sync.platformDirty) || platformRows.length === 0;
  const pushedPlatforms = shouldPushPlatforms
    ? await client.upsertRows('platforms', platforms.map(toRemotePlatform))
    : 0;

  // 推送成功后把游标推到服务器当下，避免下一次同步再次全量拉取
  let cursorAfter = nextCursor;
  if (pushedRecords || pushedPlatforms) {
    const [recordTime, platformTime] = await Promise.all([
      client.latestServerTime('records'),
      client.latestServerTime('platforms')
    ]);
    cursorAfter = [nextCursor, recordTime, platformTime].filter(Boolean).sort().pop() || nextCursor;
  }

  return {
    records: merged.records,
    platforms,
    dirty: [],
    platformDirty: false,
    cursor: cursorAfter,
    pushed: pushedRecords,
    pushedPlatforms,
    added: merged.added,
    remoteWins: merged.remoteWins,
    conflicted: merged.conflicted,
    syncedAt: new Date().toISOString()
  };
}
