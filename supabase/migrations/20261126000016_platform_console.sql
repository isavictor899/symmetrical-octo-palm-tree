-- Enora Labs platform console: plans, subscriptions and pharmacy management.
--
-- * platform_admins: Enora Labs staff who run the console. Not pharmacy staff.
--   Every console function checks this table on the server; the app's redirect
--   to the console is only convenience.
-- * organizations gain a plan, trial/paid-until dates, suspension and optional
--   custom limits. Access state is worked out from those dates:
--     trial / active -> grace (7 days after expiry, warnings) -> read_only
--     suspended (set by Enora Labs) ; no dates at all = complimentary (active)
-- * read_only and suspended pharmacies cannot record new business (sales,
--   stock movements, expenses, purchase orders, register sessions, equipment
--   receipts). Enforced by triggers, so no write path can skip it. Offline
--   sales rejected for this reason go to Sales review and can be approved after
--   renewal.
-- * Plan limits on shops and active staff, enforced by triggers.
-- * Subscription payments are recorded by hand (M-Pesa / bank) and extend the
--   paid-until date. Private notes and an audit log per pharmacy.
-- * The console shows business numbers only, never customers or prescriptions.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id uuid primary key,
  email text,
  added_at timestamptz not null default now(),
  added_by uuid
);

alter table public.organizations add column if not exists plan text not null default 'basic';
alter table public.organizations add column if not exists trial_ends_at timestamptz;
alter table public.organizations add column if not exists paid_until timestamptz;
alter table public.organizations add column if not exists suspended_at timestamptz;
alter table public.organizations add column if not exists suspended_reason text;
alter table public.organizations add column if not exists max_shops integer;
alter table public.organizations add column if not exists max_staff integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_plan_check') then
    alter table public.organizations add constraint organizations_plan_check check (plan in ('basic', 'pro', 'enterprise'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_limits_check') then
    alter table public.organizations add constraint organizations_limits_check
      check ((max_shops is null or max_shops between 1 and 1000) and (max_staff is null or max_staff between 1 and 10000));
  end if;
end;
$$;

create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  amount numeric not null check (amount > 0 and amount < 100000000),
  method text not null check (method in ('mpesa', 'bank', 'cash', 'other')),
  reference text,
  paid_at timestamptz not null,
  months integer not null check (months between 1 and 36),
  paid_until_before timestamptz,
  paid_until_after timestamptz not null,
  note text,
  recorded_by uuid not null,
  recorded_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text
);
-- The same M-Pesa code or bank reference cannot be recorded twice.
create unique index if not exists subscription_payments_reference_unique
  on public.subscription_payments (method, upper(btrim(reference)))
  where reference is not null and voided_at is null;
create index if not exists subscription_payments_org_idx on public.subscription_payments (organization_id, paid_at desc);

create table if not exists public.platform_org_notes (
  organization_id uuid primary key references public.organizations(id),
  contact_name text,
  contact_phone text,
  contact_email text,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  organization_id uuid references public.organizations(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_audit_log_org_idx on public.platform_audit_log (organization_id, created_at desc);

-- None of these are read directly by the app.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['platform_admins', 'subscription_payments', 'platform_org_notes', 'platform_audit_log'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('comment on table public.%I is %L', v_table,
      'Server-function only: row level security is on with no policies on purpose. Read and write it through the SECURITY DEFINER functions, never directly.');
  end loop;
end;
$$;

-- Existing (test) pharmacies: Pro with a 30-day trial.
update public.organizations
   set plan = 'pro', trial_ends_at = now() + interval '30 days'
 where trial_ends_at is null and paid_until is null and plan = 'basic';

-- ---------------------------------------------------------------------------
-- Access state and limits
-- ---------------------------------------------------------------------------
create or replace function public.subscription_grace_days()
returns integer language sql immutable set search_path = '' as $$ select 7 $$;

create or replace function public.plan_default_limits(p_plan text, out shops integer, out staff integer)
language sql immutable set search_path = '' as $$
  select case p_plan when 'basic' then 1 when 'pro' then 5 else null end,
         case p_plan when 'basic' then 5 when 'pro' then 25 else null end;
$$;

-- The date access runs out (trial or paid, whichever is later), or null when
-- the pharmacy has no billing dates (complimentary).
create or replace function public.organization_expires_at(p_org public.organizations)
returns timestamptz language sql stable set search_path = '' as $$
  select case
    when p_org.trial_ends_at is null and p_org.paid_until is null then null
    else greatest(coalesce(p_org.trial_ends_at, '-infinity'::timestamptz), coalesce(p_org.paid_until, '-infinity'::timestamptz))
  end;
$$;

create or replace function public.organization_access_state(p_org public.organizations)
returns text language sql stable set search_path = '' as $$
  select case
    when p_org.suspended_at is not null then 'suspended'
    when public.organization_expires_at(p_org) is null then 'complimentary'
    when now() <= public.organization_expires_at(p_org) then
      case when p_org.paid_until is not null and now() <= p_org.paid_until then 'active' else 'trial' end
    when now() <= public.organization_expires_at(p_org) + make_interval(days => public.subscription_grace_days()) then 'grace'
    else 'read_only'
  end;
$$;

create or replace function public.organization_limits(p_org public.organizations, out shops integer, out staff integer)
language sql stable set search_path = '' as $$
  select coalesce(p_org.max_shops, (public.plan_default_limits(p_org.plan)).shops),
         coalesce(p_org.max_staff, (public.plan_default_limits(p_org.plan)).staff);
$$;

revoke all on function public.organization_expires_at(public.organizations) from public, anon, authenticated;
revoke all on function public.organization_access_state(public.organizations) from public, anon, authenticated;
revoke all on function public.organization_limits(public.organizations) from public, anon, authenticated;
revoke all on function public.plan_default_limits(text) from public, anon, authenticated;
revoke all on function public.subscription_grace_days() from public, anon, authenticated;

-- Read-only enforcement: new business records are refused once a pharmacy is
-- read_only or suspended.
create or replace function public.assert_shop_writable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_state text;
begin
  select o.* into v_org from public.organizations o join public.shops s on s.organization_id = o.id where s.id = new.shop_id;
  if v_org.id is null then
    return new;
  end if;
  v_state := public.organization_access_state(v_org);
  if v_state = 'suspended' then
    raise exception 'This pharmacy''s account is suspended. Contact Enora Labs on 0771 156 353 or info@enoralabs.co.ke.' using errcode = 'P0001';
  elsif v_state = 'read_only' then
    raise exception 'This pharmacy''s subscription has expired, so the system is read-only. Renew with Enora Labs (0771 156 353) to record new sales and stock.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.assert_shop_writable() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['sales', 'stock_movements', 'finance_entries', 'purchase_orders', 'cash_register_sessions', 'equipment_supply_receipts'] loop
    execute format('drop trigger if exists %I on public.%I', v_table || '_assert_writable', v_table);
    execute format('create trigger %I before insert on public.%I for each row execute function public.assert_shop_writable()', v_table || '_assert_writable', v_table);
  end loop;
end;
$$;

create or replace function public.enforce_shop_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_limit integer;
  v_count integer;
begin
  select * into v_org from public.organizations where id = new.organization_id for update;
  v_limit := (public.organization_limits(v_org)).shops;
  if v_limit is null then return new; end if;
  select count(*) into v_count from public.shops where organization_id = new.organization_id;
  if v_count >= v_limit then
    raise exception 'Your % plan allows % shop%. Contact Enora Labs to upgrade.',
      initcap(v_org.plan), v_limit, case when v_limit = 1 then '' else 's' end using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_shop_limit() from public, anon, authenticated;
drop trigger if exists shops_enforce_limit on public.shops;
create trigger shops_enforce_limit before insert on public.shops for each row execute function public.enforce_shop_limit();

-- Counts active staff; runs when someone is added, reactivated or moved shop.
create or replace function public.enforce_staff_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_limit integer;
  v_count integer;
begin
  if not new.is_active or new.shop_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.is_active and old.shop_id is not distinct from new.shop_id then return new; end if;
  select o.* into v_org from public.organizations o join public.shops s on s.organization_id = o.id where s.id = new.shop_id for update of o;
  v_limit := (public.organization_limits(v_org)).staff;
  if v_limit is null then return new; end if;
  select count(*) into v_count
    from public.staff st join public.shops s on s.id = st.shop_id
   where s.organization_id = v_org.id and st.is_active and st.id <> new.id;
  if v_count >= v_limit then
    raise exception 'Your % plan allows % active staff accounts. Deactivate someone or contact Enora Labs to upgrade.',
      initcap(v_org.plan), v_limit using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_staff_limit() from public, anon, authenticated;
drop trigger if exists staff_enforce_limit on public.staff;
create trigger staff_enforce_limit before insert or update of is_active, shop_id on public.staff
  for each row execute function public.enforce_staff_limit();

-- The signed-in staff member's subscription, for the banner and read-only mode.
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
    'checked_at', now()
  );
end;
$$;
revoke all on function public.get_my_subscription() from public, anon;
grant execute on function public.get_my_subscription() to authenticated;

-- ---------------------------------------------------------------------------
-- Console functions (platform admins only)
-- ---------------------------------------------------------------------------
create or replace function public.platform_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;
revoke all on function public.platform_is_admin() from public, anon;
grant execute on function public.platform_is_admin() to authenticated;

create or replace function public.platform_assert_admin()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.platform_admins where user_id = auth.uid()) then
    raise exception 'Enora Labs platform access is required.' using errcode = 'P0001';
  end if;
  return auth.uid();
end;
$$;
revoke all on function public.platform_assert_admin() from public, anon, authenticated;

create or replace function public.platform_log(p_org uuid, p_action text, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.platform_audit_log (actor, organization_id, action, details) values (auth.uid(), p_org, p_action, coalesce(p_details, '{}'::jsonb));
$$;
revoke all on function public.platform_log(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
begin
  perform public.platform_assert_admin();
  return (
    with orgs as (select o.*, public.organization_access_state(o) as state, public.organization_expires_at(o) as expires from public.organizations o)
    select jsonb_build_object(
      'pharmacies', count(*),
      'active', count(*) filter (where state = 'active'),
      'trial', count(*) filter (where state = 'trial'),
      'complimentary', count(*) filter (where state = 'complimentary'),
      'grace', count(*) filter (where state = 'grace'),
      'read_only', count(*) filter (where state = 'read_only'),
      'suspended', count(*) filter (where state = 'suspended'),
      'expiring_14_days', count(*) filter (where state in ('active', 'trial') and expires <= now() + interval '14 days'),
      'revenue_this_month', (select coalesce(sum(amount), 0) from public.subscription_payments where voided_at is null and paid_at >= v_month_start),
      'revenue_last_12_months', (select coalesce(sum(amount), 0) from public.subscription_payments where voided_at is null and paid_at >= now() - interval '12 months'),
      'shops', (select count(*) from public.shops),
      'active_staff', (select count(*) from public.staff where is_active),
      'sales_today', (select count(*) from public.sales where sold_at >= date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi')
    ) from orgs
  );
end;
$$;
revoke all on function public.platform_overview() from public, anon;
grant execute on function public.platform_overview() to authenticated;

create or replace function public.platform_organizations()
returns table (
  id uuid, name text, plan text, state text, created_at timestamptz,
  trial_ends_at timestamptz, paid_until timestamptz, expires_at timestamptz, suspended_reason text,
  shop_limit integer, staff_limit integer, shops integer, active_staff integer,
  sales_30d integer, sales_total_30d numeric, last_sale_at timestamptz, last_sign_in_at timestamptz,
  held_sales integer, contact_name text, contact_phone text, contact_email text,
  admin_name text, admin_email text, admin_phone text, total_paid numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.platform_assert_admin();
  return query
  select o.id, o.name, o.plan, public.organization_access_state(o), o.created_at,
         o.trial_ends_at, o.paid_until, public.organization_expires_at(o), o.suspended_reason,
         (public.organization_limits(o)).shops, (public.organization_limits(o)).staff,
         (select count(*)::int from public.shops s where s.organization_id = o.id),
         (select count(*)::int from public.staff st join public.shops s on s.id = st.shop_id where s.organization_id = o.id and st.is_active),
         sl.n, sl.total, sl.last_at,
         (select max(u.last_sign_in_at) from public.staff st join public.shops s on s.id = st.shop_id join auth.users u on u.id = st.auth_user_id where s.organization_id = o.id),
         (select count(*)::int from public.held_sales h where h.organization_id = o.id and h.status = 'pending'),
         n.contact_name, n.contact_phone, n.contact_email,
         ad.full_name, ad.email, ad.phone,
         (select coalesce(sum(p.amount), 0) from public.subscription_payments p where p.organization_id = o.id and p.voided_at is null)
    from public.organizations o
    left join public.platform_org_notes n on n.organization_id = o.id
    left join lateral (
      select count(*) filter (where sa.sold_at >= now() - interval '30 days')::int as n,
             coalesce(sum(sa.total_amount) filter (where sa.sold_at >= now() - interval '30 days'), 0) as total,
             max(sa.sold_at) as last_at
        from public.sales sa join public.shops s on s.id = sa.shop_id
       where s.organization_id = o.id
    ) sl on true
    left join lateral (
      select st.full_name, st.email, st.phone
        from public.staff st join public.shops s on s.id = st.shop_id
       where s.organization_id = o.id and st.role = 'admin' and st.is_active
       order by st.created_at limit 1
    ) ad on true
   order by o.created_at desc;
end;
$$;
revoke all on function public.platform_organizations() from public, anon;
grant execute on function public.platform_organizations() to authenticated;

create or replace function public.platform_organization_detail(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.platform_assert_admin();
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'That pharmacy was not found.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'shops', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'location', s.location, 'phone', s.phone, 'created_at', s.created_at,
        'sales_30d', (select count(*) from public.sales sa where sa.shop_id = s.id and sa.sold_at >= now() - interval '30 days'),
        'sales_total_30d', (select coalesce(sum(sa.total_amount), 0) from public.sales sa where sa.shop_id = s.id and sa.sold_at >= now() - interval '30 days'),
        'last_sale_at', (select max(sa.sold_at) from public.sales sa where sa.shop_id = s.id)
      ) order by s.created_at), '[]'::jsonb) from public.shops s where s.organization_id = p_org),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', st.id, 'name', st.full_name, 'role', st.role, 'email', st.email, 'phone', st.phone,
        'shop', s.name, 'is_active', st.is_active, 'last_sign_in_at', u.last_sign_in_at
      ) order by st.is_active desc, st.role, st.full_name), '[]'::jsonb)
      from public.staff st join public.shops s on s.id = st.shop_id
      left join auth.users u on u.id = st.auth_user_id
      where s.organization_id = p_org),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'amount', p.amount, 'method', p.method, 'reference', p.reference, 'paid_at', p.paid_at,
        'months', p.months, 'paid_until_after', p.paid_until_after, 'note', p.note, 'recorded_at', p.recorded_at,
        'voided_at', p.voided_at, 'void_reason', p.void_reason
      ) order by p.paid_at desc), '[]'::jsonb) from public.subscription_payments p where p.organization_id = p_org),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
        'action', a.action, 'details', a.details, 'created_at', a.created_at,
        'actor_email', (select pa.email from public.platform_admins pa where pa.user_id = a.actor)
      ) order by a.created_at desc), '[]'::jsonb)
      from (select * from public.platform_audit_log where organization_id = p_org order by created_at desc limit 100) a),
    'notes', (select to_jsonb(n) - 'organization_id' from public.platform_org_notes n where n.organization_id = p_org)
  );
