import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const seedUrl = new URL('../private/seed.json', import.meta.url);
const expectedUrl = new URL('../private/expected.json', import.meta.url);
const hasSeed = existsSync(seedUrl);
const expected = existsSync(expectedUrl) ? JSON.parse(readFileSync(expectedUrl, 'utf8')) : null;

function loadSeed() {
  return JSON.parse(readFileSync(seedUrl, 'utf8'));
}

test('seed 结构合法', { skip: hasSeed ? false : 'private/seed.json 尚未生成，先跑 scripts/import_xlsx.py' }, () => {
  const seed = loadSeed();
  const records = seed.records;

  assert.equal(seed.app, '稿费记录');
  assert.ok(Array.isArray(seed.platforms) && seed.platforms.length > 0, '至少有一个平台');
  assert.ok(records.length > 0, '至少有一条记录');
  assert.equal(new Set(records.map(record => record.id)).size, records.length, '记录 ID 不能重复');

  const platformIds = new Set(seed.platforms.map(platform => platform.id));
  assert.equal(platformIds.size, seed.platforms.length, '平台 ID 不能重复');

  records.forEach(record => {
    assert.match(record.orderedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(platformIds.has(record.platformId), `未知平台：${record.platformId}`);
    assert.ok(record.commission >= 0);
    assert.ok(['已完成', '进行中', '待修改', '待确认', '已取消', '未标记'].includes(record.status));
    if (record.receivedInferred) {
      assert.equal(record.status, '已完成');
      assert.equal(record.note, '');
      assert.equal(record.received, record.commission);
    }
    if (record.received === null) {
      assert.ok(record.status !== '已完成' || record.note !== '', '已完成且无备注的记录应自动算全额');
    }
  });
});

test('seed 与本地 expected.json 口径一致', {
  skip: !hasSeed ? '缺少 seed.json' : (expected ? false : '缺少 private/expected.json，跳过固定数值核对')
}, () => {
  const seed = loadSeed();
  const records = seed.records;
  const sum = key => records.reduce((total, record) => total + (Number(record[key]) || 0), 0);

  assert.equal(records.length, expected.records);
  assert.equal(seed.platforms.length, expected.platforms);
  assert.equal(Number(sum('commission').toFixed(2)), expected.commission);
  assert.equal(Number(sum('received').toFixed(2)), expected.received);

  const diff = records
    .filter(record => record.received !== null)
    .reduce((total, record) => total + record.commission - record.received, 0);
  assert.equal(Number(diff.toFixed(2)), expected.diff);

  assert.equal(records.filter(record => record.received === null).length, expected.pending);
  assert.equal(records.filter(record => record.receivedInferred).length, expected.inferred);

  const statuses = records.reduce((map, record) => {
    map[record.status] = (map[record.status] || 0) + 1;
    return map;
  }, {});
  assert.deepEqual(statuses, expected.statuses);

  Object.entries(expected.byPlatform).forEach(([id, bucket]) => {
    const items = records.filter(record => record.platformId === id);
    assert.equal(items.length, bucket.count, `${id} 条数`);
    assert.equal(Number(items.reduce((total, item) => total + item.commission, 0).toFixed(2)), bucket.commission);
    assert.equal(Number(items.reduce((total, item) => total + (item.received || 0), 0).toFixed(2)), bucket.received);
  });
});
