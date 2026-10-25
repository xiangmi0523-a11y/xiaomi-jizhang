-- =====================================================================
-- 晓米记账 · H3 备份恢复协议：账本版本号（epoch）+ 暂存区 + 单事务应用
-- 设计说明见 docs/restore-protocol.md
--
-- !!! 尚未批准在生产执行。只允许在隔离的测试数据库里运行（tests/db）。
--
-- 依赖：supabase/schema.sql 已执行（五张数据表、auth.uid()、authenticated 角色）。
-- 可以重复执行。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. 内部函数用的独立 schema（不在 PostgREST 暴露范围内）
-- ---------------------------------------------------------------------
create schema if not exists xm_guard;
revoke all on schema xm_guard from public;
grant usage on schema xm_guard to authenticated;   -- 写入触发器以调用者身份运行，需要能调用里面的加锁函数

-- ---------------------------------------------------------------------
-- 1. 每个账号的账本版本号
-- ---------------------------------------------------------------------
create table if not exists public.xm_meta (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  epoch      integer     not null default 0 check (epoch >= 0),
  updated_at timestamptz not null default now()
);
alter table public.xm_meta enable row level security;
alter table public.xm_meta force row level security;
revoke all on public.xm_meta from public, anon, authenticated, service_role;
grant select on public.xm_meta to authenticated;
drop policy if exists xm_meta_select_own on public.xm_meta;
create policy xm_meta_select_own on public.xm_meta for select to authenticated using ((select auth.uid()) = user_id);
insert into public.xm_meta (user_id) select id from auth.users on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- 2. 五张数据表：记录每一行是在哪个版本号下写入的（由触发器填写，客户端的值会被覆盖）
-- ---------------------------------------------------------------------
alter table public.xm_records    add column if not exists epoch integer not null default 0;
alter table public.xm_accounts   add column if not exists epoch integer not null default 0;
alter table public.xm_categories add column if not exists epoch integer not null default 0;
alter table public.xm_cats       add column if not exists epoch integer not null default 0;
alter table public.xm_state      add column if not exists epoch integer not null default 0;

-- ---------------------------------------------------------------------
-- 3. 恢复任务、暂存区、存档
-- ---------------------------------------------------------------------
create table if not exists public.xm_restore_job (
  job_id        uuid        primary key,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  state         text        not null check (state in ('staging', 'sealed', 'applied', 'cancelled')),
  scope         jsonb       not null,
  manifest      jsonb,
  state_patch   jsonb,
  created_epoch integer     not null,
  applied_epoch integer,
  result        jsonb,
  created_at    timestamptz not null default now(),
  sealed_at     timestamptz,
  applied_at    timestamptz,
  cancelled_at  timestamptz
);
create index if not exists xm_restore_job_user_state_idx on public.xm_restore_job (user_id, state);
alter table public.xm_restore_job enable row level security;
alter table public.xm_restore_job force row level security;
revoke all on public.xm_restore_job from public, anon, authenticated, service_role;
grant select on public.xm_restore_job to authenticated;
drop policy if exists xm_restore_job_select_own on public.xm_restore_job;
create policy xm_restore_job_select_own on public.xm_restore_job for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.xm_restore_stage (
  job_id uuid  not null references public.xm_restore_job (job_id) on delete cascade,
  tbl    text  not null,
  rkey   text  not null,
  h      text  not null,          -- 客户端给的内容指纹（服务器不解释，只参与清单摘要）
  row    jsonb not null,          -- 规范化后的整行（按目标表的列类型转换过）
  primary key (job_id, tbl, rkey)
);
alter table public.xm_restore_stage enable row level security;
alter table public.xm_restore_stage force row level security;
revoke all on public.xm_restore_stage from public, anon, authenticated, service_role;

create table if not exists public.xm_restore_archive (
  job_id uuid  not null references public.xm_restore_job (job_id) on delete cascade,
  tbl    text  not null,
  rkey   text  not null,
  row    jsonb not null,          -- 应用前的完整旧行（含 deleted / updated_at / epoch）
  primary key (job_id, tbl, rkey)
);
alter table public.xm_restore_archive enable row level security;
alter table public.xm_restore_archive force row level security;
revoke all on public.xm_restore_archive from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. 内部函数
-- ---------------------------------------------------------------------

