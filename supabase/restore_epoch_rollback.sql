-- =====================================================================
-- 晓米记账 · 撤销 restore_epoch.sql（H3 恢复协议）
--
-- !!! 尚未批准在生产执行。只允许在隔离的测试数据库里运行（tests/db）。
--
-- 两种情况，脚本自动判断：
--   A. 从没有任何账本应用过恢复（所有 epoch = 0，且没有 applied 任务）：
--      完整删除本迁移新增的全部对象，回到迁移前的结构。
--   B. 已有账本应用过恢复：拒绝完整回滚。只撤销恢复 RPC 的执行权限（停止新的恢复），
--      保留写入保护触发器、xm_meta、epoch 列和存档——否则旧版客户端会重新获得写入能力，
--      把恢复前的旧账单写回去。
-- 判断和删除在同一个事务里，并先锁住 xm_meta，防止判断之后有人完成恢复。
-- =====================================================================

begin;

lock table public.xm_meta in exclusive mode;          -- 挡住正在进行的 apply（FOR UPDATE）和写入检查（FOR SHARE）
lock table public.xm_restore_job in exclusive mode;

do $$
declare
  used boolean;
  t    text;
begin
  used := exists (select 1 from public.xm_meta where epoch > 0)
       or exists (select 1 from public.xm_restore_job where state = 'applied');

  if used then
    raise notice '已有账本应用过恢复：只停用新的恢复，保留写入保护（触发器、xm_meta、epoch 列、存档都不删除）';
    revoke execute on function public.xm_restore_create(uuid, jsonb)         from authenticated;
    revoke execute on function public.xm_restore_stage(uuid, text, jsonb)    from authenticated;
    revoke execute on function public.xm_restore_seal(uuid, jsonb, jsonb)    from authenticated;
    revoke execute on function public.xm_restore_apply(uuid, integer)        from authenticated;
    revoke execute on function public.xm_restore_cancel(uuid)                from authenticated;
    return;
  end if;

  raise notice '恢复协议从未被使用：完整删除';
  foreach t in array array['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats', 'xm_state'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
  end loop;
  drop function if exists public.xm_restore_create(uuid, jsonb);
  drop function if exists public.xm_restore_stage(uuid, text, jsonb);
  drop function if exists public.xm_restore_seal(uuid, jsonb, jsonb);
  drop function if exists public.xm_restore_apply(uuid, integer);
  drop function if exists public.xm_restore_cancel(uuid);
  drop schema if exists xm_guard cascade;            -- 内部函数依赖任务表的行类型，先删函数再删表
  drop table if exists public.xm_restore_archive;
  drop table if exists public.xm_restore_stage;
  drop table if exists public.xm_restore_job;
  drop table if exists public.xm_meta;
  foreach t in array array['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats', 'xm_state'] loop
    execute format('alter table public.%I drop column if exists epoch', t);
  end loop;
end;
$$;

commit;
