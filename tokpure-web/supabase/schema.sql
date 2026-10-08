-- ============================================================
-- TokPure 账号体系 · Supabase schema
-- 项目：TokPure (yldcreewpyumekecximd, ap-southeast-1)
--
-- 表结构与 public-pkg 适配器约定一致（表名固定，不可改）：
--   users / credits / subscriptions / blogs
-- 执行方式：
--   curl -X POST "$SUPABASE_URL../v1/projects/<ref>/database/query"
--   或在 Supabase SQL Editor 里整体粘贴执行。
-- 本脚本幂等，可重复执行。
-- ============================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────
-- users：业务用户档案（id 与 auth.users.id 一致）
-- ────────────────────────────────────────────────────────────
create table if not exists public.users (
  id            uuid primary key,
  email         text unique not null,
  name          text,
  role          text not null default 'user',
  google_id     text,
  password_hash text,
  avatar_url    text,
  -- 冗余展示列：后台用户列表直接读 users.credits，真源仍是 credits.balance
  credits       integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────
-- credits：积分余额（真源）
-- ────────────────────────────────────────────────────────────
create table if not exists public.credits (
  user_id    uuid primary key references public.users(id) on delete cascade,
  balance    integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────
-- subscriptions：订阅 / 订单
-- ────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  plan_type  text not null default 'free',
  status     text not null default 'active',
  -- 后台订单列表读取的展示列
  email      text,
  plan       text,
  amount     numeric(10, 2),
  created_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

-- ────────────────────────────────────────────────────────────
-- blogs：博客文章（前台直连读取，后台经服务端写入）
-- ────────────────────────────────────────────────────────────
create table if not exists public.blogs (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  slug              text,
  content           text not null default '',
  summary           text,
  category          text not null default 'General',
  cover_image       text,
  author            text,
  is_published      boolean not null default false,
  locale            text not null default 'zh',
  parent_id         uuid,
  translation_group text,
  view_count        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists blogs_published_idx on public.blogs(is_published, created_at desc);
create unique index if not exists blogs_slug_idx on public.blogs(slug) where slug is not null;

-- ────────────────────────────────────────────────────────────
-- updated_at 自动维护
-- ────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch on public.users;
create trigger users_touch before update on public.users
  for each row execute function public.touch_updated_at();

drop trigger if exists blogs_touch on public.blogs;
create trigger blogs_touch before update on public.blogs
  for each row execute function public.touch_updated_at();

-- ────────────────────────────────────────────────────────────
-- 管理员判定：只读 JWT 的 email claim，不查表 → 避免 RLS 递归
-- （管理员邮箱与 pkg-config 的 ADMIN_EMAILS 保持一致）
-- ────────────────────────────────────────────────────────────
create or replace function public.is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('admin@126.com')
$$;

-- ────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────
alter table public.users         enable row level security;
alter table public.credits       enable row level security;
alter table public.subscriptions enable row level security;
alter table public.blogs         enable row level security;

-- users：本人可读写自己的档案；管理员可读全部
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists users_insert_self on public.users;
create policy users_insert_self on public.users
  for insert with check (auth.uid() = id);

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (auth.uid() = id or public.is_admin());

-- credits：本人可读自己的余额；管理员可读全部
drop policy if exists credits_select_self on public.credits;
create policy credits_select_self on public.credits
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists credits_insert_self on public.credits;
create policy credits_insert_self on public.credits
  for insert with check (auth.uid() = user_id);

-- subscriptions：本人可读自己的订阅；管理员可读全部
drop policy if exists subscriptions_select_self on public.subscriptions;
create policy subscriptions_select_self on public.subscriptions
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists subscriptions_insert_self on public.subscriptions;
create policy subscriptions_insert_self on public.subscriptions
  for insert with check (auth.uid() = user_id);

-- blogs：已发布文章公开可读；草稿仅管理员可见；写入仅管理员
drop policy if exists blogs_select_published on public.blogs;
create policy blogs_select_published on public.blogs
  for select using (is_published = true or public.is_admin());

drop policy if exists blogs_admin_write on public.blogs;
create policy blogs_admin_write on public.blogs
  for insert with check (public.is_admin());

drop policy if exists blogs_admin_update on public.blogs;
create policy blogs_admin_update on public.blogs
  for update using (public.is_admin());

drop policy if exists blogs_admin_delete on public.blogs;
create policy blogs_admin_delete on public.blogs
  for delete using (public.is_admin());