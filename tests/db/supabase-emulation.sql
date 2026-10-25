-- 测试用：在普通 PostgreSQL 里模拟 Supabase 与本项目相关的部分
--   角色：anon / authenticated / service_role / authenticator（PostgREST 用它登录再切换角色）
--   auth schema：auth.users、auth.uid()、auth.role()、auth.jwt()（与 Supabase 的定义一致：读取 PostgREST 设置的 request.jwt.claims）
--   默认权限：Supabase 会把 public 里新建的表、函数、序列全部授权给 anon / authenticated / service_role，
--            这里照样设置，用来检验迁移脚本有没有把不该给的权限收回。
-- 只在测试数据库里运行。

create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

grant usage on schema auth to xm_owner;
grant select, references on auth.users to xm_owner;   -- 业务表的外键指向 auth.users

grant usage on schema public to anon, authenticated, service_role;
-- xm_owner 相当于 Supabase 的 postgres 角色：不是超级用户、可以绕过 RLS、拥有所有业务对象
alter default privileges for role xm_owner in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role xm_owner in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role xm_owner in schema public grant all on sequences to anon, authenticated, service_role;