-- 读取（必要时创建）某账号的版本号，并加共享锁：与 xm_restore_apply 的排他锁串行
create or replace function xm_guard.epoch_lock(p_uid uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  e integer;
begin
  if p_uid is null then
    return null;
  end if;
  -- 普通用户只能为自己加锁；别人的行交给 RLS 拒绝
  if (select auth.uid()) is not null and (select auth.uid()) <> p_uid then
    return null;
  end if;
  select m.epoch into e from public.xm_meta m where m.user_id = p_uid for share;
  if not found then
    insert into public.xm_meta (user_id) values (p_uid) on conflict (user_id) do nothing;
    select m.epoch into e from public.xm_meta m where m.user_id = p_uid for share;
  end if;
  return e;
end;
$$;
revoke all on function xm_guard.epoch_lock(uuid) from public, anon, service_role;
grant execute on function xm_guard.epoch_lock(uuid) to authenticated;

-- 写入保护：在数据库真正写入的那一刻检查版本号
create or replace function xm_guard.guard_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid  uuid;
  e    integer;
  hdr  json;
  v    text;
begin
  uid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;

  -- 数据库内部写入（恢复事务、后台管理、级联删除）：不查请求头，只记录当前版本号
  if current_user not in ('authenticated', 'anon') then
    if tg_op <> 'DELETE' then
      new.epoch := coalesce(xm_guard.epoch_lock(uid), 0);
      return new;
    end if;
    return old;
  end if;

  e := xm_guard.epoch_lock(uid);
  if e is null then
    -- 不是自己的行：不在这里处理，交给 RLS 拒绝
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if e > 0 then
    if tg_op = 'DELETE' then
      raise exception using errcode = 'PT409', hint = 'xm_stale_epoch',
        message = '账本已恢复过备份，不允许直接删除行';
    end if;
    begin
      hdr := nullif(current_setting('request.headers', true), '')::json;
    exception when others then
      hdr := null;
    end;
    v := hdr ->> 'x-xm-epoch';
    if v is null or v !~ '^[0-9]{1,9}$' or v::integer <> e then
      raise exception using errcode = 'PT409', hint = 'xm_stale_epoch',
        message = '账本已在另一台设备恢复过备份，请把晓米记账更新到最新版后再同步',
        detail = json_build_object('epoch', e)::text;
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new.epoch := e;
    return new;
  end if;
  return old;
end;
$$;
revoke all on function xm_guard.guard_write() from public, anon, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats', 'xm_state'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function xm_guard.guard_write()', t || '_guard', t);
  end loop;
end;
$$;

