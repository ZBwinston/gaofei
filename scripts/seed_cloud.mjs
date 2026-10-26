#!/usr/bin/env node
// 可选：不打开浏览器，直接把 private/seed.json 灌进 Supabase。
// 用法：
//   node scripts/seed_cloud.mjs --url https://xxxx.supabase.co --key <anon-key> \
//        --email you@example.com --password 你的密码 [--signup] [--file private/seed.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeState } from '../lib.js';
import { CloudClient, toRemotePlatform, toRemoteRecord } from '../sync.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=');
    if (inline !== undefined) {
      options[rawKey] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[rawKey] = argv[index + 1];
      index += 1;
    } else {
      options[rawKey] = true;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const url = String(options.url || '').replace(/\/+$/, '');
const key = String(options.key || '');
const email = String(options.email || '');
const password = String(options.password || '');
const file = path.resolve(root, options.file || 'private/seed.json');

if (!url || !key || !email || !password) {
  console.error('用法：node scripts/seed_cloud.mjs --url <Supabase URL> --key <anon key> --email <邮箱> --password <密码> [--signup] [--file private/seed.json]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}，先运行 python scripts/import_xlsx.py`);
  process.exit(2);
}

const seed = normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
const client = new CloudClient({ url, anonKey: key });

console.log(`准备上传：${seed.records.length} 条记录、${seed.platforms.length} 个平台 → ${url}`);
try {
  if (options.signup) {
    await client.signUp(email, password);
    console.log('注册成功');
  } else {
    await client.signIn(email, password);
    console.log(`已登录：${email}`);
  }
} catch (error) {
  console.error(`登录失败：${error.message}`);
  console.error('如果是第一次用，加 --signup；如果是密码不对，请先重置。');
  process.exit(1);
}

try {
  const platforms = await client.upsertRows('platforms', seed.platforms.map(toRemotePlatform));
  console.log(`平台已上传：${platforms}`);
  const records = await client.upsertRows('records', seed.records.map(toRemoteRecord));
  console.log(`记录已上传：${records}`);
  console.log('完成。手机上登录同一账号即可拉取。');
} catch (error) {
  console.error(`上传失败：${error.message}`);
  if (error.paused) {
    console.error('项目处于暂停状态：打开 supabase.com/dashboard → Resume project 后重试。');
  }
  process.exit(1);
}
