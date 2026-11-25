-- Saved AI monthly briefings.
--
-- The Monthly intelligence page asks for insights every time it opens. Instead
-- of calling Gemini each time, the edge function saves each briefing here and
-- returns the saved copy:
--   * past months: generated once, kept (their figures no longer change);
--   * the current month: refreshed at most once every 24 hours.
-- One row per organization, month and set of shops in the report.

create table if not exists public.monthly_insight_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  report_month text not null check (report_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  shop_key text not null,
  insights text not null check (length(insights) between 1 and 8000),
  generated_by uuid not null,
  generated_at timestamptz not null default now(),
  unique (organization_id, report_month, shop_key)
);

alter table public.monthly_insight_reports enable row level security;
revoke all on public.monthly_insight_reports from public, anon, authenticated;
grant select on public.monthly_insight_reports to authenticated;

drop policy if exists monthly_insight_reports_admin_read on public.monthly_insight_reports;
create policy monthly_insight_reports_admin_read on public.monthly_insight_reports
  for select to authenticated
  using (organization_id = public.my_organization_id() and public.current_user_is_admin());

-- Checks the caller is an active admin and every shop is in their
-- organization. Returns the organization and a stable key for the shop set.
create or replace function public.insight_report_scope(p_shop_ids uuid[], out organization_id uuid, out shop_key text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  select sh.organization_id into organization_id
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = auth.uid()
     and s.is_active
     and s.role = 'admin';
  if organization_id is null then
    raise exception 'Administrator access is required for organization report insights.' using errcode = 'P0001';
  end if;

  if coalesce(cardinality(p_shop_ids), 0) = 0 or exists (
    select 1 from unnest(p_shop_ids) as requested(id)
     where not exists (select 1 from public.shops where shops.id = requested.id and shops.organization_id = insight_report_scope.organization_id)
  ) then
    raise exception 'The report includes a shop outside your organization.' using errcode = 'P0001';
  end if;

  select string_agg(distinct ids.id::text, ',' order by ids.id::text) into shop_key from unnest(p_shop_ids) as ids(id);
end;
$$;

-- Returns the saved briefing if it is still fresh, otherwise no row.
create or replace function public.get_monthly_insight(p_month text, p_shop_ids uuid[])
returns table (insights text, generated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope record;
  v_current_month text := to_char(now() at time zone 'Africa/Nairobi', 'YYYY-MM');
begin
  select * into v_scope from public.insight_report_scope(p_shop_ids);
  return query
  select r.insights, r.generated_at
    from public.monthly_insight_reports r
   where r.organization_id = v_scope.organization_id
     and r.report_month = p_month
     and r.shop_key = v_scope.shop_key
     and (p_month < v_current_month or r.generated_at > now() - interval '24 hours');
end;
$$;

create or replace function public.save_monthly_insight(p_month text, p_shop_ids uuid[], p_insights text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope record;
  v_generated_at timestamptz;
begin
  select * into v_scope from public.insight_report_scope(p_shop_ids);
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a valid report month.' using errcode = 'P0001';
  end if;

  insert into public.monthly_insight_reports (organization_id, report_month, shop_key, insights, generated_by)
  values (v_scope.organization_id, p_month, v_scope.shop_key, left(p_insights, 8000), auth.uid())
  on conflict (organization_id, report_month, shop_key) do update
    set insights = excluded.insights,
        generated_by = excluded.generated_by,
        generated_at = now()
  returning monthly_insight_reports.generated_at into v_generated_at;
  return v_generated_at;
end;
$$;

revoke all on function public.insight_report_scope(uuid[]) from public, anon, authenticated;
revoke all on function public.get_monthly_insight(text, uuid[]) from public, anon;
grant execute on function public.get_monthly_insight(text, uuid[]) to authenticated;
revoke all on function public.save_monthly_insight(text, uuid[], text) from public, anon;
grant execute on function public.save_monthly_insight(text, uuid[], text) to authenticated;

notify pgrst, 'reload schema';