-- Barcode scanning: map product barcodes to drugs, per organization.
--
-- A barcode identifies a product (drug + pack), never a batch, so one drug can
-- have several barcodes (pack sizes, manufacturers). Each organization keeps its
-- own list, so a wrong link made by one pharmacy cannot affect another.
-- Writes go through link_drug_barcode / unlink_drug_barcode only.

-- ---------------------------------------------------------------------------
-- Normalisation and check-digit validation (mirrored in src/lib/barcode.js).
-- ---------------------------------------------------------------------------
create or replace function public.normalize_barcode(p_code text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_code text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');
  v_sum integer := 0;
  v_digit integer;
  v_len integer;
  i integer;
begin
  if v_code !~ '^[0-9A-Za-z.\-]{4,48}$' then
    return null;
  end if;

  if v_code ~ '^[0-9]+$' then
    v_len := length(v_code);
    -- UPC-A (12 digits) is the same product as its EAN-13 form with a leading 0.
    if v_len = 12 then
      v_code := '0' || v_code;
      v_len := 13;
    end if;
    -- GTIN-8/13/14 carry a check digit: reject misreads.
    if v_len in (8, 13, 14) then
      for i in 1..(v_len - 1) loop
        v_digit := substr(v_code, v_len - i, 1)::integer;
        v_sum := v_sum + v_digit * (case when i % 2 = 1 then 3 else 1 end);
      end loop;
      if (10 - v_sum % 10) % 10 <> substr(v_code, v_len, 1)::integer then
        return null;
      end if;
    end if;
  end if;

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.drug_barcodes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  barcode text not null,
  drug_id uuid not null references public.drugs(id),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint drug_barcodes_normalized check (barcode = public.normalize_barcode(barcode))
);
create unique index if not exists drug_barcodes_org_barcode_key on public.drug_barcodes (organization_id, barcode);
create index if not exists drug_barcodes_drug_idx on public.drug_barcodes (drug_id);

alter table public.drug_barcodes enable row level security;
revoke all on public.drug_barcodes from public, anon, authenticated;
grant select on public.drug_barcodes to authenticated;

drop policy if exists drug_barcodes_org_read on public.drug_barcodes;
create policy drug_barcodes_org_read on public.drug_barcodes
  for select to authenticated
  using (organization_id = public.my_organization_id());

create table if not exists public.drug_barcode_audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id),
  barcode text not null,
  drug_id uuid not null,
  action text not null check (action in ('linked', 'unlinked')),
  actor_auth_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table public.drug_barcode_audit_log enable row level security;
revoke all on public.drug_barcode_audit_log from public, anon, authenticated;
grant select on public.drug_barcode_audit_log to authenticated;

drop policy if exists drug_barcode_audit_admin_read on public.drug_barcode_audit_log;
create policy drug_barcode_audit_admin_read on public.drug_barcode_audit_log
  for select to authenticated
  using (organization_id = public.my_organization_id() and public.current_user_is_admin());

-- Pharmacists, managers and admins may manage barcodes; returns their organization.
create or replace function public.barcode_manager_organization()
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
     and s.role in ('admin', 'pharmacist', 'manager');

  if v_org is null then
    raise exception 'Only a pharmacist or administrator can link barcodes.' using errcode = 'P0001';
  end if;
  return v_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Link a barcode to a drug.
-- ---------------------------------------------------------------------------
create or replace function public.link_drug_barcode(p_barcode text, p_drug_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.barcode_manager_organization();
  v_code text := public.normalize_barcode(p_barcode);
  v_existing public.drug_barcodes;
  v_existing_name text;
  v_id uuid;
begin
  if v_code is null then
    raise exception 'That barcode did not scan correctly. Scan it again.' using errcode = 'P0001';
  end if;

  -- The drug must be in the shared catalogue or private to a shop in this organization.
  if not exists (
    select 1 from public.drugs d
     where d.id = p_drug_id
       and (d.owner_shop_id is null
            or d.owner_shop_id in (select id from public.shops where organization_id = v_org))
  ) then
    raise exception 'Drug not found.' using errcode = 'P0001';
  end if;

  select * into v_existing from public.drug_barcodes
   where organization_id = v_org and barcode = v_code
   for update;

  if v_existing.id is not null then
    if v_existing.drug_id = p_drug_id then
      return v_existing.id;  -- already linked: nothing to do
    end if;
    select name into v_existing_name from public.drugs where id = v_existing.drug_id;
    raise exception 'This barcode is already linked to %. Remove that link first if it is wrong.', coalesce(v_existing_name, 'another drug')
      using errcode = 'P0001';
  end if;

  insert into public.drug_barcodes (organization_id, barcode, drug_id)
  values (v_org, v_code, p_drug_id)
  returning id into v_id;

  insert into public.drug_barcode_audit_log (organization_id, barcode, drug_id, action, actor_auth_user_id)
  values (v_org, v_code, p_drug_id, 'linked', auth.uid());

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove a wrong link.
-- ---------------------------------------------------------------------------
create or replace function public.unlink_drug_barcode(p_barcode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.barcode_manager_organization();
  v_code text := public.normalize_barcode(p_barcode);
  v_existing public.drug_barcodes;
begin
  delete from public.drug_barcodes
   where organization_id = v_org and barcode = coalesce(v_code, p_barcode)
  returning * into v_existing;

  if v_existing.id is null then
    raise exception 'That barcode is not linked to any drug.' using errcode = 'P0001';
  end if;

  insert into public.drug_barcode_audit_log (organization_id, barcode, drug_id, action, actor_auth_user_id)
  values (v_org, v_existing.barcode, v_existing.drug_id, 'unlinked', auth.uid());
end;
$$;

revoke all on function public.barcode_manager_organization() from public, anon, authenticated;

revoke all on function public.normalize_barcode(text) from public, anon;
grant execute on function public.normalize_barcode(text) to authenticated;

revoke all on function public.link_drug_barcode(text, uuid) from public, anon;
grant execute on function public.link_drug_barcode(text, uuid) to authenticated;

revoke all on function public.unlink_drug_barcode(text) from public, anon;
grant execute on function public.unlink_drug_barcode(text) to authenticated;

-- Make the table available to PowerSync (the publication already carries the other synced tables).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'powersync')
     and not exists (select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'drug_barcodes') then
    execute 'alter publication powersync add table public.drug_barcodes';
  end if;
end $$;

notify pgrst, 'reload schema';