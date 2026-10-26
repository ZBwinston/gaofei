import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_TIME,
  createBackup,
  createState,
  computeStats,
  customerServiceBreakdown,
  diffRecords,
  filterRecords,
  formatMoney,
  groupByMonth,
  inferReceived,
  monthKey,
  monthlyTrend,
  normalizeDate,
  normalizeRecord,
  normalizeState,
  normalizeStatus,
  parseBackup,
  pendingRecords,
  platformBreakdown,
  previousPeriodStats,
  recordsToCSV,
  statusBreakdown,
  todayISO
} from '../lib.js';

function sample(overrides = {}) {
  return normalizeRecord({
    id: 'r-test',
    platformId: 'plat-fanmiao',
    orderedAt: '2025-05-06',
    title: '测试作品',
    commission: 100,
    status: '已完成',
    ...overrides
  });
}

test('normalizeStatus 把源表写法统一到 6 种状态', () => {
  assert.equal(normalizeStatus('完结'), '已完成');
  assert.equal(normalizeStatus('已创建'), '进行中');
  assert.equal(normalizeStatus(''), '未标记');
  assert.equal(normalizeStatus('已取消'), '已取消');
  assert.equal(normalizeStatus('奇怪的值'), '待确认');
});

test('inferReceived：已完成 + 无备注 + 无到手 ⇒ 全额到手', () => {
  assert.deepEqual(
    inferReceived({ status: '已完成', note: '', received: null, commission: 130 }),
    { received: 130, inferred: true }
  );
  assert.deepEqual(
    inferReceived({ status: '已完成', note: '退款', received: null, commission: 50 }),
    { received: null, inferred: false }
  );
  assert.deepEqual(
    inferReceived({ status: '已完成', note: '', received: 0, commission: 50 }),
    { received: 0, inferred: false }
  );
  assert.deepEqual(
    inferReceived({ status: '进行中', note: '', received: null, commission: 50 }),
    { received: null, inferred: false }
  );
});

test('normalizeRecord 解析日期与金额', () => {
  assert.equal(normalizeDate('2025年5月6日'), '2025-05-06');
  assert.equal(normalizeDate('2025/5/6'), '2025-05-06');
  assert.equal(normalizeDate(''), '');
  const record = normalizeRecord({
    id: 'x', orderedAt: '2025-05-06', commission: '39.4', received: '¥3.75', title: '  题目  '
  });
  assert.equal(record.commission, 39.4);
  assert.equal(record.received, 3.75);
  assert.equal(record.title, '题目');
  assert.equal(record.receivedInferred, false);
});

test('归一化时保持到手为空而不是 0', () => {
  const record = normalizeRecord({ id: 'y', orderedAt: '2025-05-06', commission: 60 });
  assert.equal(record.received, null);
});

test('formatMoney / monthKey', () => {
  assert.equal(formatMoney(12345.67), '12,345.67');
  assert.equal(formatMoney(50), '50');
  assert.equal(formatMoney(12.5), '12.50');
  assert.equal(monthKey('2025-05-06'), '2025-05');
});

test('computeStats 与源表口径一致（三笔退款 + 两笔全额）', () => {
  const records = [
    sample({ id: 'a', commission: 10, received: 5, receivedInferred: false }),
    sample({ id: 'b', commission: 30, received: 15 }),
    sample({ id: 'c', commission: 20, received: 0 }),
    sample({ id: 'd', commission: 80, received: 80 }),
    sample({ id: 'e', commission: 80, received: 80 })
  ];
  const stats = computeStats(records);
  assert.equal(stats.count, 5);
  assert.equal(stats.commission, 220);
  assert.equal(stats.received, 180);
  assert.equal(stats.diff, 40);
  assert.equal(stats.pendingCount, 0);
  assert.equal(stats.doneCount, 5);
});

test('差额与待收清单', () => {
  const records = [
    sample({ id: 'a', commission: 10, received: 5 }),
    sample({ id: 'b', commission: 30, received: 15 }),
    sample({ id: 'c', commission: 20, received: 0 }),
    sample({ id: 'd', commission: 100, received: null })
  ];
  const diffs = diffRecords(records);
  assert.equal(diffs.length, 3);
  assert.equal(diffs.reduce((sum, item) => sum + item.diff, 0), 40);
  assert.equal(pendingRecords(records).length, 1);
});