end;
$$;
revoke all on function public.platform_organization_detail(uuid) from public, anon;
grant execute on function public.platform_organization_detail(uuid) to authenticated;

create or replace function public.platform_set_plan(p_org uuid, p_plan text, p_max_shops integer default null, p_max_staff integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old public.organizations;
begin
  perform public.platform_assert_admin();
  if p_plan not in ('basic', 'pro', 'enterprise') then
    raise exception 'Choose Basic, Pro or Enterprise.' using errcode = 'P0001';
  end if;
  select * into v_old from public.organizations where id = p_org for update;
  if v_old.id is null then raise exception 'That pharmacy was not found.' using errcode = 'P0001'; end if;
  update public.organizations set plan = p_plan, max_shops = p_max_shops, max_staff = p_max_staff where id = p_org;
  perform public.platform_log(p_org, 'plan_changed', jsonb_build_object(
    'from', v_old.plan, 'to', p_plan, 'max_shops', p_max_shops, 'max_staff', p_max_staff));
end;
$$;
revoke all on function public.platform_set_plan(uuid, text, integer, integer) from public, anon;
grant execute on function public.platform_set_plan(uuid, text, integer, integer) to authenticated;

create or replace function public.platform_record_payment(
  p_org uuid, p_amount numeric, p_method text, p_reference text, p_paid_at timestamptz, p_months integer, p_note text default null
)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_org public.organizations;
  v_start timestamptz;
  v_after timestamptz;
begin
  perform public.platform_assert_admin();
  select * into v_org from public.organizations where id = p_org for update;
  if v_org.id is null then raise exception 'That pharmacy was not found.' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid.' using errcode = 'P0001'; end if;
  if p_months is null or p_months not between 1 and 36 then raise exception 'Choose between 1 and 36 months.' using errcode = 'P0001'; end if;
  if p_method not in ('mpesa', 'bank', 'cash', 'other') then raise exception 'Choose how they paid.' using errcode = 'P0001'; end if;
  if p_method in ('mpesa', 'bank') and nullif(btrim(coalesce(p_reference, '')), '') is null then
    raise exception 'Enter the M-Pesa code or bank reference.' using errcode = 'P0001';
  end if;
  if p_paid_at is null or p_paid_at > now() + interval '1 day' then
    raise exception 'Enter the date they paid.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.subscription_payments
              where method = p_method and voided_at is null
                and upper(btrim(reference)) = upper(btrim(p_reference))) then
    raise exception 'A payment with reference % is already recorded.', upper(btrim(p_reference)) using errcode = 'P0001';
  end if;

  -- Paying early extends from the current end date; paying late starts today.
  v_start := greatest(coalesce(v_org.paid_until, now()), now());
  v_after := v_start + make_interval(months => p_months);

  insert into public.subscription_payments (organization_id, amount, method, reference, paid_at, months, paid_until_before, paid_until_after, note, recorded_by)
  values (p_org, round(p_amount, 2), p_method, nullif(upper(btrim(coalesce(p_reference, ''))), ''), p_paid_at, p_months,
          v_org.paid_until, v_after, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  update public.organizations set paid_until = v_after where id = p_org;
  perform public.platform_log(p_org, 'payment_recorded', jsonb_build_object(
    'amount', round(p_amount, 2), 'method', p_method, 'reference', upper(btrim(coalesce(p_reference, ''))), 'months', p_months, 'paid_until', v_after));
  return v_after;
end;
$$;
revoke all on function public.platform_record_payment(uuid, numeric, text, text, timestamptz, integer, text) from public, anon;
grant execute on function public.platform_record_payment(uuid, numeric, text, text, timestamptz, integer, text) to authenticated;

-- A payment recorded by mistake. It stops counting as revenue; the paid-until
-- date goes back to what it was before that payment only if no later payment
-- has been recorded, otherwise correct the date with platform_set_dates.
create or replace function public.platform_void_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_payment public.subscription_payments;
  v_org public.organizations;
begin
  perform public.platform_assert_admin();
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'P0001';
  end if;
  select * into v_payment from public.subscription_payments where id = p_payment_id for update;
  if v_payment.id is null or v_payment.voided_at is not null then
    raise exception 'That payment was not found or is already voided.' using errcode = 'P0001';
  end if;
  select * into v_org from public.organizations where id = v_payment.organization_id for update;
  update public.subscription_payments set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) where id = p_payment_id;
  if v_org.paid_until = v_payment.paid_until_after then
    update public.organizations set paid_until = v_payment.paid_until_before where id = v_org.id;
  end if;
  perform public.platform_log(v_org.id, 'payment_voided', jsonb_build_object(
    'payment_id', p_payment_id, 'amount', v_payment.amount, 'reference', v_payment.reference, 'reason', btrim(p_reason)));
