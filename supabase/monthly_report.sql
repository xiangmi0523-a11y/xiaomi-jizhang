-- =====================================================================
-- 晓米记账 · 每月自动账单复盘（全部在 Supabase 里运行）
--   每月 1 号 00:00 UTC（北京时间 08:00）：pg_cron 调用 private.xm_monthly_report()
--   → 统计上个月的账单 → 生成分析总结 → 通过 pg_net 调 Notion API，在「月度账单复盘」页下面新建一页
-- Notion 令牌存在 Supabase Vault（名字 xm_notion_token），不写在代码里。
-- private schema 不对外暴露（PostgREST 只开放 public），未登录 / 登录用户都调用不到这些函数。
-- 可以重复执行。
-- =====================================================================
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.xm_report_cfg (
  id            int primary key default 1 check (id = 1),
  owner_email   text not null,
  notion_parent text not null,          -- Notion「月度账单复盘」页面 id
  enabled       boolean not null default true
);
create table if not exists private.xm_report_log (
  id         bigserial primary key,
  month      date,
  request_id bigint,
  note       text,
  created_at timestamptz not null default now()
);

-- ---------- 小工具 ----------
create or replace function private.xm_yuan(c bigint) returns text language sql immutable set search_path = '' as
$$ select '¥' || to_char(coalesce(c, 0) / 100.0, 'FM999,999,990.00') $$;
create or replace function private.xm_md(d date) returns text language sql immutable set search_path = '' as
$$ select to_char(d, 'FMMM"月"FMDD"日"') $$;
create or replace function private.xm_rt(t text, bold boolean default false) returns jsonb language sql immutable set search_path = '' as
$$ select jsonb_build_array(jsonb_build_object('type', 'text', 'text', jsonb_build_object('content', left(coalesce(t, ''), 1900)),
                                              'annotations', jsonb_build_object('bold', bold))) $$;