test('筛选：年份、月份、平台、状态、关键词', () => {
  const records = [
    sample({ id: 'a', orderedAt: '2025-05-06', title: '乡村振兴调研' }),
    sample({ id: 'b', orderedAt: '2026-10-13', title: '跨境电商报告', platformId: 'plat-wechat' }),
    sample({ id: 'c', orderedAt: '2026-08-20', title: '试卷分析', status: '进行中' })
  ];
  assert.equal(filterRecords(records, { year: '2026' }).length, 2);
  assert.equal(filterRecords(records, { month: '2026-10' }).length, 1);
  assert.equal(filterRecords(records, { platformId: 'plat-wechat' }).length, 1);
  assert.equal(filterRecords(records, { status: '进行中' }).length, 1);
  assert.equal(filterRecords(records, { query: '乡村' }).length, 1);
  assert.equal(filterRecords(records, {}).length, 3);
  assert.equal(filterRecords(records, {})[0].id, 'b');
});

test('按月分组与近 12 个月趋势', () => {
  const records = [
    sample({ id: 'a', orderedAt: '2025-05-06', commission: 100, received: 50 }),
    sample({ id: 'b', orderedAt: '2025-05-20', commission: 20, received: 20 }),
    sample({ id: 'c', orderedAt: '2025-06-01', commission: 10, received: 10 })
  ];
  const groups = groupByMonth(records);
  assert.equal(groups[0].key, '2025-06');
  assert.equal(groups[1].key, '2025-05');
  assert.equal(groups[1].records.length, 2);
  assert.equal(groups[1].received, 70);

  const trend = monthlyTrend(records, new Date('2025-06-15T00:00:00'), 12);
  assert.equal(trend.length, 12);
  assert.equal(trend.at(-1).key, '2025-06');
  assert.equal(trend.at(-1).received, 10);
});

test('平台、客服、状态统计', () => {
  const state = createState();
  const records = [
    sample({ id: 'a', platformId: 'plat-fanmiao', customerService: '陈慧' }),
    sample({ id: 'b', platformId: 'plat-wechat', customerService: 'Eonc' }),
    sample({ id: 'c', platformId: 'plat-wechat', customerService: 'Eonc' })
  ];
  const platforms = platformBreakdown(records, state.platforms);
  assert.equal(platforms[0].id, 'plat-wechat');
  assert.equal(platforms[0].count, 2);
  const services = customerServiceBreakdown(records);
  assert.equal(services[0].name, 'Eonc');
  assert.equal(services[0].count, 2);
  const statuses = statusBreakdown(records);
  assert.equal(statuses.find(item => item.status === '已完成').count, 3);
});

test('备份导出再导入不丢数据', () => {
  const state = createState();
  state.records = [
    sample({ id: 'a', receivedInferred: true }),
    sample({ id: 'b', status: '进行中', received: null })
  ];
  state.sync.dirty = ['a'];
  const text = createBackup(state);
  const restored = parseBackup(text);
  assert.equal(restored.records.length, 2);
  assert.equal(restored.records.find(item => item.id === 'a').receivedInferred, true);
  assert.equal(restored.platforms.length, 4);
  assert.equal(restored.platforms[0].updatedAt, BASE_TIME);
  // 备份不携带同步队列，导入后由 App 统一标记为待上传
  assert.deepEqual(restored.sync.dirty, []);
});

test('拒绝别的 App 的备份', () => {
  assert.throws(() => parseBackup('{"app":"稿记","records":[]}'), /不是/);
  assert.throws(() => parseBackup('not json'), /无法读取/);
});

test('CSV 导出带 BOM 与表头', () => {
  const state = createState();
  state.records = [sample({ id: 'a', received: 100, receivedInferred: true, note: '含,逗号' })];
  const csv = recordsToCSV(state);
  assert.ok(csv.startsWith('\ufeff订单时间,平台'));
  assert.match(csv, /帆淼写作设计/);
  assert.match(csv, /"含,逗号"/);
  assert.match(csv, /自动全额/);
});

test('normalizeState 去重 ID 并补齐平台', () => {
  const state = normalizeState({
    platforms: [{ id: 'plat-custom', name: '新平台' }],
    records: [
      { id: 'dup', platformId: 'plat-custom', orderedAt: '2025-01-02', title: 'A' },
      { id: 'dup', platformId: 'plat-custom', orderedAt: '2025-01-03', title: 'B' }
    ]
  });
  assert.equal(state.records.length, 1);
  assert.equal(state.platforms.length, 5);
  assert.ok(state.platforms.some(item => item.id === 'plat-custom'));
});

test('周期区间与上期统计', () => {
  const now = new Date('2026-10-26T12:00:00');
  assert.equal(todayISO(now), '2026-10-26');
  const records = [sample({ id: 'a', orderedAt: '2026-10-13' })];
  const prev = previousPeriodStats(records, 'month', now);
  assert.equal(prev.count, 0);
  const periodStats = computeStats(filterRecords(records, { month: '2026-10' }));
  assert.equal(periodStats.count, 1);
});
