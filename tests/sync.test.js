import test from 'node:test';
import assert from 'node:assert/strict';

import { createState } from '../lib.js';
import {
  CloudClient,
  CloudError,
  describeError,
  mapRemoteRecord,
  memoryStore,
  mergePlatforms,
  mergeRecords,
  syncOnce,
  toRemoteRecord
} from '../sync.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  };
}

function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await handler(String(url), init);
    return response(result?.body, result?.status ?? 200);
  };
  impl.calls = calls;
  return impl;
}

function clientWith(fetchImpl, extras = {}) {
  const client = new CloudClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    store: memoryStore(),
    fetchImpl,
    ...extras
  });
  return client;
}

function authPayload() {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    user: { id: 'user-1', email: 'me@example.com' }
  };
}

test('signIn 保存会话并带上 anon key', async () => {
  const fetchImpl = makeFetch(() => ({ body: authPayload() }));
  const client = clientWith(fetchImpl);
  const session = await client.signIn('me@example.com', 'secret');

  assert.equal(session.userId, 'user-1');
  assert.equal(session.accessToken, 'access-1');
  assert.ok(client.loadSession());

  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(call.init.headers.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(call.init.body), { email: 'me@example.com', password: 'secret' });
});

test('signUp 在开启邮箱确认时给出可操作提示', async () => {
  const fetchImpl = makeFetch(() => ({ body: { user: { id: 'u' } } }));
  const client = clientWith(fetchImpl);
  await assert.rejects(() => client.signUp('a@b.c', 'secret'), /Confirm email/);
});

test('pullRows 按服务器时间游标翻页', async () => {
  const pages = [
    {
      body: [
        { id: '1', server_updated_at: '2025-01-01T00:00:00Z' },
        { id: '2', server_updated_at: '2025-01-02T00:00:00Z' }
      ]
    },
    { body: [{ id: '3', server_updated_at: '2025-01-03T00:00:00Z' }] }
  ];
  let index = 0;
  const fetchImpl = makeFetch(() => pages[index++]);
  const client = clientWith(fetchImpl);
  client.applyAuth(authPayload());

  const rows = await client.pullRows('records', { cursor: '', limit: 2 });
  assert.equal(rows.length, 3);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /limit=2/);
  assert.doesNotMatch(fetchImpl.calls[0].url, /server_updated_at=/);
  assert.match(fetchImpl.calls[1].url, /server_updated_at=gte\.2025-01-02T00%3A00%3A00Z/);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer access-1');
});

test('pullRows 同一时间戳跨页时不丢单且自动去重', async () => {
  const pages = [
    {
      body: [
        { id: '1', server_updated_at: '2025-01-01T00:00:00Z' },
        { id: '2', server_updated_at: '2025-01-01T00:00:00Z' }
      ]
    },
    {
      // 第2页由于 gte 包含了 id:2，同时带来了新记录 id:3
      body: [
        { id: '2', server_updated_at: '2025-01-01T00:00:00Z' },
        { id: '3', server_updated_at: '2025-01-01T00:00:00Z' }
      ]
    },
    { body: [] }
  ];
  let index = 0;
  const fetchImpl = makeFetch(() => pages[index++]);
  const client = clientWith(fetchImpl);
  client.applyAuth(authPayload());

  const rows = await client.pullRows('records', { cursor: '', limit: 2 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.id), ['1', '2', '3']);
});

test('401 时自动 refresh 后重试一次', async () => {
  let recordCalls = 0;
  const fetchImpl = makeFetch(url => {
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      return { body: { ...authPayload(), access_token: 'access-2' } };
    }
    recordCalls += 1;
    if (recordCalls === 1) return { status: 401, body: { message: 'JWT expired' } };
    return { body: [{ id: '1', server_updated_at: '2025-01-01T00:00:00Z' }] };
  });
  const client = clientWith(fetchImpl);
  client.applyAuth(authPayload());

  const rows = await client.pullRows('records');
  assert.equal(rows.length, 1);
  assert.equal(client.session.accessToken, 'access-2');
  const last = fetchImpl.calls.at(-1);
  assert.equal(last.init.headers.Authorization, 'Bearer access-2');
});

test('识别免费项目暂停并给出恢复提示', async () => {
  const fetchImpl = makeFetch(() => ({ status: 540, body: { message: 'Project is paused' } }));
  const client = clientWith(fetchImpl);
  client.applyAuth(authPayload());
  await assert.rejects(
    () => client.pullRows('records'),
    error => error instanceof CloudError && error.paused === true
  );
  assert.match(describeError(new CloudError('x', { paused: true })), /Resume project/);
});

