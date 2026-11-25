-- Receipt printing: each shop has a default paper width for its receipt
-- printers. Individual devices can override it locally (saved in the browser).
--   58mm / 80mm = thermal roll printers, a4 = ordinary office printer.

alter table public.shops
  add column if not exists receipt_paper_width text not null default '80mm';

alter table public.shops add constraint shops_receipt_paper_width_check
  check (receipt_paper_width in ('58mm', '80mm', 'a4'));

-- Recreate the shop functions with the extra setting. The old signatures are
-- dropped so there is exactly one version of each.
drop function if exists public.create_shop(text, text, text, text, text, text, text, text);
drop function if exists public.update_shop_details(uuid, text, text, text, text, text, text, text, text);

create or replace function public.shop_clean_paper_width(p_width text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_width text := lower(trim(coalesce(p_width, '')));
begin
  if v_width = '' then return null; end if;
  if v_width not in ('58mm', '80mm', 'a4') then
    raise exception 'Choose a receipt paper width: 58mm, 80mm or A4.' using errcode = 'P0001';
  end if;
  return v_width;
end;
$$;

create or replace function public.create_shop(
  p_name text,
  p_location text default null,
  p_phone text default null,
  p_email text default null,
  p_kra_pin text default null,
  p_ppb_licence_no text default null,
  p_receipt_footer text default null,
  p_theme_color text default null,
  p_receipt_paper_width text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.shop_admin_organization();
  v_details jsonb := public.shop_clean_details(p_name, p_location, p_phone, p_email, p_kra_pin, p_ppb_licence_no, p_receipt_footer, p_theme_color);
  v_width text := public.shop_clean_paper_width(p_receipt_paper_width);
  v_shop_id uuid;
begin
  -- Plan limits (max_shops) plug in here later.

  if exists (
    select 1 from public.shops
     where organization_id = v_org and lower(trim(name)) = lower(v_details->>'name')
  ) then
    raise exception 'You already have a shop called %.', v_details->>'name' using errcode = 'P0001';
  end if;

  insert into public.shops (organization_id, name, location, phone, email, kra_pin, ppb_licence_no, receipt_footer, theme_color, receipt_paper_width)
  values (
    v_org,
    v_details->>'name', v_details->>'location', v_details->>'phone', v_details->>'email',
    v_details->>'kra_pin', v_details->>'ppb_licence_no', v_details->>'receipt_footer',
    coalesce(v_details->>'theme_color',
      (select theme_color from public.shops where organization_id = v_org and theme_color is not null order by created_at limit 1)),
    coalesce(v_width, '80mm')
  )
  returning id into v_shop_id;

  insert into public.shop_audit_log (organization_id, shop_id, actor_auth_user_id, action, details)
  values (v_org, v_shop_id, auth.uid(), 'created', v_details || jsonb_build_object('receipt_paper_width', coalesce(v_width, '80mm')));

  return v_shop_id;
end;
$$;

create or replace function public.update_shop_details(
  p_shop_id uuid,
  p_name text,
  p_location text default null,
  p_phone text default null,
  p_email text default null,
  p_kra_pin text default null,
  p_ppb_licence_no text default null,
  p_receipt_footer text default null,
  p_theme_color text default null,
  p_receipt_paper_width text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.shop_admin_organization();
  v_details jsonb := public.shop_clean_details(p_name, p_location, p_phone, p_email, p_kra_pin, p_ppb_licence_no, p_receipt_footer, p_theme_color);
  v_width text := public.shop_clean_paper_width(p_receipt_paper_width);
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
         theme_color = coalesce(v_details->>'theme_color', theme_color),
         receipt_paper_width = coalesce(v_width, receipt_paper_width)
   where id = p_shop_id;

  insert into public.shop_audit_log (organization_id, shop_id, actor_auth_user_id, action, details)
  values (v_org, p_shop_id, auth.uid(), 'updated', jsonb_build_object(
    'before', jsonb_build_object('name', v_before.name, 'location', v_before.location, 'phone', v_before.phone,
      'email', v_before.email, 'kra_pin', v_before.kra_pin, 'ppb_licence_no', v_before.ppb_licence_no,
      'receipt_footer', v_before.receipt_footer, 'theme_color', v_before.theme_color,
      'receipt_paper_width', v_before.receipt_paper_width),
    'after', v_details || jsonb_build_object('receipt_paper_width', coalesce(v_width, v_before.receipt_paper_width))));
end;
$$;

revoke all on function public.shop_clean_paper_width(text) from public, anon, authenticated;

revoke all on function public.create_shop(text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_shop(text, text, text, text, text, text, text, text, text) to authenticated;

revoke all on function public.update_shop_details(uuid, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_shop_details(uuid, text, text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';