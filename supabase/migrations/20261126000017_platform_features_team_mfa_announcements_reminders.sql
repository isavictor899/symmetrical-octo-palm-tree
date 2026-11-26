-- Platform console, part 2:
--   1. Plan features: what each plan includes, editable from the console, with
--      per-pharmacy overrides. Writes for a feature the pharmacy does not have
--      are refused by the database.
--   2. Announcements shown inside pharmacies' apps.
--   3. Subscription reminders: what is due, and a log of what was sent.
--   4. Console team: owner and support roles.
--   5. MFA: every console function requires a session verified with an
--      authenticator app (aal2).

-- ===========================================================================
-- 4 + 5. Roles and MFA for console functions
-- ===========================================================================
alter table public.platform_admins add column if not exists role text not null default 'owner';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_admins_role_check') then
    alter table public.platform_admins add constraint platform_admins_role_check check (role in ('owner', 'support'));
  end if;
end;
$$;

-- The caller's console role, or an error. Requires an MFA-verified session.
create or replace function public.platform_require(p_min_role text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.platform_admins where user_id = auth.uid();
  if auth.uid() is null or v_role is null then
    raise exception 'Enora Labs platform access is required.' using errcode = 'P0001';
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'Confirm the code from your authenticator app to use the console.' using errcode = 'P0001';
  end if;
  if p_min_role = 'owner' and v_role <> 'owner' then
    raise exception 'Only a console owner can do this.' using errcode = 'P0001';
  end if;
  return auth.uid();
end;
$$;
revoke all on function public.platform_require(text) from public, anon;
grant execute on function public.platform_require(text) to authenticated;

-- Existing console functions: the zero-argument check now means "owner".
create or replace function public.platform_assert_admin()
returns uuid language sql stable security definer set search_path = public as $$
  select public.platform_require('owner');
$$;
revoke all on function public.platform_assert_admin() from public, anon, authenticated;

-- Read-only views and notes are open to support staff too.
do $$
declare
  v_fn record;
  v_def text;
begin
  for v_fn in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname in ('platform_overview', 'platform_organizations', 'platform_organization_detail', 'platform_save_notes')
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    if position('public.platform_assert_admin()' in v_def) = 0 then
      raise exception 'Expected platform_assert_admin() in %', v_fn.proname;
    end if;
    execute replace(v_def, 'public.platform_assert_admin()', 'public.platform_require(''support'')');
  end loop;
end;
$$;

-- Service-role (edge function) checks: the actor's role. MFA is checked by the
-- edge function itself, with the caller's own token, before it calls these.
create or replace function public.platform_assert_actor_role(p_actor uuid, p_min_role text)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
begin
  select role into v_role from public.platform_admins where user_id = p_actor;
  if p_actor is null or v_role is null then
    raise exception 'Enora Labs platform access is required.' using errcode = 'P0001';
  end if;
  if p_min_role = 'owner' and v_role <> 'owner' then
    raise exception 'Only a console owner can do this.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.platform_assert_actor_role(uuid, text) from public, anon, authenticated;

create or replace function public.platform_assert_actor(p_actor uuid)
returns void language sql stable security definer set search_path = public as $$
  select public.platform_assert_actor_role(p_actor, 'owner');
$$;
revoke all on function public.platform_assert_actor(uuid) from public, anon, authenticated;

-- Resetting a locked-out pharmacy owner's password is a support task.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'platform_admin_login';
  if position('public.platform_assert_actor(p_actor)' in v_def) = 0 then
    raise exception 'Expected platform_assert_actor(p_actor) in platform_admin_login';
  end if;
  execute replace(v_def, 'public.platform_assert_actor(p_actor)', 'public.platform_assert_actor_role(p_actor, ''support'')');
end;
$$;

-- Who am I in the console? Works before MFA, so the app knows what to ask for.
create or replace function public.platform_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when pa.user_id is null then null else jsonb_build_object(
    'role', pa.role, 'email', pa.email, 'aal', coalesce(auth.jwt() ->> 'aal', 'aal1')) end
    from (select 1) one left join public.platform_admins pa on pa.user_id = auth.uid();
$$;
revoke all on function public.platform_me() from public, anon;
grant execute on function public.platform_me() to authenticated;

create or replace function public.platform_team()
returns table (user_id uuid, email text, role text, added_at timestamptz, last_sign_in_at timestamptz, mfa_enabled boolean, is_you boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.platform_require('support');
  return query
  select pa.user_id, coalesce(u.email, pa.email)::text, pa.role, pa.added_at, u.last_sign_in_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = pa.user_id and f.status = 'verified'),
         pa.user_id = auth.uid()
    from public.platform_admins pa left join auth.users u on u.id = pa.user_id
   order by pa.role, pa.added_at;
end;
$$;
revoke all on function public.platform_team() from public, anon;
grant execute on function public.platform_team() to authenticated;

create or replace function public.platform_owner_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.platform_admins where role = 'owner';
$$;
revoke all on function public.platform_owner_count() from public, anon, authenticated;

create or replace function public.platform_set_admin_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  perform public.platform_require('owner');
  if p_role not in ('owner', 'support') then raise exception 'Choose owner or support.' using errcode = 'P0001'; end if;
  select role into v_old from public.platform_admins where user_id = p_user for update;
  if v_old is null then raise exception 'That console member was not found.' using errcode = 'P0001'; end if;
  if v_old = 'owner' and p_role <> 'owner' and public.platform_owner_count() <= 1 then
    raise exception 'The console must keep at least one owner.' using errcode = 'P0001';
  end if;
  update public.platform_admins set role = p_role where user_id = p_user;
  perform public.platform_log(null, 'team_role_changed', jsonb_build_object('user_id', p_user, 'from', v_old, 'to', p_role));
end;
$$;
revoke all on function public.platform_set_admin_role(uuid, text) from public, anon;
grant execute on function public.platform_set_admin_role(uuid, text) to authenticated;

create or replace function public.platform_remove_admin(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row public.platform_admins;
begin
  perform public.platform_require('owner');
  select * into v_row from public.platform_admins where user_id = p_user for update;
  if v_row.user_id is null then raise exception 'That console member was not found.' using errcode = 'P0001'; end if;
  if v_row.role = 'owner' and public.platform_owner_count() <= 1 then
    raise exception 'The console must keep at least one owner.' using errcode = 'P0001';
  end if;
  delete from public.platform_admins where user_id = p_user;
  perform public.platform_log(null, 'team_member_removed', jsonb_build_object('user_id', p_user, 'email', v_row.email, 'role', v_row.role));
end;
$$;
revoke all on function public.platform_remove_admin(uuid) from public, anon;
grant execute on function public.platform_remove_admin(uuid) to authenticated;

-- Edge function helpers for adding a console member.
create or replace function public.platform_find_login(p_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
$$;
revoke all on function public.platform_find_login(text) from public, anon, authenticated;

create or replace function public.platform_add_admin(p_actor uuid, p_user uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_assert_actor_role(p_actor, 'owner');
  if p_role not in ('owner', 'support') then raise exception 'Choose owner or support.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'That person is already on the console team.' using errcode = 'P0001';
  end if;
  insert into public.platform_admins (user_id, email, role, added_by) values (p_user, lower(btrim(p_email)), p_role, p_actor);
  insert into public.platform_audit_log (actor, organization_id, action, details)
  values (p_actor, null, 'team_member_added', jsonb_build_object('email', lower(btrim(p_email)), 'role', p_role));
end;
$$;
revoke all on function public.platform_add_admin(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.platform_team_activity()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'action', a.action, 'details', a.details, 'created_at', a.created_at,
      'actor_email', (select pa.email from public.platform_admins pa where pa.user_id = a.actor),
      'organization', (select o.name from public.organizations o where o.id = a.organization_id)
    ) order by a.created_at desc), '[]'::jsonb)
    from (select * from public.platform_audit_log order by created_at desc limit 200) a);
end;
$$;
revoke all on function public.platform_team_activity() from public, anon;
grant execute on function public.platform_team_activity() to authenticated;

-- ===========================================================================
-- 1. Plan features
-- ===========================================================================
create table if not exists public.platform_features (
  key text primary key,
  label text not null,
  description text not null,
  sort_order integer not null default 0
);

create table if not exists public.plan_features (
  plan text not null check (plan in ('basic', 'pro', 'enterprise')),
  feature text not null references public.platform_features(key),
  enabled boolean not null,
  primary key (plan, feature)
);

create table if not exists public.organization_features (
  organization_id uuid not null references public.organizations(id),
  feature text not null references public.platform_features(key),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (organization_id, feature)
);

insert into public.platform_features (key, label, description, sort_order) values
  ('purchase_orders', 'Purchase orders', 'Create purchase orders and receive stock against them.', 10),
  ('finance', 'Expenses & income', 'Record expenses and income, and see all transactions.', 20),
  ('stock_transfers', 'Transfers between shops', 'Move stock from one shop to another.', 30),
  ('ai_insights', 'AI monthly briefings', 'Monthly intelligence page with AI-written briefings.', 40),
  ('advanced_reports', 'Advanced reports', 'Purchase report and profit & loss.', 50)
on conflict (key) do nothing;

insert into public.plan_features (plan, feature, enabled)
select p.plan, f.key, p.plan <> 'basic'
  from (values ('basic'), ('pro'), ('enterprise')) p(plan) cross join public.platform_features f
on conflict (plan, feature) do nothing;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['platform_features', 'plan_features', 'organization_features'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('comment on table public.%I is %L', v_table,
      'Server-function only: row level security is on with no policies on purpose. Read and write it through the SECURITY DEFINER functions, never directly.');
  end loop;
end;
$$;

create or replace function public.organization_has_feature(p_org uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ofe.enabled from public.organization_features ofe where ofe.organization_id = p_org and ofe.feature = p_feature),
    (select pf.enabled from public.plan_features pf join public.organizations o on o.plan = pf.plan where o.id = p_org and pf.feature = p_feature),
    false);
$$;
revoke all on function public.organization_has_feature(uuid, text) from public, anon, authenticated;

create or replace function public.organization_feature_list(p_org uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(f.key order by f.sort_order), '[]'::jsonb)
    from public.platform_features f where public.organization_has_feature(p_org, f.key);
$$;
revoke all on function public.organization_feature_list(uuid) from public, anon, authenticated;

-- Refuses an insert when the shop's pharmacy does not have the feature in
-- TG_ARGV[0]. Attached with WHEN clauses so only the relevant rows are checked.
create or replace function public.assert_shop_feature()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_label text;
begin
  select organization_id into v_org from public.shops where id = new.shop_id;
  if v_org is null or public.organization_has_feature(v_org, tg_argv[0]) then
    return new;
  end if;
  select label into v_label from public.platform_features where key = tg_argv[0];
  raise exception '% is not included in your plan. Contact Enora Labs on 0771 156 353 to upgrade.', coalesce(v_label, tg_argv[0]) using errcode = 'P0001';
end;
$$;
revoke all on function public.assert_shop_feature() from public, anon, authenticated;

drop trigger if exists purchase_orders_feature on public.purchase_orders;
create trigger purchase_orders_feature before insert on public.purchase_orders
  for each row execute function public.assert_shop_feature('purchase_orders');

-- Only manual entries; automatic ones (paid stock receipts, debt payments) are
-- part of core stock and supplier features.
drop trigger if exists finance_entries_feature on public.finance_entries;
create trigger finance_entries_feature before insert on public.finance_entries
  for each row when (new.source_type is null) execute function public.assert_shop_feature('finance');

drop trigger if exists stock_movements_transfer_feature on public.stock_movements;
create trigger stock_movements_transfer_feature before insert on public.stock_movements
  for each row when (new.movement_type = 'transfer_out') execute function public.assert_shop_feature('stock_transfers');

-- AI briefings: insight_report_scope (migration 10) gains the feature check.
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
  if not public.organization_has_feature(organization_id, 'ai_insights') then
    raise exception 'AI monthly briefings are not included in your plan. Contact Enora Labs on 0771 156 353 to upgrade.' using errcode = 'P0001';
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
revoke all on function public.insight_report_scope(uuid[]) from public, anon, authenticated;

-- get_my_subscription (migration 16) also returns the enabled features.
create or replace function public.get_my_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_expires timestamptz;
  v_limits record;
begin
  select o.* into v_org
    from public.staff st join public.shops s on s.id = st.shop_id join public.organizations o on o.id = s.organization_id
   where st.auth_user_id = auth.uid() and st.is_active
   limit 1;
  if v_org.id is null then return null; end if;
  v_expires := public.organization_expires_at(v_org);
  select * into v_limits from public.organization_limits(v_org);
  return jsonb_build_object(
    'plan', v_org.plan,
    'state', public.organization_access_state(v_org),
    'expires_at', v_expires,
    'grace_ends_at', v_expires + make_interval(days => public.subscription_grace_days()),
    'suspended_reason', case when v_org.suspended_at is not null then v_org.suspended_reason end,
    'shop_limit', v_limits.shops,
    'staff_limit', v_limits.staff,
    'shops_used', (select count(*) from public.shops where organization_id = v_org.id),
    'staff_used', (select count(*) from public.staff st join public.shops s on s.id = st.shop_id where s.organization_id = v_org.id and st.is_active),
    'features', public.organization_feature_list(v_org.id),
    'checked_at', now()
  );
end;
$$;
revoke all on function public.get_my_subscription() from public, anon;
grant execute on function public.get_my_subscription() to authenticated;

create or replace function public.platform_feature_matrix()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'key', f.key, 'label', f.label, 'description', f.description,
      'basic', (select enabled from public.plan_features where plan = 'basic' and feature = f.key),
      'pro', (select enabled from public.plan_features where plan = 'pro' and feature = f.key),
      'enterprise', (select enabled from public.plan_features where plan = 'enterprise' and feature = f.key)
    ) order by f.sort_order), '[]'::jsonb) from public.platform_features f);