test('未登录时不发请求', async () => {
  const fetchImpl = makeFetch(() => ({ body: [] }));
  const client = clientWith(fetchImpl);
  await assert.rejects(() => client.pullRows('records'), /没有登录/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('toRemoteRecord 使用数据库字段并保留空到手', () => {
  const row = toRemoteRecord({
    id: 'r1', platformId: 'plat-wechat', orderedAt: '2026-10-13',
    orderNo: 'n', externalId: 'e', customerService: 'Eonc', title: '标题',
    commission: 80, received: null, receivedInferred: false, note: '',
    status: '未标记', createdAt: 'c', updatedAt: 'u', deletedAt: null
  });
  assert.equal(row.platform_id, 'plat-wechat');
  assert.equal(row.received, null);
  assert.equal(row.received_inferred, false);
  assert.equal(row.server_updated_at, undefined);
  assert.equal(row.source, undefined);
});

test('mapRemoteRecord 还原 camelCase', () => {
  const record = mapRemoteRecord({
    id: 'r1', platform_id: 'plat-wechat', ordered_at: '2026-10-13',
    order_no: 'n', external_id: 'e', customer_service: 'Eonc', title: '标题',
    commission: '80.00', received: '80.00', received_inferred: true, note: '',
    status: '已完成', created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T08:00:00Z', deleted_at: null
  });
  assert.equal(record.commission, 80);
  assert.equal(record.received, 80);
  assert.equal(record.receivedInferred, true);
  assert.equal(record.platformId, 'plat-wechat');
});

test('合并：远端更新则覆盖，本地更新则保留待推送', () => {
  const local = [
    mapRemoteRecord({
      id: 'a', platform_id: 'p', ordered_at: '2025-01-01', commission: 10,
      received: null, status: '进行中', updated_at: '2025-01-02T00:00:00Z'
    }),
    mapRemoteRecord({
      id: 'b', platform_id: 'p', ordered_at: '2025-01-01', commission: 10,
      received: null, status: '进行中', updated_at: '2025-01-05T00:00:00Z'
    })
  ];
  const remote = [
    { id: 'a', platform_id: 'p', ordered_at: '2025-01-01', commission: '20', received: null, status: '已完成', updated_at: '2025-01-03T00:00:00Z', server_updated_at: 's1' },
    { id: 'b', platform_id: 'p', ordered_at: '2025-01-01', commission: '10', received: null, status: '进行中', updated_at: '2025-01-04T00:00:00Z', server_updated_at: 's2' },
    { id: 'c', platform_id: 'p', ordered_at: '2025-02-01', commission: '30', received: null, status: '已完成', updated_at: '2025-01-06T00:00:00Z', server_updated_at: 's3' }
  ];
  const merged = mergeRecords(local, remote, ['a', 'b']);
  assert.equal(merged.records.find(item => item.id === 'a').commission, 20);
  assert.equal(merged.records.find(item => item.id === 'b').commission, 10);
  assert.deepEqual(merged.dirty, ['b']);
  assert.equal(merged.conflicted, 1);
  assert.equal(merged.added, 1);
  assert.equal(merged.remoteWins, 1);
});

test('平台合并取更新时间更晚的一方', () => {
  const merged = mergePlatforms(
    [{ id: 'p', name: '旧名字', color: '#111111', sort: 1, updatedAt: '2025-01-01T00:00:00Z' }],
    [{ id: 'p', name: '新名字', color: '#222222', sort: 1, updated_at: '2025-06-01T00:00:00Z' }]
  );
  assert.equal(merged[0].name, '新名字');
});

test('syncOnce：先拉后推，清空待同步并推进游标', async () => {
  const remoteRecord = {
    id: 'remote-1', platform_id: 'plat-wechat', ordered_at: '2026-10-13',
    order_no: '', external_id: '', customer_service: 'Eonc', title: '远程记录',
    commission: '80.00', received: null, received_inferred: false, note: '',
    status: '未标记', created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T08:00:00Z',
    deleted_at: null, server_updated_at: '2026-10-13T08:00:01Z'
  };
  const fetchImpl = makeFetch(url => {
    if (url.includes('/rest/v1/records?') && url.includes('select')) {
      return { body: [remoteRecord] };
    }
    if (url.includes('/rest/v1/platforms?')) {
      return { body: [{ id: 'plat-fanmiao', name: '帆淼写作设计', color: '#b08a57', sort: 1, updated_at: '2025-01-01T00:00:00Z', server_updated_at: '2025-01-01T00:00:00Z' }] };
    }
    return { body: [] };
  });
  const client = clientWith(fetchImpl);
  client.applyAuth(authPayload());

  const state = createState();
  state.records = [
    mapRemoteRecord({ id: 'local-1', platform_id: 'plat-fanmiao', ordered_at: '2025-05-06', commission: 50, status: '已完成', received: 50, updated_at: '2025-05-06T00:00:00Z' })
  ];
  state.sync.dirty = ['local-1'];

  const result = await syncOnce({ client, state });
  assert.equal(result.records.length, 2);
  assert.equal(result.pushed, 1);
  assert.deepEqual(result.dirty, []);
  assert.equal(result.cursor, '2026-10-13T08:00:01Z');

  const pushCall = fetchImpl.calls.find(call => call.url.includes('on_conflict=id') && call.init.body?.includes('local-1'));
  assert.ok(pushCall, '应该把本地记录推上去');
  assert.equal(pushCall.init.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  const body = JSON.parse(pushCall.init.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'local-1');
  assert.equal(body[0].platform_id, 'plat-fanmiao');
});