end;
$$;
revoke all on function public.platform_void_payment(uuid, text) from public, anon;
grant execute on function public.platform_void_payment(uuid, text) to authenticated;

create or replace function public.platform_set_dates(p_org uuid, p_trial_ends_at timestamptz, p_paid_until timestamptz, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old public.organizations;
begin
  perform public.platform_assert_admin();
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'P0001';
  end if;
  select * into v_old from public.organizations where id = p_org for update;
  if v_old.id is null then raise exception 'That pharmacy was not found.' using errcode = 'P0001'; end if;
  update public.organizations set trial_ends_at = p_trial_ends_at, paid_until = p_paid_until where id = p_org;
  perform public.platform_log(p_org, 'dates_changed', jsonb_build_object(
    'trial_ends_at', jsonb_build_object('from', v_old.trial_ends_at, 'to', p_trial_ends_at),
    'paid_until', jsonb_build_object('from', v_old.paid_until, 'to', p_paid_until),
    'reason', btrim(p_reason)));
end;
$$;
revoke all on function public.platform_set_dates(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.platform_set_dates(uuid, timestamptz, timestamptz, text) to authenticated;

create or replace function public.platform_set_suspended(p_org uuid, p_suspended boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_assert_admin();
  if p_suspended and length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason of at least 5 characters. The pharmacy sees it.' using errcode = 'P0001';
  end if;
  update public.organizations
     set suspended_at = case when p_suspended then coalesce(suspended_at, now()) else null end,
         suspended_reason = case when p_suspended then btrim(p_reason) else null end
   where id = p_org;
  if not found then raise exception 'That pharmacy was not found.' using errcode = 'P0001'; end if;
  perform public.platform_log(p_org, case when p_suspended then 'suspended' else 'reactivated' end,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$;
revoke all on function public.platform_set_suspended(uuid, boolean, text) from public, anon;
grant execute on function public.platform_set_suspended(uuid, boolean, text) to authenticated;

create or replace function public.platform_save_notes(p_org uuid, p_contact_name text, p_contact_phone text, p_contact_email text, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.platform_assert_admin();
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'That pharmacy was not found.' using errcode = 'P0001';
  end if;
  insert into public.platform_org_notes (organization_id, contact_name, contact_phone, contact_email, notes, updated_at, updated_by)
  values (p_org, nullif(left(btrim(coalesce(p_contact_name, '')), 120), ''), nullif(left(btrim(coalesce(p_contact_phone, '')), 40), ''),
          nullif(left(lower(btrim(coalesce(p_contact_email, ''))), 200), ''), nullif(left(coalesce(p_notes, ''), 10000), ''), now(), auth.uid())
  on conflict (organization_id) do update
    set contact_name = excluded.contact_name, contact_phone = excluded.contact_phone, contact_email = excluded.contact_email,
        notes = excluded.notes, updated_at = now(), updated_by = auth.uid();
  perform public.platform_log(p_org, 'notes_updated', '{}'::jsonb);
end;
$$;
revoke all on function public.platform_save_notes(uuid, text, text, text, text) from public, anon;
grant execute on function public.platform_save_notes(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Onboarding and admin password reset: called by the platform-admin edge
-- function with the service role, after it has checked the caller is a
-- platform admin and created the login.
-- ---------------------------------------------------------------------------
create or replace function public.platform_assert_actor(p_actor uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_actor is null or not exists (select 1 from public.platform_admins where user_id = p_actor) then
    raise exception 'Enora Labs platform access is required.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.platform_assert_actor(uuid) from public, anon, authenticated;

create or replace function public.platform_check_onboard(p_actor uuid, p_org_name text, p_admin_email text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform public.platform_assert_actor(p_actor);
  if length(btrim(coalesce(p_org_name, ''))) < 2 then
    raise exception 'Enter the pharmacy''s name.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.organizations where lower(btrim(name)) = lower(btrim(p_org_name))) then
    raise exception 'A pharmacy called "%" already exists.', btrim(p_org_name) using errcode = 'P0001';
  end if;
  if coalesce(p_admin_email, '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email for the pharmacy''s administrator.' using errcode = 'P0001';
  end if;
  if exists (select 1 from auth.users where lower(email) = lower(btrim(p_admin_email))) then
    raise exception 'That email already has a login. Use a different email.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.platform_check_onboard(uuid, text, text) from public, anon, authenticated;

create or replace function public.platform_onboard(
  p_actor uuid, p_auth_user_id uuid,
  p_org_name text, p_plan text, p_trial_days integer,
  p_shop_name text, p_shop_location text, p_shop_phone text,
  p_admin_name text, p_admin_email text, p_admin_phone text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_org_id uuid;
  v_shop_id uuid;
  v_staff_id uuid;
begin
  -- The login already exists by now, so only the actor and the name are
  -- re-checked here (the email was checked before the login was created).
  perform public.platform_assert_actor(p_actor);
  if p_auth_user_id is null then
    raise exception 'The administrator login was not created.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_org_name, ''))) < 2 then
    raise exception 'Enter the pharmacy''s name.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.organizations where lower(btrim(name)) = lower(btrim(p_org_name))) then
    raise exception 'A pharmacy called "%" already exists.', btrim(p_org_name) using errcode = 'P0001';
  end if;
  if p_plan not in ('basic', 'pro', 'enterprise') then
    raise exception 'Choose Basic, Pro or Enterprise.' using errcode = 'P0001';
  end if;
  if p_trial_days is null or p_trial_days not between 0 and 90 then
    raise exception 'The trial must be between 0 and 90 days.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_shop_name, ''))) < 2 or length(btrim(coalesce(p_admin_name, ''))) < 2 then
    raise exception 'Enter the first shop''s name and the administrator''s full name.' using errcode = 'P0001';
  end if;

  insert into public.organizations (name, plan, trial_ends_at)
  values (btrim(p_org_name), p_plan, now() + make_interval(days => p_trial_days))
  returning id into v_org_id;

  insert into public.shops (organization_id, name, location, phone)
  values (v_org_id, btrim(p_shop_name), nullif(btrim(coalesce(p_shop_location, '')), ''), nullif(btrim(coalesce(p_shop_phone, '')), ''))
  returning id into v_shop_id;

  insert into public.staff (shop_id, full_name, role, auth_user_id, email, phone, is_active, must_change_password)
  values (v_shop_id, btrim(p_admin_name), 'admin', p_auth_user_id, lower(btrim(p_admin_email)),
          nullif(btrim(coalesce(p_admin_phone, '')), ''), true, true)
  returning id into v_staff_id;

  insert into public.platform_org_notes (organization_id, contact_name, contact_phone, contact_email, updated_by)
  values (v_org_id, btrim(p_admin_name), nullif(btrim(coalesce(p_admin_phone, '')), ''), lower(btrim(p_admin_email)), p_actor);

  insert into public.platform_audit_log (actor, organization_id, action, details)
  values (p_actor, v_org_id, 'onboarded', jsonb_build_object('plan', p_plan, 'trial_days', p_trial_days, 'shop', btrim(p_shop_name), 'admin_email', lower(btrim(p_admin_email))));

  return jsonb_build_object('organization_id', v_org_id, 'shop_id', v_shop_id, 'staff_id', v_staff_id);
end;
$$;
revoke all on function public.platform_onboard(uuid, uuid, text, text, integer, text, text, text, text, text, text) from public, anon, authenticated;

-- An active pharmacy admin's login, for a password reset from the console.
create or replace function public.platform_admin_login(p_actor uuid, p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff;
  v_org uuid;
begin
  perform public.platform_assert_actor(p_actor);
  select st.* into v_staff from public.staff st where st.id = p_staff_id;
  if v_staff.id is null or not v_staff.is_active or v_staff.auth_user_id is null or v_staff.role <> 'admin' then
    raise exception 'Only an active pharmacy administrator''s password can be reset from here.' using errcode = 'P0001';
  end if;
  select organization_id into v_org from public.shops where id = v_staff.shop_id;
  update public.staff set must_change_password = true where id = v_staff.id;
  insert into public.platform_audit_log (actor, organization_id, action, details)
  values (p_actor, v_org, 'admin_password_reset', jsonb_build_object('staff', v_staff.full_name, 'email', v_staff.email));
  return jsonb_build_object('auth_user_id', v_staff.auth_user_id, 'name', v_staff.full_name, 'email', v_staff.email);
end;
$$;
revoke all on function public.platform_admin_login(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';