end;
$$;
revoke all on function public.platform_feature_matrix() from public, anon;
grant execute on function public.platform_feature_matrix() to authenticated;

create or replace function public.platform_set_plan_feature(p_plan text, p_feature text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_require('owner');
  update public.plan_features set enabled = p_enabled where plan = p_plan and feature = p_feature;
  if not found then raise exception 'That plan or feature was not found.' using errcode = 'P0001'; end if;
  perform public.platform_log(null, 'plan_feature_changed', jsonb_build_object('plan', p_plan, 'feature', p_feature, 'enabled', p_enabled));
end;
$$;
revoke all on function public.platform_set_plan_feature(text, text, boolean) from public, anon;
grant execute on function public.platform_set_plan_feature(text, text, boolean) to authenticated;

-- p_enabled null removes the override, so the plan decides again.
create or replace function public.platform_set_org_feature(p_org uuid, p_feature text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_require('owner');
  if not exists (select 1 from public.organizations where id = p_org) or not exists (select 1 from public.platform_features where key = p_feature) then
    raise exception 'That pharmacy or feature was not found.' using errcode = 'P0001';
  end if;
  if p_enabled is null then
    delete from public.organization_features where organization_id = p_org and feature = p_feature;
  else
    insert into public.organization_features (organization_id, feature, enabled, updated_by)
    values (p_org, p_feature, p_enabled, auth.uid())
    on conflict (organization_id, feature) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
  end if;
  perform public.platform_log(p_org, 'feature_override', jsonb_build_object('feature', p_feature, 'enabled', p_enabled));
end;
$$;
revoke all on function public.platform_set_org_feature(uuid, text, boolean) from public, anon;
grant execute on function public.platform_set_org_feature(uuid, text, boolean) to authenticated;

create or replace function public.platform_org_features(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'key', f.key, 'label', f.label,
      'plan_default', (select pf.enabled from public.plan_features pf join public.organizations o on o.plan = pf.plan where o.id = p_org and pf.feature = f.key),
      'override', (select ofe.enabled from public.organization_features ofe where ofe.organization_id = p_org and ofe.feature = f.key),
      'enabled', public.organization_has_feature(p_org, f.key)
    ) order by f.sort_order), '[]'::jsonb) from public.platform_features f);