-- 可恢复的表、主键列
create or replace function xm_guard.key_col(p_tbl text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tbl
    when 'xm_records' then 'id'
    when 'xm_accounts' then 'id'
    when 'xm_categories' then 'id'
    when 'xm_cats' then 'cat_id'
  end;
$$;
revoke all on function xm_guard.key_col(text) from public, anon, authenticated, service_role;

-- 某张表的「数据列」（不含 user_id / deleted / updated_at / epoch），按列顺序
create or replace function xm_guard.data_cols(p_tbl text)
returns table (col text, not_null boolean)
language sql
stable
set search_path = ''
as $$
  select a.attname::text, a.attnotnull
  from pg_catalog.pg_attribute a
  where a.attrelid = pg_catalog.to_regclass('public.' || p_tbl)
    and a.attnum > 0 and not a.attisdropped
    and a.attname not in ('user_id', 'deleted', 'updated_at', 'epoch')
  order by a.attnum;
$$;
revoke all on function xm_guard.data_cols(text) from public, anon, authenticated, service_role;

-- jsonb 值的类型；缺失（SQL NULL）时返回 'missing'，避免 NULL 让校验条件「既不真也不假」而被跳过
create or replace function xm_guard.jt(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$ select coalesce(pg_catalog.jsonb_typeof(p), 'missing') $$;
revoke all on function xm_guard.jt(jsonb) from public, anon, authenticated, service_role;

create or replace function xm_guard.fail(p_code text, p_hint text, p_msg text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = p_code, hint = p_hint, message = p_msg, detail = coalesce(p_detail, '');
end;
$$;
revoke all on function xm_guard.fail(text, text, text, text) from public, anon, authenticated, service_role;

-- 当前登录用户；未登录直接拒绝
create or replace function xm_guard.me()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  u uuid := (select auth.uid());
begin
  if u is null then
    perform xm_guard.fail('PT401', 'xm_not_logged_in', '请先登录');
  end if;
  return u;
end;
$$;
revoke all on function xm_guard.me() from public, anon, authenticated, service_role;

-- 锁住并返回自己的任务；别人的任务当作不存在
create or replace function xm_guard.my_job(p_job uuid, p_uid uuid)
returns public.xm_restore_job
language plpgsql
set search_path = ''
as $$
declare
  j public.xm_restore_job;
begin
  if p_job is null then
    perform xm_guard.fail('PT400', 'xm_bad_input', '缺少任务编号');
  end if;
  select * into j from public.xm_restore_job where job_id = p_job for update;
  if not found or j.user_id <> p_uid then
    perform xm_guard.fail('PT404', 'xm_not_found', '找不到这个恢复任务');
  end if;
  return j;
end;
$$;
revoke all on function xm_guard.my_job(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. 客户端可调用的 RPC
-- ---------------------------------------------------------------------

-- 建任务。scope = {"tables": [...], "state_modules": [...]}
create or replace function public.xm_restore_create(p_job uuid, p_scope jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid     uuid := xm_guard.me();
  j       public.xm_restore_job;
  tbls    text[];
  mods    text[];
  e       integer;
  active  integer;
begin
  if p_job is null or p_scope is null or xm_guard.jt(p_scope) <> 'object'
     or xm_guard.jt(p_scope -> 'tables') <> 'array' or xm_guard.jt(p_scope -> 'state_modules') <> 'array' then
    perform xm_guard.fail('PT400', 'xm_bad_input', '恢复范围格式不对');
  end if;
  if exists (select 1 from jsonb_array_elements(p_scope -> 'tables') x where xm_guard.jt(x) <> 'string')
     or exists (select 1 from jsonb_array_elements(p_scope -> 'state_modules') x where xm_guard.jt(x) <> 'string') then
    perform xm_guard.fail('PT400', 'xm_bad_input', '恢复范围格式不对');
  end if;
  select coalesce(array_agg(x order by x), '{}') into tbls from jsonb_array_elements_text(p_scope -> 'tables') x;
  select coalesce(array_agg(x order by x), '{}') into mods from jsonb_array_elements_text(p_scope -> 'state_modules') x;
  if array_length(tbls, 1) <> (select count(distinct x) from unnest(tbls) x)
     or coalesce(array_length(mods, 1), 0) <> (select count(distinct x) from unnest(mods) x)
     or not (tbls <@ array['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats'])
     or not (array['xm_records', 'xm_accounts', 'xm_categories'] <@ tbls)
     or not (mods <@ array['budget', 'recurring', 'game', 'smart', 'saving', 'settings', 'created']) then
    perform xm_guard.fail('PT400', 'xm_bad_scope', '恢复范围不合法：必须包含账单、账户、分类，且只能包含已知的模块');
  end if;

  select * into j from public.xm_restore_job where job_id = p_job for update;
  if found then
    if j.user_id <> uid then
      perform xm_guard.fail('PT404', 'xm_not_found', '找不到这个恢复任务');
    end if;
    if j.scope <> jsonb_build_object('tables', to_jsonb(tbls), 'state_modules', to_jsonb(mods)) then
      perform xm_guard.fail('PT409', 'xm_bad_state', '同一个任务编号已经用于不同的恢复范围');
    end if;
    return jsonb_build_object('job', j.job_id, 'state', j.state, 'created_epoch', j.created_epoch);
  end if;

  select count(*) into active from public.xm_restore_job where user_id = uid and state in ('staging', 'sealed');
  if active >= 3 then
    perform xm_guard.fail('PT409', 'xm_too_many_jobs', '未完成的恢复任务太多了，请先取消旧的任务');
  end if;

  insert into public.xm_meta (user_id) values (uid) on conflict (user_id) do nothing;
  select epoch into e from public.xm_meta where user_id = uid;
  insert into public.xm_restore_job (job_id, user_id, state, scope, created_epoch)
  values (p_job, uid, 'staging', jsonb_build_object('tables', to_jsonb(tbls), 'state_modules', to_jsonb(mods)), e);
  return jsonb_build_object('job', p_job, 'state', 'staging', 'created_epoch', e);
end;
$$;

-- 上传一批行到暂存区。p_rows = [{"h": "<指纹>", "row": {...整行...}}, ...]，最多 500 个
create or replace function public.xm_restore_stage(p_job uuid, p_table text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid    uuid := xm_guard.me();
  j      public.xm_restore_job;
  kc     text;
  item   jsonb;
  r      jsonb;
  norm   jsonb;
  k      text;
  hv     text;
  bad    text[];
  total  integer;
  n      integer := 0;
begin
  -- 共享锁：多个标签页可以同时上传；封存（排他锁）会等它们结束
  if p_job is null then
    perform xm_guard.fail('PT400', 'xm_bad_input', '缺少任务编号');
  end if;
  select * into j from public.xm_restore_job where job_id = p_job for share;
  if not found or j.user_id <> uid then
    perform xm_guard.fail('PT404', 'xm_not_found', '找不到这个恢复任务');
  end if;
  if j.state <> 'staging' then
    perform xm_guard.fail('PT409', 'xm_bad_state', '这个恢复任务已经封存或结束，不能再上传', j.state);
  end if;
  if p_table is null or not ((j.scope -> 'tables') ? p_table) then
    perform xm_guard.fail('PT400', 'xm_bad_table', '这张表不在恢复范围内');
  end if;
  if p_rows is null or xm_guard.jt(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then
    perform xm_guard.fail('PT400', 'xm_bad_input', '每批需要 1 到 500 行');
  end if;
  kc := xm_guard.key_col(p_table);

  for item in select x from jsonb_array_elements(p_rows) x loop
    if xm_guard.jt(item) <> 'object' or xm_guard.jt(item -> 'row') <> 'object' or xm_guard.jt(item -> 'h') <> 'string' then
      perform xm_guard.fail('PT400', 'xm_bad_row', '行格式不对');
    end if;
    hv := item ->> 'h';
    if hv is null or length(hv) < 1 or length(hv) > 128 then
      perform xm_guard.fail('PT400', 'xm_bad_row', '内容指纹格式不对');
    end if;
    r := (item -> 'row') - 'user_id' - 'deleted' - 'updated_at' - 'epoch';
    k := r ->> kc;
    if k is null or k = '' or length(k) > 200 or xm_guard.jt(r -> kc) <> 'string' then
      perform xm_guard.fail('PT400', 'xm_bad_row', '行缺少主键', p_table);
    end if;
    -- 列名必须正好是这张表的数据列：多一个、少一个都拒绝
    select array_agg(x) into bad from jsonb_object_keys(r) x where x not in (select col from xm_guard.data_cols(p_table));
    if bad is not null then
      perform xm_guard.fail('PT400', 'xm_bad_row', '行里有未知的列', p_table || ': ' || array_to_string(bad, ','));
    end if;
    select array_agg(col) into bad from xm_guard.data_cols(p_table) where not (r ? col) or (not_null and xm_guard.jt(r -> col) = 'null');
    if bad is not null then
      perform xm_guard.fail('PT400', 'xm_bad_row', '行缺少必需的列', p_table || ' ' || k || ': ' || array_to_string(bad, ','));
    end if;
    -- 按目标表的列类型转换，得到规范化的整行
    begin
      execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', p_table) into norm using r;
    exception when others then
      perform xm_guard.fail('PT400', 'xm_bad_row', '行里有类型不对的值', p_table || ' ' || k || ': ' || sqlerrm);
    end;
    norm := norm - 'user_id' - 'deleted' - 'updated_at' - 'epoch';
    insert into public.xm_restore_stage (job_id, tbl, rkey, h, row)
    values (p_job, p_table, k, hv, norm)
    on conflict (job_id, tbl, rkey) do update set h = excluded.h, row = excluded.row;
    n := n + 1;
  end loop;

  select count(*) into total from public.xm_restore_stage where job_id = p_job;
  if total > 20000 then
    perform xm_guard.fail('PT400', 'xm_too_large', '备份太大了（超过 20000 行）');
  end if;
  return jsonb_build_object('job', p_job, 'table', p_table, 'staged', n);
end;
$$;

-- 封存：服务器重新计算每张表的条数和摘要，必须与客户端清单一致
-- p_manifest = {"xm_records": {"count": 12, "digest": "<sha256 hex>"}, ...}（正好是范围内的表）
-- 摘要 = sha256( 按 rkey 字节序排序后，每行 "rkey<TAB>h"，用换行连接 )
-- p_state_patch = 整块设置补丁，键必须正好是范围内的 state_modules
create or replace function public.xm_restore_seal(p_job uuid, p_manifest jsonb, p_state_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid    uuid := xm_guard.me();
  j      public.xm_restore_job;
  t      text;
  cnt    integer;
  dig    text;
  want   jsonb;
  mods   text[];
  pkeys  text[];
  patch  jsonb := coalesce(p_state_patch, '{}'::jsonb);
begin
  j := xm_guard.my_job(p_job, uid);
  if j.state = 'sealed' and j.manifest = p_manifest and j.state_patch = patch then
    return jsonb_build_object('job', p_job, 'state', 'sealed');
  end if;
  if j.state <> 'staging' then
    perform xm_guard.fail('PT409', 'xm_bad_state', '这个恢复任务不能再封存', j.state);
  end if;
  if p_manifest is null or xm_guard.jt(p_manifest) <> 'object'
     or (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(p_manifest) x)
        <> (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(j.scope -> 'tables') x) then
    perform xm_guard.fail('PT400', 'xm_bad_manifest', '清单必须正好列出恢复范围内的表');
  end if;
  if xm_guard.jt(patch) <> 'object' then
    perform xm_guard.fail('PT400', 'xm_bad_manifest', '整块设置补丁格式不对');
  end if;
  select coalesce(array_agg(x order by x), '{}') into mods from jsonb_array_elements_text(j.scope -> 'state_modules') x;
  select coalesce(array_agg(x order by x), '{}') into pkeys from jsonb_object_keys(patch) x;
  if mods <> pkeys then
    perform xm_guard.fail('PT400', 'xm_bad_manifest', '整块设置补丁的模块与恢复范围不一致');
  end if;

  for t in select x from jsonb_array_elements_text(j.scope -> 'tables') x loop
    want := p_manifest -> t;
    if xm_guard.jt(want) <> 'object' or xm_guard.jt(want -> 'count') <> 'number' or xm_guard.jt(want -> 'digest') <> 'string' then
      perform xm_guard.fail('PT400', 'xm_bad_manifest', '清单格式不对', t);
    end if;
    select count(*),
           encode(sha256(convert_to(coalesce(string_agg(s.rkey || chr(9) || s.h, chr(10) order by convert_to(s.rkey, 'UTF8')), ''), 'UTF8')), 'hex')
      into cnt, dig
      from public.xm_restore_stage s where s.job_id = p_job and s.tbl = t;
    if cnt is distinct from (want ->> 'count')::integer or dig is distinct from (want ->> 'digest') then
      perform xm_guard.fail('PT409', 'xm_manifest_mismatch', '暂存区和清单对不上：可能有批次没传完或被另一个页面改过',
        json_build_object('table', t, 'count', cnt, 'digest', dig)::text);
    end if;
  end loop;

  update public.xm_restore_job
     set state = 'sealed', manifest = p_manifest, state_patch = patch, sealed_at = now()
   where job_id = p_job;
  return jsonb_build_object('job', p_job, 'state', 'sealed');
end;
$$;

-- 应用：单个事务内完成「存档 → 覆盖 → 软删除 → 逐行核对 → 版本号 +1」，任何一步失败整体回滚
create or replace function public.xm_restore_apply(p_job uuid, p_expected_epoch integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid      uuid := xm_guard.me();
  j        public.xm_restore_job;
  e        integer;
  ne       integer;
  t        text;
  kc       text;
  cols     text;
  rcols    text;
  sets     text;
  n1       integer;
  n2       integer;
  n3       integer;
  counts   jsonb := '{}'::jsonb;
  old_data jsonb;
  new_data jsonb;
  res      jsonb;
begin
  -- 1) 锁住版本号：之后的普通写入都要等待，等到时会读到新版本号而被拒绝
  insert into public.xm_meta (user_id) values (uid) on conflict (user_id) do nothing;
  select epoch into e from public.xm_meta where user_id = uid for update;

  -- 2) 任务状态（在拿到版本号锁之后读取，保证看到最新状态）
  j := xm_guard.my_job(p_job, uid);
  if j.state = 'applied' then
    return j.result;                       -- 幂等：重复调用、响应丢失后重试
  end if;
  if j.state <> 'sealed' then
    perform xm_guard.fail('PT409', 'xm_bad_state', '恢复任务还没有封存，不能应用', j.state);
  end if;
  if p_expected_epoch is null or e <> p_expected_epoch then
    perform xm_guard.fail('PT409', 'xm_epoch_changed', '账本刚被另一台设备恢复过，请确认后再试',
      json_build_object('epoch', e)::text);
  end if;

  -- 3) 版本号 +1（之后本事务里的写入都会被记为新版本）
  ne := e + 1;
  update public.xm_meta set epoch = ne, updated_at = now() where user_id = uid;

  -- 4) 逐表：存档 → 覆盖 → 软删除 → 核对
  for t in select x from jsonb_array_elements_text(j.scope -> 'tables') x loop
    kc := xm_guard.key_col(t);
    select string_agg(format('%I', col), ', '), string_agg(format('r.%I', col), ', '),
           string_agg(format('%1$I = excluded.%1$I', col), ', ')
      into cols, rcols, sets
      from xm_guard.data_cols(t);

    execute format('insert into public.xm_restore_archive (job_id, tbl, rkey, row) select $1, %L, t.%I, to_jsonb(t) from public.%I t where t.user_id = $2', t, kc, t)
      using p_job, uid;

    execute format('insert into public.%1$I as t (user_id, %2$s, deleted) '
                   'select $1, %3$s, false from public.xm_restore_stage s cross join lateral jsonb_populate_record(null::public.%1$I, s.row) r '
                   'where s.job_id = $2 and s.tbl = %4$L '
                   'on conflict (user_id, %5$I) do update set %6$s, deleted = false', t, cols, rcols, t, kc, sets)
      using uid, p_job;

    execute format('update public.%1$I t set deleted = true where t.user_id = $1 and not t.deleted '
                   'and not exists (select 1 from public.xm_restore_stage s where s.job_id = $2 and s.tbl = %1$L and s.rkey = t.%2$I)', t, kc)
      using uid, p_job;

    -- 核对：未删除行与暂存区在「键 + 规范化整行」上双向一致，不看条数、不看时间戳
    execute format('select count(*) from ((select t.%2$I as k, to_jsonb(t) - array[''user_id'',''deleted'',''updated_at'',''epoch''] as r from public.%1$I t where t.user_id = $1 and not t.deleted) '
                   'except (select s.rkey, s.row from public.xm_restore_stage s where s.job_id = $2 and s.tbl = %1$L)) d', t, kc)
      into n1 using uid, p_job;
    execute format('select count(*) from ((select s.rkey as k, s.row as r from public.xm_restore_stage s where s.job_id = $2 and s.tbl = %1$L) '
                   'except (select t.%2$I, to_jsonb(t) - array[''user_id'',''deleted'',''updated_at'',''epoch''] from public.%1$I t where t.user_id = $1 and not t.deleted)) d', t, kc)
      into n2 using uid, p_job;
    execute format('select count(*) from public.%I t where t.user_id = $1 and not t.deleted and t.epoch <> $2', t)
      into n3 using uid, ne;
    if n1 <> 0 or n2 <> 0 or n3 <> 0 then
      perform xm_guard.fail('PT500', 'xm_verify_failed', '恢复后的核对没有通过，已全部撤回，云端没有任何改动',
        json_build_object('table', t, 'extra', n1, 'missing', n2, 'stale_epoch', n3)::text);
    end if;
    execute format('select count(*) from public.%I t where t.user_id = $1 and not t.deleted', t) into n1 using uid;
    counts := counts || jsonb_build_object(t, n1);
  end loop;

  -- 5) 整块设置：只合并备份里真实存在的模块，其余模块保留云端原值
  if j.state_patch <> '{}'::jsonb then
    select s.data into old_data from public.xm_state s where s.user_id = uid;
    if found then
      insert into public.xm_restore_archive (job_id, tbl, rkey, row)
      select p_job, 'xm_state', '', to_jsonb(s) from public.xm_state s where s.user_id = uid;
    end if;
    insert into public.xm_state (user_id, data) values (uid, j.state_patch)
    on conflict (user_id) do update set data = coalesce(public.xm_state.data, '{}'::jsonb) || excluded.data;
    select s.data into new_data from public.xm_state s where s.user_id = uid;
    if new_data is distinct from (coalesce(old_data, '{}'::jsonb) || j.state_patch) then
      perform xm_guard.fail('PT500', 'xm_verify_failed', '恢复后的核对没有通过，已全部撤回，云端没有任何改动',
        json_build_object('table', 'xm_state')::text);
    end if;
  end if;

  -- 6) 完成
  res := jsonb_build_object('job', p_job, 'state', 'applied', 'epoch', ne, 'counts', counts,
                            'state_modules', j.scope -> 'state_modules');
  update public.xm_restore_job
     set state = 'applied', applied_epoch = ne, applied_at = now(), result = res
   where job_id = p_job;
  delete from public.xm_restore_stage where job_id = p_job;
  return res;
end;
$$;

-- 取消：只能取消还没应用的任务；暂存区一并清空（它从来没有碰过正式表）
create or replace function public.xm_restore_cancel(p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := xm_guard.me();
  j   public.xm_restore_job;
begin
  j := xm_guard.my_job(p_job, uid);
  if j.state = 'applied' then
    perform xm_guard.fail('PT409', 'xm_bad_state', '这个恢复已经生效，不能取消');
  end if;
  if j.state <> 'cancelled' then
    update public.xm_restore_job set state = 'cancelled', cancelled_at = now() where job_id = p_job;
    delete from public.xm_restore_stage where job_id = p_job;
  end if;
  return jsonb_build_object('job', p_job, 'state', 'cancelled');
end;
$$;

-- RPC 权限：只给已登录用户；Supabase 默认会把 public 里的函数授权给 anon，这里显式收回
revoke all on function public.xm_restore_create(uuid, jsonb)          from public, anon, service_role;
revoke all on function public.xm_restore_stage(uuid, text, jsonb)     from public, anon, service_role;
revoke all on function public.xm_restore_seal(uuid, jsonb, jsonb)     from public, anon, service_role;
revoke all on function public.xm_restore_apply(uuid, integer)         from public, anon, service_role;
revoke all on function public.xm_restore_cancel(uuid)                 from public, anon, service_role;
grant execute on function public.xm_restore_create(uuid, jsonb)       to authenticated;
grant execute on function public.xm_restore_stage(uuid, text, jsonb)  to authenticated;
grant execute on function public.xm_restore_seal(uuid, jsonb, jsonb)  to authenticated;
grant execute on function public.xm_restore_apply(uuid, integer)      to authenticated;
grant execute on function public.xm_restore_cancel(uuid)              to authenticated;

commit;
