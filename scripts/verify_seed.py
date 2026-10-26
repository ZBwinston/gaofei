#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""检查 private/seed.json 的结构与金额口径。

固定数值放在 private/expected.json（不进仓库）。没有这个文件时只做结构检查。
运行：python scripts/verify_seed.py
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, 'private', 'seed.json')
EXPECTED_FILE = os.path.join(ROOT, 'private', 'expected.json')

VALID_STATUS = {'已完成', '进行中', '待修改', '待确认', '已取消', '未标记'}


def main():
    if not os.path.exists(SEED):
        print(f'FAIL 找不到 {SEED}，先运行 python scripts/import_xlsx.py')
        return 1

    with open(SEED, encoding='utf-8') as handle:
        seed = json.load(handle)

    expected = None
    if os.path.exists(EXPECTED_FILE):
        with open(EXPECTED_FILE, encoding='utf-8') as handle:
            expected = json.load(handle)

    problems = 0

    def expect(condition, message):
        nonlocal problems
        if not condition:
            problems += 1
            print(f'FAIL {message}')

    records = seed.get('records', [])
    platforms = seed.get('platforms', [])

    expect(seed.get('app') == '稿费记录', 'app 标识不对')
    expect(bool(records), '没有任何记录')
    expect(len({record.get('id') for record in records}) == len(records), '记录 ID 有重复')

    commission = round(sum(record.get('commission', 0) for record in records), 2)
    received = round(sum(record.get('received') or 0 for record in records), 2)
    diff = round(sum(
        (record.get('commission') or 0) - (record.get('received') or 0)
        for record in records if record.get('received') is not None
    ), 2)
    inferred = sum(1 for record in records if record.get('receivedInferred'))
    pending = [record for record in records if record.get('received') is None]

    statuses = Counter(record.get('status') for record in records)
    platform_ids = {platform.get('id') for platform in platforms}
    buckets = defaultdict(lambda: [0, 0.0, 0.0])

    for record in records:
        platform_id = record.get('platformId')
        expect(platform_id in platform_ids, f'记录 {record.get("id")} 的平台 {platform_id} 不存在')
        bucket = buckets[platform_id]
        bucket[0] += 1
        bucket[1] += record.get('commission', 0)
        bucket[2] += record.get('received') or 0

        date = str(record.get('orderedAt', ''))
        expect(len(date) == 10 and date[4] == '-' and date[7] == '-', f'日期格式不对：{date}')
        expect(record.get('status') in VALID_STATUS, f'未知状态：{record.get("status")}')
        expect(record.get('commission', -1) >= 0, f'佣金为负：{record.get("id")}')
        if record.get('receivedInferred'):
            expect(record.get('received') == record.get('commission'), f'推定金额不等于佣金：{record.get("id")}')
            expect(record.get('note') == '', f'推定记录却有备注：{record.get("id")}')
            expect(record.get('status') == '已完成', f'推定记录不是已完成：{record.get("id")}')
        if record.get('received') is None:
            expect(record.get('status') != '已完成' or record.get('note') != '',
                   f'已完成且无备注却没算到手：{record.get("id")}')

    if expected:
        expect(len(records) == expected['records'], f"记录数 {len(records)} != {expected['records']}")
        expect(len(platforms) == expected['platforms'], f"平台数 {len(platforms)} != {expected['platforms']}")
        expect(abs(commission - expected['commission']) < 0.005,
               f"佣金合计 {commission} != {expected['commission']}")
        expect(abs(received - expected['received']) < 0.005,
               f"到手合计 {received} != {expected['received']}")
        expect(abs(diff - expected['diff']) < 0.005, f"差额合计 {diff} != {expected['diff']}")
        expect(inferred == expected['inferred'], f"自动推定 {inferred} 条 != {expected['inferred']}")
        expect(len(pending) == expected['pending'], f"未填到手 {len(pending)} 条 != {expected['pending']}")
        expect(dict(statuses) == expected['statuses'], f'状态分布不对：{dict(statuses)}')
        for platform_id, bucket_expected in expected['byPlatform'].items():
            bucket = buckets[platform_id]
            expect(bucket[0] == bucket_expected['count'], f'{platform_id} 条数不对')
            expect(abs(bucket[1] - bucket_expected['commission']) < 0.005, f'{platform_id} 佣金不对')
            expect(abs(bucket[2] - bucket_expected['received']) < 0.005, f'{platform_id} 到账不对')

    print('=' * 46)
    print('稿费记录 · 历史数据校验')
    print('=' * 46)
    print(f'记录        {len(records)}')
    print(f'平台        {len(platforms)}')
    print(f'接单佣金    {commission:.2f}')
    print(f'到手        {received:.2f}（自动推定 {inferred} 条）')
    print(f'差额        {diff:.2f}')
    print(f'待填到手    {len(pending)} 条')
    print(f'状态        {dict(statuses)}')
    print('=' * 46)

    if not expected:
        print('提示：没有 private/expected.json，只做了结构检查。')
    if problems:
        print(f'FAIL 共 {problems} 项不符合预期')
        return 1
    print('OK 全部符合预期')
    return 0


if __name__ == '__main__':
    sys.exit(main())