end;
$$;
revoke all on function public.platform_org_features(uuid) from public, anon;
grant execute on function public.platform_org_features(uuid) to authenticated;

-- ===========================================================================
-- 2. Announcements
-- ===========================================================================
create table if not exists public.platform_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 3 and 120),
  body text not null check (length(btrim(body)) between 3 and 1000),
  level text not null default 'info' check (level in ('info', 'warning', 'critical')),
  audience text not null default 'all' check (audience in ('all', 'admins')),
  organization_id uuid references public.organizations(id),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
alter table public.platform_announcements enable row level security;
revoke all on public.platform_announcements from public, anon, authenticated;
comment on table public.platform_announcements is
  'Server-function only: row level security is on with no policies on purpose. Read and write it through the SECURITY DEFINER functions, never directly.';

create or replace function public.get_my_announcements()
returns table (id uuid, title text, body text, level text, starts_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_admin boolean;
begin
  select s.organization_id, st.role = 'admin' into v_org, v_admin
    from public.staff st join public.shops s on s.id = st.shop_id
   where st.auth_user_id = auth.uid() and st.is_active limit 1;
  if v_org is null then return; end if;
  return query
  select a.id, a.title, a.body, a.level, a.starts_at
    from public.platform_announcements a
   where a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
     and (a.organization_id is null or a.organization_id = v_org)
     and (a.audience = 'all' or v_admin)
   order by case a.level when 'critical' then 0 when 'warning' then 1 else 2 end, a.starts_at desc
   limit 5;
end;
$$;
revoke all on function public.get_my_announcements() from public, anon;
grant execute on function public.get_my_announcements() to authenticated;

create or replace function public.platform_announcements_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'body', a.body, 'level', a.level, 'audience', a.audience,
      'organization_id', a.organization_id, 'organization', o.name,
      'starts_at', a.starts_at, 'ends_at', a.ends_at, 'created_at', a.created_at,
      'status', case when a.starts_at > now() then 'scheduled' when a.ends_at is not null and a.ends_at <= now() then 'ended' else 'live' end
    ) order by a.starts_at desc), '[]'::jsonb)
    from public.platform_announcements a left join public.organizations o on o.id = a.organization_id);
