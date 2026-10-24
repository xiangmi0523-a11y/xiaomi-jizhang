-- =====================================================================
-- 晓米记账 · 云同步建表脚本（在 Supabase → SQL Editor 里整段粘贴，点 Run）
-- 可以重复执行：已经存在的表/策略不会报错，也不会删数据。
--
-- 五张表：
--   xm_records     账单（每一笔记账）
--   xm_accounts    账户（现金、微信、银行卡…）
--   xm_categories  收支分类
--   xm_cats        猫咪（图鉴、遇见次数、心情）
--   xm_state       其余设置的整体快照（预算、智能预算、存钱计划、金币、客栈装修、主题…）
--
-- 每张表都带 user_id，并开启行级安全（RLS）：登录用户只能读写 user_id = 自己 的行，
-- 别人（包括只拿着 publishable key 的未登录请求）一行都看不到。
-- 删除用「软删除」（deleted = true）记录下来，这样别的设备同步时也能知道这条被删了。
-- =====================================================================

-- ---------- 通用：每次写入时由数据库自动刷新 updated_at（同步靠它判断谁更新） ----------
create or replace function public.xm_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- 账单 ----------
create table if not exists public.xm_records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  type       text        check (type in ('expense', 'income', 'transfer')),
  amount     bigint      check (amount > 0),          -- 金额，单位：分
  cat        text,                                    -- 分类 id
  acc        text,                                    -- 账户 id
  to_acc     text,                                    -- 转账的转入账户 id
  date       date,                                    -- 记账日期
  note       text        not null default '',
  ts         bigint,                                  -- 记账时刻（毫秒时间戳）
  rec        text,                                    -- 由哪条周期记账生成
  extra      jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------- 账户 ----------
create table if not exists public.xm_accounts (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  name       text,
  type       text,                                    -- cash / ewallet / bank / credit / invest / other
  init       bigint      not null default 0,          -- 初始余额（分，信用卡为负数）
  hidden     boolean     not null default false,
  sort       integer     not null default 0,
  extra      jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------- 收支分类 ----------
create table if not exists public.xm_categories (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  kind       text        check (kind in ('expense', 'income')),
  name       text,
  icon       text,
  hidden     boolean     not null default false,
  sort       integer     not null default 0,
  extra      jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------- 猫咪 ----------
create table if not exists public.xm_cats (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  cat_id     text        not null,                    -- n1 橘子、r1 墨镜、s1 金鬃…
  got        date,                                    -- 第一次遇见的日期
  n          integer     not null default 1,          -- 一共遇见几次
  mood       integer,                                 -- 心情 0~100
  fed        date,                                    -- 最近一次喂罐头
  extra      jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, cat_id)
);

-- ---------- 其余设置的整体快照 ----------
create table if not exists public.xm_state (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- 触发器、索引、行级安全、权限（对五张表统一处理） ----------
do $$
declare
  t text;
begin
  foreach t in array array['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats', 'xm_state'] loop
    -- updated_at 由数据库自动刷新
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.xm_touch_updated_at()', t || '_touch', t);

    -- 按「用户 + 更新时间」查增量
    execute format('create index if not exists %I on public.%I (user_id, updated_at)', t || '_user_updated_idx', t);

    -- 行级安全：只允许本人
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t || '_delete_own', t);

    -- 未登录（anon）完全不能碰；登录用户只能做增删改查，再由上面的策略限制到自己的行
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- 执行完可以用这句检查：五张表的 rowsecurity 都应该是 true
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename like 'xm_%';
