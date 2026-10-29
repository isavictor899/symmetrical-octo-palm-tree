-- Quantity-based medical equipment supplies, kept separate from the drug
-- catalog and sale batches.
create table if not exists public.equipment_supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  unit text not null default 'piece',
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists equipment_supplies_identity_idx
  on public.equipment_supplies (lower(name), lower(category), lower(unit));

create table if not exists public.shop_equipment_stock (
  shop_id uuid not null references public.shops(id) on delete cascade,
  equipment_supply_id uuid not null references public.equipment_supplies(id) on delete restrict,
  quantity_on_hand integer not null default 0 check (quantity_on_hand >= 0),
  average_cost numeric(12, 2) not null default 0 check (average_cost >= 0),
  updated_at timestamptz not null default now(),
  primary key (shop_id, equipment_supply_id)
);

create table if not exists public.equipment_supply_receipts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  equipment_supply_id uuid not null references public.equipment_supplies(id) on delete restrict,
  supplier_name text,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  note text,
  received_by uuid not null references auth.users(id),
  received_at timestamptz not null default now()
);

alter table public.equipment_supplies enable row level security;
alter table public.shop_equipment_stock enable row level security;
alter table public.equipment_supply_receipts enable row level security;
grant select on public.equipment_supplies, public.shop_equipment_stock to authenticated;

drop policy if exists "Authenticated users can read equipment supplies" on public.equipment_supplies;
create policy "Authenticated users can read equipment supplies"
  on public.equipment_supplies for select to authenticated using (true);

drop policy if exists "Staff can read equipment stock in their organization" on public.shop_equipment_stock;
create policy "Staff can read equipment stock in their organization"
  on public.shop_equipment_stock for select to authenticated
  using (
    exists (
      select 1
      from public.staff s
      join public.shops own_shop on own_shop.id = s.shop_id
      join public.shops target_shop on target_shop.id = shop_equipment_stock.shop_id
      where s.auth_user_id = auth.uid()
        and (
          s.shop_id = shop_equipment_stock.shop_id
          or (
            lower(coalesce(s.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
            and target_shop.organization_id = own_shop.organization_id
          )
        )
    )
  );

create or replace function public.create_equipment_supply(
  p_name text,
  p_category text,
  p_unit text default 'piece',
  p_description text default null
)
returns public.equipment_supplies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_item public.equipment_supplies;
begin
  select lower(coalesce(role, '')) into v_role
  from public.staff where auth_user_id = auth.uid();
  if v_role is null then raise exception 'A staff account is required.'; end if;
  if v_role <> 'pharmacist' and v_role not in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
    raise exception 'Only pharmacists and administrators can add equipment supplies.';
  end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_category), '') is null or nullif(trim(p_unit), '') is null then
    raise exception 'Name, category, and unit are required.';
  end if;

  insert into public.equipment_supplies (name, category, unit, description, created_by)
  values (trim(p_name), trim(p_category), trim(p_unit), nullif(trim(coalesce(p_description, '')), ''), auth.uid())
  on conflict ((lower(name)), (lower(category)), (lower(unit))) do update
    set description = coalesce(equipment_supplies.description, excluded.description)
  returning * into v_item;
  return v_item;
end;
$$;

create or replace function public.receive_equipment_supply(
  p_shop_id uuid,
  p_equipment_supply_id uuid,
  p_quantity integer,
  p_unit_cost numeric,
  p_supplier_name text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_own_org uuid;
  v_target_org uuid;
  v_receipt_id uuid := gen_random_uuid();
begin
  select * into v_staff from public.staff where auth_user_id = auth.uid();
  if v_staff.id is null then raise exception 'A staff account is required.'; end if;
  if lower(coalesce(v_staff.role, '')) <> 'pharmacist'
     and lower(coalesce(v_staff.role, '')) not in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
    raise exception 'Only pharmacists and administrators can receive equipment supplies.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'Enter a positive quantity and a non-negative unit cost.';
  end if;
  if not exists (select 1 from public.equipment_supplies where id = p_equipment_supply_id) then
    raise exception 'The equipment supply was not found.';
  end if;

  if v_staff.shop_id = p_shop_id then
    null;
  elsif lower(coalesce(v_staff.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
    select organization_id into v_own_org from public.shops where id = v_staff.shop_id;
    select organization_id into v_target_org from public.shops where id = p_shop_id;
    if v_own_org is null or v_target_org is distinct from v_own_org then
      raise exception 'You cannot receive stock for this shop.';
    end if;
  else
    raise exception 'You cannot receive stock for this shop.';
  end if;

  insert into public.equipment_supply_receipts
    (id, shop_id, equipment_supply_id, supplier_name, quantity, unit_cost, note, received_by)
  values
    (v_receipt_id, p_shop_id, p_equipment_supply_id, nullif(trim(coalesce(p_supplier_name, '')), ''), p_quantity, p_unit_cost, nullif(trim(coalesce(p_note, '')), ''), auth.uid());

  insert into public.shop_equipment_stock (shop_id, equipment_supply_id, quantity_on_hand, average_cost, updated_at)
  values (p_shop_id, p_equipment_supply_id, p_quantity, p_unit_cost, now())
  on conflict (shop_id, equipment_supply_id) do update
    set average_cost = case
          when shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand = 0 then 0
          else ((shop_equipment_stock.quantity_on_hand * shop_equipment_stock.average_cost)
              + (excluded.quantity_on_hand * excluded.average_cost))
               / (shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand)
        end,
        quantity_on_hand = shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand,
        updated_at = now();
  return v_receipt_id;
end;
$$;

revoke all on function public.create_equipment_supply(text, text, text, text) from public;
revoke all on function public.receive_equipment_supply(uuid, uuid, integer, numeric, text, text) from public;
grant execute on function public.create_equipment_supply(text, text, text, text) to authenticated;
grant execute on function public.receive_equipment_supply(uuid, uuid, integer, numeric, text, text) to authenticated;