end;
$$;
revoke all on function public.platform_announcements_list() from public, anon;
grant execute on function public.platform_announcements_list() to authenticated;

create or replace function public.platform_save_announcement(
  p_id uuid, p_title text, p_body text, p_level text, p_audience text, p_org uuid, p_starts_at timestamptz, p_ends_at timestamptz
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform public.platform_require('owner');
  if p_org is not null and not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'That pharmacy was not found.' using errcode = 'P0001';
  end if;
  if p_ends_at is not null and p_ends_at <= coalesce(p_starts_at, now()) then
    raise exception 'The end time must be after the start time.' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.platform_announcements (title, body, level, audience, organization_id, starts_at, ends_at, created_by)
    values (btrim(p_title), btrim(p_body), p_level, p_audience, p_org, coalesce(p_starts_at, now()), p_ends_at, auth.uid())
    returning id into v_id;
  else
    update public.platform_announcements
       set title = btrim(p_title), body = btrim(p_body), level = p_level, audience = p_audience, organization_id = p_org,
           starts_at = coalesce(p_starts_at, starts_at), ends_at = p_ends_at, updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'That announcement was not found.' using errcode = 'P0001'; end if;
  end if;
  perform public.platform_log(p_org, 'announcement_saved', jsonb_build_object('title', btrim(p_title), 'level', p_level));
  return v_id;
end;
$$;
revoke all on function public.platform_save_announcement(uuid, text, text, text, text, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.platform_save_announcement(uuid, text, text, text, text, uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.platform_end_announcement(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_require('owner');
  update public.platform_announcements set ends_at = now(), updated_at = now()
   where id = p_id and (ends_at is null or ends_at > now());
  if not found then raise exception 'That announcement is not live.' using errcode = 'P0001'; end if;
  perform public.platform_log(null, 'announcement_ended', jsonb_build_object('id', p_id));
end;
$$;
revoke all on function public.platform_end_announcement(uuid) from public, anon;
grant execute on function public.platform_end_announcement(uuid) to authenticated;

-- ===========================================================================
-- 3. Subscription reminders
-- ===========================================================================
create table if not exists public.subscription_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  kind text not null check (kind in ('expires_in_7', 'expires_in_1', 'expired', 'read_only_soon', 'read_only')),
  expires_at timestamptz not null,
  channel text not null check (channel in ('sms', 'email', 'whatsapp_manual')),
  recipient text,
  status text not null check (status in ('sent', 'failed')),
  error text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists subscription_reminders_sent_once
  on public.subscription_reminders (organization_id, kind, expires_at, channel) where status = 'sent';
create index if not exists subscription_reminders_org_idx on public.subscription_reminders (organization_id, created_at desc);
alter table public.subscription_reminders enable row level security;
revoke all on public.subscription_reminders from public, anon, authenticated;
comment on table public.subscription_reminders is
  'Server-function only: row level security is on with no policies on purpose. Read and write it through the SECURITY DEFINER functions, never directly.';

-- Reminders due now that have not been sent on any channel. Windows are wide
-- enough that a missed daily run still catches up, and each reminder goes out
-- once per expiry date.
create or replace function public.subscription_reminders_due()
returns table (
  organization_id uuid, name text, plan text, kind text, expires_at timestamptz,
  contact_name text, phone text, email text, message text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with orgs as (
    select o.id, o.name, o.plan, public.organization_expires_at(o) as exp, public.organization_access_state(o) as state
      from public.organizations o
     where o.suspended_at is null
  ), due as (
    select orgs.*, case
      when now() >= exp - interval '7 days' and now() < exp - interval '2 days' then 'expires_in_7'
      when now() >= exp - interval '1 day' and now() < exp then 'expires_in_1'
      when now() >= exp and now() < exp + interval '5 days' then 'expired'
      when now() >= exp + interval '5 days' and now() < exp + interval '7 days' then 'read_only_soon'
      when now() >= exp + interval '7 days' and now() < exp + interval '14 days' then 'read_only'
    end as kind
    from orgs where exp is not null
  )
  select d.id, d.name, d.plan, d.kind, d.exp,
         coalesce(n.contact_name, ad.full_name),
         coalesce(n.contact_phone, ad.phone),
         coalesce(n.contact_email, ad.email),
         'Enora Labs: ' || case d.kind
           when 'expires_in_7' then 'Your Pharmacy POS subscription for ' || d.name || ' ends on ' || to_char(d.exp at time zone 'Africa/Nairobi', 'FMDD Mon YYYY') || '. Renew to keep recording sales.'
           when 'expires_in_1' then 'Your Pharmacy POS subscription for ' || d.name || ' ends tomorrow. Renew today to avoid interruption.'
           when 'expired' then 'Your Pharmacy POS subscription for ' || d.name || ' has ended. It keeps working until ' || to_char((d.exp + interval '7 days') at time zone 'Africa/Nairobi', 'FMDD Mon') || ', then becomes read-only.'
           when 'read_only_soon' then 'Pharmacy POS for ' || d.name || ' becomes read-only on ' || to_char((d.exp + interval '7 days') at time zone 'Africa/Nairobi', 'FMDD Mon') || '. Renew now to keep selling.'
           else 'Pharmacy POS for ' || d.name || ' is now read-only. Your records are safe. Renew to record sales again.'
         end || ' Call/WhatsApp 0771 156 353.'
    from due d
    left join public.platform_org_notes n on n.organization_id = d.id
    left join lateral (
      select st.full_name, st.phone, st.email from public.staff st join public.shops s on s.id = st.shop_id
       where s.organization_id = d.id and st.role = 'admin' and st.is_active order by st.created_at limit 1
    ) ad on true
   where d.kind is not null
     and not exists (select 1 from public.subscription_reminders r
                      where r.organization_id = d.id and r.kind = d.kind and r.expires_at = d.exp and r.status = 'sent')
   order by d.exp;
end;
$$;
revoke all on function public.subscription_reminders_due() from public, anon, authenticated;

create or replace function public.record_subscription_reminder(
  p_org uuid, p_kind text, p_expires_at timestamptz, p_channel text, p_recipient text, p_status text, p_error text, p_actor uuid default null
)
returns void language sql security definer set search_path = public as $$
  insert into public.subscription_reminders (organization_id, kind, expires_at, channel, recipient, status, error, created_by)
  values (p_org, p_kind, p_expires_at, p_channel, left(p_recipient, 200), p_status, left(p_error, 500), p_actor)
  on conflict do nothing;
$$;
revoke all on function public.record_subscription_reminder(uuid, text, timestamptz, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.platform_reminders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  return jsonb_build_object(
    'due', (select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) from public.subscription_reminders_due() d),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'organization', o.name, 'kind', r.kind, 'channel', r.channel, 'recipient', r.recipient,
        'status', r.status, 'error', r.error, 'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from (select * from public.subscription_reminders order by created_at desc limit 100) r
      join public.organizations o on o.id = r.organization_id)
  );
end;
$$;
revoke all on function public.platform_reminders() from public, anon;
grant execute on function public.platform_reminders() to authenticated;

-- Sent by hand (WhatsApp) from the console.
create or replace function public.platform_mark_reminder_sent(p_org uuid, p_kind text, p_expires_at timestamptz, p_recipient text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_require('support');
  perform public.record_subscription_reminder(p_org, p_kind, p_expires_at, 'whatsapp_manual', p_recipient, 'sent', null, auth.uid());
end;
$$;
revoke all on function public.platform_mark_reminder_sent(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.platform_mark_reminder_sent(uuid, text, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';