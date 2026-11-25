-- Shop management: admins add shops to their own organization and edit shop
-- details, including the legal details printed on receipts.
--
-- Shop writes go through create_shop / update_shop_details only (validated and
-- audited). The old direct UPDATE grant on shops(name, theme_color) is removed.

alter table public.shops
  add column if not exists email text,
  add column if not exists kra_pin text,
  add column if not exists ppb_licence_no text,
  add column if not exists receipt_footer text;

alter table public.shops add constraint shops_name_present check (length(trim(name)) >= 2);
alter table public.shops add constraint shops_theme_color_format check (theme_color is null or theme_color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.shops add constraint shops_kra_pin_format check (kra_pin is null or kra_pin ~ '^[AP][0-9]{9}[A-Z]$');

create unique index if not exists shops_org_name_unique
  on public.shops (organization_id, lower(trim(name)));

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table if not exists public.shop_audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.shops(id),
  actor_auth_user_id uuid not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_shop_audit_org on public.shop_audit_log (organization_id, created_at desc);

alter table public.shop_audit_log enable row level security;
revoke all on public.shop_audit_log from public, anon, authenticated;
grant select on public.shop_audit_log to authenticated;

drop policy if exists shop_audit_admin_read on public.shop_audit_log;
create policy shop_audit_admin_read on public.shop_audit_log
  for select to authenticated
  using (organization_id = public.my_organization_id() and public.current_user_is_admin());

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.shop_admin_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select sh.organization_id into v_org
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = auth.uid()
     and s.is_active
     and s.role = 'admin';

  if v_org is null then
    raise exception 'Only an active administrator can manage shops.' using errcode = 'P0001';
  end if;
  return v_org;
end;
$$;

-- Validates and normalises shop details. Returns them cleaned up as jsonb.
create or replace function public.shop_clean_details(
  p_name text,
  p_location text,
  p_phone text,
  p_email text,
  p_kra_pin text,
  p_ppb_licence_no text,
  p_receipt_footer text,
  p_theme_color text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_location text := nullif(trim(coalesce(p_location, '')), '');
  v_phone text := nullif(regexp_replace(trim(coalesce(p_phone, '')), '\s+', ' ', 'g'), '');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_kra text := nullif(upper(regexp_replace(coalesce(p_kra_pin, ''), '\s', '', 'g')), '');
  v_ppb text := nullif(trim(coalesce(p_ppb_licence_no, '')), '');
  v_footer text := nullif(trim(coalesce(p_receipt_footer, '')), '');
  v_color text := nullif(trim(coalesce(p_theme_color, '')), '');
begin
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'Enter a shop name (2 to 80 characters).' using errcode = 'P0001';
  end if;
  if v_location is not null and length(v_location) > 160 then
    raise exception 'The location is too long (160 characters at most).' using errcode = 'P0001';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,20}$' then
    raise exception 'Enter a valid phone number, for example 0712 345 678.' using errcode = 'P0001';
  end if;
  if v_email is not null and (v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(v_email) > 254) then
    raise exception 'Enter a valid email address.' using errcode = 'P0001';
  end if;
  if v_kra is not null and v_kra !~ '^[AP][0-9]{9}[A-Z]$' then
    raise exception 'A KRA PIN is 11 characters, for example P051234567X.' using errcode = 'P0001';
  end if;
  if v_ppb is not null and length(v_ppb) > 40 then
    raise exception 'The PPB licence number is too long.' using errcode = 'P0001';
  end if;
  if v_footer is not null and length(v_footer) > 200 then
    raise exception 'The receipt footer is too long (200 characters at most).' using errcode = 'P0001';
  end if;
  if v_color is not null and v_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Choose a valid brand colour.' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'name', v_name, 'location', v_location, 'phone', v_phone, 'email', v_email,
    'kra_pin', v_kra, 'ppb_licence_no', v_ppb, 'receipt_footer', v_footer,
    'theme_color', lower(v_color)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Create a shop in the caller's organization.
-- ---------------------------------------------------------------------------
create or replace function public.create_shop(
  p_name text,
  p_location text default null,
  p_phone text default null,
  p_email text default null,
  p_kra_pin text default null,
  p_ppb_licence_no text default null,
  p_receipt_footer text default null,
  p_theme_color text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.shop_admin_organization();
  v_details jsonb := public.shop_clean_details(p_name, p_location, p_phone, p_email, p_kra_pin, p_ppb_licence_no, p_receipt_footer, p_theme_color);
  v_shop_id uuid;
begin
  -- Plan limits (max_shops) plug in here later.

  if exists (
    select 1 from public.shops
     where organization_id = v_org and lower(trim(name)) = lower(v_details->>'name')
  ) then
    raise exception 'You already have a shop called %.', v_details->>'name' using errcode = 'P0001';
  end if;

  insert into public.shops (organization_id, name, location, phone, email, kra_pin, ppb_licence_no, receipt_footer, theme_color)
  values (
    v_org,
    v_details->>'name', v_details->>'location', v_details->>'phone', v_details->>'email',
    v_details->>'kra_pin', v_details->>'ppb_licence_no', v_details->>'receipt_footer',
    coalesce(v_details->>'theme_color',
      (select theme_color from public.shops where organization_id = v_org and theme_color is not null order by created_at limit 1))
  )
  returning id into v_shop_id;

  insert into public.shop_audit_log (organization_id, shop_id, actor_auth_user_id, action, details)
  values (v_org, v_shop_id, auth.uid(), 'created', v_details);

  return v_shop_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edit any shop in the caller's organization.
-- ---------------------------------------------------------------------------
create or replace function public.update_shop_details(
  p_shop_id uuid,
  p_name text,
  p_location text default null,
  p_phone text default null,
  p_email text default null,
  p_kra_pin text default null,
  p_ppb_licence_no text default null,
  p_receipt_footer text default null,
  p_theme_color text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.shop_admin_organization();
  v_details jsonb := public.shop_clean_details(p_name, p_location, p_phone, p_email, p_kra_pin, p_ppb_licence_no, p_receipt_footer, p_theme_color);
  v_before public.shops;
begin
  select * into v_before from public.shops
   where id = p_shop_id and organization_id = v_org
   for update;
  if v_before.id is null then
    raise exception 'Shop not found in your organization.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.shops
     where organization_id = v_org and id <> p_shop_id and lower(trim(name)) = lower(v_details->>'name')
  ) then
    raise exception 'You already have another shop called %.', v_details->>'name' using errcode = 'P0001';
  end if;

  update public.shops
     set name = v_details->>'name',
         location = v_details->>'location',
         phone = v_details->>'phone',
         email = v_details->>'email',
         kra_pin = v_details->>'kra_pin',
         ppb_licence_no = v_details->>'ppb_licence_no',
         receipt_footer = v_details->>'receipt_footer',
         theme_color = coalesce(v_details->>'theme_color', theme_color)
   where id = p_shop_id;

  insert into public.shop_audit_log (organization_id, shop_id, actor_auth_user_id, action, details)
  values (v_org, p_shop_id, auth.uid(), 'updated', jsonb_build_object(
    'before', jsonb_build_object('name', v_before.name, 'location', v_before.location, 'phone', v_before.phone,
      'email', v_before.email, 'kra_pin', v_before.kra_pin, 'ppb_licence_no', v_before.ppb_licence_no,
      'receipt_footer', v_before.receipt_footer, 'theme_color', v_before.theme_color),
    'after', v_details));
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions: shops are now changed only through the functions above.
-- ---------------------------------------------------------------------------
revoke update on public.shops from authenticated;
drop policy if exists org_admin_can_update_shops on public.shops;

revoke all on function public.shop_admin_organization() from public, anon, authenticated;
revoke all on function public.shop_clean_details(text, text, text, text, text, text, text, text) from public, anon, authenticated;

revoke all on function public.create_shop(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_shop(text, text, text, text, text, text, text, text) to authenticated;

revoke all on function public.update_shop_details(uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_shop_details(uuid, text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';