create or replace function private.xm_blk(kind text, t text) returns jsonb language sql immutable set search_path = '' as
$$ select jsonb_build_object('object', 'block', 'type', kind, kind, jsonb_build_object('rich_text', private.xm_rt(t))) $$;
create or replace function private.xm_todo(t text) returns jsonb language sql immutable set search_path = '' as
$$ select jsonb_build_object('object', 'block', 'type', 'to_do', 'to_do', jsonb_build_object('rich_text', private.xm_rt(t), 'checked', false)) $$;
-- 表格：rows 是 text[][]，第一行是表头
create or replace function private.xm_table(rows jsonb) returns jsonb language sql immutable set search_path = '' as
$$ select jsonb_build_object('object', 'block', 'type', 'table', 'table', jsonb_build_object(
     'table_width', jsonb_array_length(rows -> 0), 'has_column_header', true, 'has_row_header', false,
     'children', (select jsonb_agg(jsonb_build_object('type', 'table_row', 'table_row', jsonb_build_object('cells',
                    (select jsonb_agg(private.xm_rt(c #>> '{}') order by i) from jsonb_array_elements(r) with ordinality as x(c, i))))
                  order by n)
                  from jsonb_array_elements(rows) with ordinality as y(r, n)))) $$;

-- ---------- 统计某个用户某个月的账单 ----------
create or replace function private.xm_month_stats(p_uid uuid, p_month date)
returns jsonb language sql stable set search_path = '' as $$
  with m as (select date_trunc('month', p_month)::date as a, (date_trunc('month', p_month) + interval '1 month')::date as b),
  e as (
    select r.*, coalesce(c.name, '未分类') as cat_name, coalesce(ac.name, '') as acc_name
    from public.xm_records r
    left join public.xm_categories c on c.user_id = r.user_id and c.id = r.cat
    left join public.xm_accounts ac on ac.user_id = r.user_id and ac.id = r.acc
    , m
    where r.user_id = p_uid and not r.deleted and r.type = 'expense' and r.date >= m.a and r.date < m.b
  )
  select jsonb_build_object(
    'month', (select a from m),
    'days_in_month', (select extract(day from (b - 1))::int from m),
    'total', coalesce((select sum(amount) from e), 0),
    'count', (select count(*) from e),
    'days', (select count(distinct date) from e),
    'first_day', (select min(date) from e),
    'top', coalesce((select jsonb_agg(t) from (select amount, cat_name, acc_name, date, note from e order by amount desc, ts asc limit 3) t), '[]'),
    'cats', coalesce((select jsonb_agg(t) from (select cat_name as name, sum(amount) as sum, count(*) as n from e group by cat_name order by 2 desc) t), '[]'),
    'income', coalesce((select sum(amount) from public.xm_records r, m where r.user_id = p_uid and not r.deleted and r.type = 'income' and r.date >= m.a and r.date < m.b), 0),
    'prev_total', coalesce((select sum(amount) from public.xm_records r, m where r.user_id = p_uid and not r.deleted and r.type = 'expense'
                              and r.date >= (m.a - interval '1 month')::date and r.date < m.a), 0),
    'budget', coalesce((select (s.data -> 'budget' ->> 'total')::bigint from public.xm_state s where s.user_id = p_uid), 0)
  )
$$;

-- ---------- 生成复盘并写进 Notion ----------
-- p_month：要复盘的月份（任意一天都行），默认上个月（北京时间）；p_dry = true 时只返回内容、不发给 Notion
create or replace function private.xm_monthly_report(p_month date default null, p_dry boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cfg private.xm_report_cfg;
  uid uuid; m date; s jsonb; title text; tok text; req bigint;
  total bigint; cnt int; days int; dim int; budget bigint; prev bigint; income bigint;
  top jsonb; topc jsonb; freq jsonb;
  pct numeric; bullets text[] := '{}'; todos text[] := '{}'; kids jsonb := '[]'; rows jsonb; payload jsonb;
begin
  select * into cfg from private.xm_report_cfg where id = 1;
  if cfg is null or not cfg.enabled then return jsonb_build_object('skipped', 'disabled'); end if;
  select id into uid from auth.users where lower(email) = lower(cfg.owner_email) limit 1;
  if uid is null then return jsonb_build_object('skipped', 'no user'); end if;
  m := coalesce(date_trunc('month', p_month)::date, (date_trunc('month', now() at time zone 'Asia/Shanghai') - interval '1 month')::date);
  s := private.xm_month_stats(uid, m);
  total := (s ->> 'total')::bigint; cnt := (s ->> 'count')::int; days := (s ->> 'days')::int; dim := (s ->> 'days_in_month')::int;
  budget := (s ->> 'budget')::bigint; prev := (s ->> 'prev_total')::bigint; income := (s ->> 'income')::bigint;
  top := s -> 'top' -> 0; topc := s -> 'cats' -> 0;
  title := '晓米记账 · ' || to_char(m, 'YYYY"年"FMMM"月"') || '账单复盘';

  kids := kids || jsonb_build_object('object', 'block', 'type', 'callout', 'callout', jsonb_build_object(
    'rich_text', private.xm_rt('由晓米记账在 ' || to_char(now() at time zone 'Asia/Shanghai', 'YYYY"年"FMMM"月"FMDD"日" HH24:MI') ||
                 ' 自动生成，数据来自云端账本（' || private.xm_md(m) || ' ~ ' || private.xm_md((m + interval '1 month' - interval '1 day')::date) || '）。'),
    'icon', jsonb_build_object('type', 'emoji', 'emoji', '📊'), 'color', 'yellow_background'));

  if cnt = 0 then
    kids := kids || private.xm_blk('paragraph', '这个月还没有记过支出。下个月记得每花一笔就记一笔，猫咪们会陪着你～');
  else
    -- 核心数字
    kids := kids || private.xm_blk('heading_2', '核心数字');
    rows := jsonb_build_array(jsonb_build_array('项目', '数值'),
      jsonb_build_array('本月支出总额', private.xm_yuan(total) || '（' || cnt || ' 笔）'),
      jsonb_build_array('最大单笔开销', private.xm_yuan((top ->> 'amount')::bigint) || ' · ' || (top ->> 'cat_name') ||
                        case when top ->> 'acc_name' <> '' then ' · ' || (top ->> 'acc_name') else '' end || ' · ' || private.xm_md((top ->> 'date')::date) ||
                        case when coalesce(top ->> 'note', '') <> '' then '「' || (top ->> 'note') || '」' else '（未写备注）' end),
      jsonb_build_array('日均支出', private.xm_yuan(round(total::numeric / greatest(days, 1))::bigint) || '（按记了账的 ' || days || ' 天）'),
      jsonb_build_array('本月收入', private.xm_yuan(income)));
    if budget > 0 then
      rows := rows || jsonb_build_array(jsonb_build_array('月预算 ' || private.xm_yuan(budget) || ' 已用', round(total * 100.0 / budget, 1) || '%'));
    end if;
    if prev > 0 then
      rows := rows || jsonb_build_array(jsonb_build_array('上个月支出', private.xm_yuan(prev)));
    end if;
    kids := kids || private.xm_table(rows);

    -- 支出构成
    kids := kids || private.xm_blk('heading_2', '支出构成');
    rows := jsonb_build_array(jsonb_build_array('分类', '金额', '笔数', '占比')) ||
      coalesce((select jsonb_agg(jsonb_build_array(c ->> 'name', private.xm_yuan((c ->> 'sum')::bigint), c ->> 'n',
                                                   round((c ->> 'sum')::numeric * 100 / total, 1) || '%'))
                from jsonb_array_elements(s -> 'cats') c), '[]');
    kids := kids || private.xm_table(rows);

    -- 分析总结（按规则生成）
    if budget > 0 then
      pct := round(total * 100.0 / budget, 1);
      bullets := bullets || case
        when pct <= 80 then '整体可控：花了 ' || private.xm_yuan(total) || '，只用掉月预算的 ' || pct || '%，节奏是安全的。'
        when pct <= 100 then '有点紧张：花了 ' || private.xm_yuan(total) || '，已经用掉月预算的 ' || pct || '%，离超支不远了。'
        else '超支了：花了 ' || private.xm_yuan(total) || '，比月预算多了 ' || private.xm_yuan(total - budget) || '（' || pct || '%）。' end;
    else
      bullets := bullets || ('本月一共花了 ' || private.xm_yuan(total) || '。还没设月预算，建议在晓米记账里设一个，超支时猫咪会提醒你。');
    end if;
    bullets := bullets || ('钱主要花在「' || (topc ->> 'name') || '」：' || private.xm_yuan((topc ->> 'sum')::bigint) || '，占 ' ||
                           round((topc ->> 'sum')::numeric * 100 / total) || '%，一共 ' || (topc ->> 'n') || ' 笔。');
    bullets := bullets || ('最大的一笔是 ' || private.xm_md((top ->> 'date')::date) || '的' || (top ->> 'cat_name') || ' ' ||
                           private.xm_yuan((top ->> 'amount')::bigint) || '，占总支出的 ' || round((top ->> 'amount')::numeric * 100 / total) || '%' ||
                           case when coalesce(top ->> 'note', '') = '' then '，而且没写备注，复盘时可以补上。' else '。' end);
    -- 小额高频：笔数 ≥ 4、平均每笔 < ¥20 的「非必需」分类（吃饭、买菜、交通这类日常开销不算）
    select c into freq from jsonb_array_elements(s -> 'cats') c
      where (c ->> 'n')::int >= 4 and (c ->> 'sum')::numeric / (c ->> 'n')::int < 2000
        and (c ->> 'name') <> all (array['餐饮', '买菜', '交通', '打车', '房租', '水电燃气', '通讯', '医疗', '居家', '日用', '学习', '未分类'])
      order by (c ->> 'n')::int desc limit 1;
    if freq is not null then
      bullets := bullets || ('「' || (freq ->> 'name') || '」是小额高频：' || (freq ->> 'n') || ' 笔一共 ' || private.xm_yuan((freq ->> 'sum')::bigint) ||
                             '，平均每笔 ' || private.xm_yuan(round((freq ->> 'sum')::numeric / (freq ->> 'n')::int)::bigint) || '，这种最容易不知不觉累积。');
    end if;
    if prev > 0 then
      bullets := bullets || ('和上个月（' || private.xm_yuan(prev) || '）相比' ||
        case when total > prev then '多花了 ' || private.xm_yuan(total - prev) || '（+' || round((total - prev) * 100.0 / prev) || '%）。'
             when total < prev then '少花了 ' || private.xm_yuan(prev - total) || '（-' || round((prev - total) * 100.0 / prev) || '%），继续保持！'
             else '基本持平。' end);
    end if;
    if days < dim and (s ->> 'first_day')::date > m then
      bullets := bullets || ('这个月是从 ' || private.xm_md((s ->> 'first_day')::date) || ' 开始记账的，只有 ' || days || ' 天有记录，数字会比整月偏少。');
    end if;
    if income > 0 then
      bullets := bullets || ('本月收入 ' || private.xm_yuan(income) || '，收支相抵' ||
                             case when income >= total then '结余 ' || private.xm_yuan(income - total) || '。' else '超出 ' || private.xm_yuan(total - income) || '。' end);
    end if;
    kids := kids || private.xm_blk('heading_2', '分析总结');
    kids := kids || coalesce((select jsonb_agg(private.xm_blk('bulleted_list_item', b) order by i) from unnest(bullets) with ordinality as u(b, i)), '[]');

    -- 复盘待办
    if coalesce(top ->> 'note', '') = '' then
      todos := todos || ('给 ' || private.xm_md((top ->> 'date')::date) || ' ' || private.xm_yuan((top ->> 'amount')::bigint) || ' 的' || (top ->> 'cat_name') || '补上备注');
    end if;
    todos := todos || '核对支付宝 / 微信账单，看看有没有漏记的消费'::text;
    if freq is not null then
      todos := todos || ('下个月少买点「' || (freq ->> 'name') || '」，试试每周不超过 ' ||
                         greatest(1, round((freq ->> 'n')::numeric * 7 / greatest(days, 7) * 2 / 3))::int || ' 次');
    end if;
    todos := todos || (case when budget > 0 then '看看下个月的预算 ' || private.xm_yuan(budget) || ' 要不要调整' else '在晓米记账里给下个月设一个预算' end);
    kids := kids || private.xm_blk('heading_2', '复盘待办');
    kids := kids || (select jsonb_agg(private.xm_todo(t) order by i) from unnest(todos) with ordinality as u(t, i));
  end if;

  payload := jsonb_build_object(
    'parent', jsonb_build_object('page_id', cfg.notion_parent),
    'icon', jsonb_build_object('type', 'emoji', 'emoji', '🐱'),
    'properties', jsonb_build_object('title', jsonb_build_object('title', private.xm_rt(title))),
    'children', kids);
  if p_dry then return jsonb_build_object('stats', s, 'payload', payload); end if;

  select decrypted_secret into tok from vault.decrypted_secrets where name = 'xm_notion_token' limit 1;
  if tok is null then
    insert into private.xm_report_log (month, note) values (m, '缺少 Notion 令牌（vault: xm_notion_token）');
    return jsonb_build_object('skipped', 'no notion token');
  end if;
  req := net.http_post(
    url := 'https://api.notion.com/v1/pages',
    body := payload,
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Notion-Version', '2022-06-28', 'Content-Type', 'application/json'),
    timeout_milliseconds := 30000);
  insert into private.xm_report_log (month, request_id, note) values (m, req, title);
  return jsonb_build_object('request_id', req, 'title', title);
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------- 定时：每月 1 号 00:00 UTC = 北京时间 08:00 ----------
select cron.unschedule(jobid) from cron.job where jobname = 'xm-monthly-report';
select cron.schedule('xm-monthly-report', '0 0 1 * *', $cron$ select private.xm_monthly_report(); $cron$);
