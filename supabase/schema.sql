-- 稿费记录 · Supabase 初始化脚本
-- 用法：Supabase 控制台 → SQL Editor → 全选粘贴 → Run（只需执行一次）
-- 说明：所有数据都用行级权限隔离，浏览器里放的 anon key 即使被人看到也读不到别人的数据。

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 表结构
-- ---------------------------------------------------------------------------
create table if not exists public.records (
  id                 text primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  platform_id        text not null,
  ordered_at         date not null,
  order_no           text not null default '',
  external_id        text not null default '',
  customer_service   text not null default '',
  title              text not null default '',
  commission         numeric(12, 2) not null default 0,
  received           numeric(12, 2),
  received_inferred  boolean not null default false,
  note               text not null default '',
  status             text not null default '未标记',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  server_updated_at  timestamptz not null default now()
);

create table if not exists public.platforms (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  color       text not null default '#b08a57',
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  server_updated_at timestamptz not null default now()
);

create index if not exists records_user_server_idx
  on public.records (user_id, server_updated_at, id);
create index if not exists records_user_order_idx
  on public.records (user_id, ordered_at desc);
create index if not exists platforms_user_server_idx
  on public.platforms (user_id, server_updated_at, id);

-- ---------------------------------------------------------------------------
-- 服务端时间戳：同步游标用服务器时间，不受手机时钟影响
-- ---------------------------------------------------------------------------
create or replace function public.touch_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists records_touch_server on public.records;
create trigger records_touch_server
  before insert or update on public.records
  for each row execute function public.touch_server_updated_at();

drop trigger if exists platforms_touch_server on public.platforms;
create trigger platforms_touch_server
  before insert or update on public.platforms
  for each row execute function public.touch_server_updated_at();

-- ---------------------------------------------------------------------------
-- 行级权限：每个账号只能碰自己的行
-- ---------------------------------------------------------------------------
alter table public.records enable row level security;
alter table public.platforms enable row level security;

drop policy if exists "records select own" on public.records;
create policy "records select own" on public.records
  for select using (user_id = auth.uid());

drop policy if exists "records insert own" on public.records;
create policy "records insert own" on public.records
  for insert with check (user_id = auth.uid());

drop policy if exists "records update own" on public.records;
create policy "records update own" on public.records
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "records delete own" on public.records;
create policy "records delete own" on public.records
  for delete using (user_id = auth.uid());

drop policy if exists "platforms select own" on public.platforms;
create policy "platforms select own" on public.platforms
  for select using (user_id = auth.uid());

drop policy if exists "platforms insert own" on public.platforms;
create policy "platforms insert own" on public.platforms
  for insert with check (user_id = auth.uid());

drop policy if exists "platforms update own" on public.platforms;
create policy "platforms update own" on public.platforms
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "platforms delete own" on public.platforms;
create policy "platforms delete own" on public.platforms
  for delete using (user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.records to authenticated;
grant select, insert, update, delete on public.platforms to authenticated;

-- ---------------------------------------------------------------------------
-- 保活表：给 GitHub Action 每两天查一次，避免免费项目 7 天无请求被暂停
-- ---------------------------------------------------------------------------
create table if not exists public.keepalive (
  id integer primary key,
  touched_at timestamptz not null default now()
);

insert into public.keepalive (id) values (1)
on conflict (id) do nothing;

alter table public.keepalive enable row level security;

drop policy if exists "keepalive read" on public.keepalive;
create policy "keepalive read" on public.keepalive
  for select to anon, authenticated using (true);

grant select on public.keepalive to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 自检（执行后应看到 records/platforms 两张表 + 9 条策略）
-- ---------------------------------------------------------------------------
select 'records' as table_name, count(*) as rows from public.records
union all
select 'platforms', count(*) from public.platforms;
