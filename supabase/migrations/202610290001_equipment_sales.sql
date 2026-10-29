-- Equipment prices and sales use side tables and RPCs. The existing drug
-- sale_items table, sell_stock function, and its batch trigger are untouched.

alter table public.shop_equipment_stock
  add column if not exists selling_price numeric not null default 0
  check (selling_price >= 0);

create table if not exists public.equipment_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  equipment_supply_id uuid not null references public.equipment_supplies(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  subtotal numeric generated always as (quantity * unit_price) stored,
  created_at timestamptz not null default now()
);
create index if not exists equipment_sale_items_sale_id_idx on public.equipment_sale_items(sale_id);
alter table public.equipment_sale_items enable row level security;
drop policy if exists equipment_sale_items_org_read on public.equipment_sale_items;
create policy equipment_sale_items_org_read on public.equipment_sale_items for select to authenticated using (
  exists (
    select 1 from public.sales s
    join public.staff viewer on viewer.auth_user_id = auth.uid()
    join public.shops sale_shop on sale_shop.id = s.shop_id
    join public.shops viewer_shop on viewer_shop.id = viewer.shop_id
    where s.id = equipment_sale_items.sale_id
      and (s.shop_id = viewer.shop_id or (
        lower(coalesce(viewer.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
        and sale_shop.organization_id = viewer_shop.organization_id
      ))
  )
);
grant select on public.equipment_sale_items to authenticated;

-- Priced receiving overload; the original six-argument RPC remains intact.
create or replace function public.receive_equipment_supply(
  p_shop_id uuid,
  p_equipment_supply_id uuid,
  p_quantity integer,
  p_unit_cost numeric,
  p_selling_price numeric,
  p_supplier_name text default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public
as $function$
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
  if p_quantity is null or p_quantity < 1 or p_unit_cost is null or p_unit_cost < 0
     or p_selling_price is null or p_selling_price <= 0 then
    raise exception 'Enter a positive quantity, non-negative unit cost, and positive selling price.';
  end if;
  if not exists (select 1 from public.equipment_supplies where id = p_equipment_supply_id) then
    raise exception 'The equipment supply was not found.';
  end if;
  if v_staff.shop_id <> p_shop_id then
    if lower(coalesce(v_staff.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
      select organization_id into v_own_org from public.shops where id = v_staff.shop_id;
      select organization_id into v_target_org from public.shops where id = p_shop_id;
      if v_own_org is null or v_target_org is distinct from v_own_org then raise exception 'You cannot receive stock for this shop.'; end if;
    else
      raise exception 'You cannot receive stock for this shop.';
    end if;
  end if;
  insert into public.equipment_supply_receipts
    (id, shop_id, equipment_supply_id, supplier_name, quantity, unit_cost, note, received_by)
  values (v_receipt_id, p_shop_id, p_equipment_supply_id,
    nullif(trim(coalesce(p_supplier_name, '')), ''), p_quantity, p_unit_cost,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid());
  insert into public.shop_equipment_stock
    (shop_id, equipment_supply_id, quantity_on_hand, average_cost, selling_price, updated_at)
  values (p_shop_id, p_equipment_supply_id, p_quantity, p_unit_cost, p_selling_price, now())
  on conflict (shop_id, equipment_supply_id) do update
    set average_cost = case
          when shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand = 0 then 0
          else ((shop_equipment_stock.quantity_on_hand * shop_equipment_stock.average_cost)
              + (excluded.quantity_on_hand * excluded.average_cost))
               / (shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand)
        end,
        quantity_on_hand = shop_equipment_stock.quantity_on_hand + excluded.quantity_on_hand,
        selling_price = excluded.selling_price,
        updated_at = now();
  return v_receipt_id;
end;
$function$;

create or replace function public.sell_stock_and_equipment(
  p_shop_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_client_sale_id uuid default null,
  p_prescription_reference text default null,
  p_prescriber_name text default null,
  p_prescription_date date default null
) returns uuid
language plpgsql security definer set search_path = public
as $function$
declare
  v_sale_id uuid;
  v_staff_id uuid;
  v_drug_items jsonb := '[]'::jsonb;
  v_equipment_item jsonb;
  v_equipment_count integer := 0;
  v_equipment_id uuid;
  v_quantity integer;
  v_on_hand integer;
  v_price numeric;
  v_equipment_total numeric := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must include at least one item';
  end if;
  select id into v_staff_id from public.staff where auth_user_id = auth.uid() and shop_id = p_shop_id;
  if v_staff_id is null then raise exception 'You are not permitted to record a sale for this shop'; end if;
  if p_client_sale_id is not null then
    select id into v_sale_id from public.sales where shop_id = p_shop_id and client_sale_id = p_client_sale_id;
    if v_sale_id is not null then return v_sale_id; end if;
  end if;
  select coalesce(jsonb_agg(x.item), '[]'::jsonb) into v_drug_items
    from jsonb_array_elements(p_items) as x(item)
    where coalesce(x.item->>'item_type', 'drug') = 'drug';
  select count(*) into v_equipment_count from jsonb_array_elements(p_items) as x(item)
    where x.item->>'item_type' = 'equipment';
  if jsonb_array_length(v_drug_items) + v_equipment_count <> jsonb_array_length(p_items) then
    raise exception 'Sale contains an unsupported item type';
  end if;
  if jsonb_array_length(v_drug_items) > 0 then
    v_sale_id := public.sell_stock(p_shop_id, p_payment_method, v_drug_items, p_client_sale_id,
      p_prescription_reference, p_prescriber_name, p_prescription_date);
  else
    insert into public.sales (shop_id, staff_id, payment_method, total_amount, client_sale_id)
      values (p_shop_id, v_staff_id, p_payment_method, 0, p_client_sale_id) returning id into v_sale_id;
  end if;
  for v_equipment_item in select x.item from jsonb_array_elements(p_items) as x(item)
    where x.item->>'item_type' = 'equipment'
  loop
    v_equipment_id := (v_equipment_item->>'equipment_supply_id')::uuid;
    v_quantity := (v_equipment_item->>'quantity')::integer;
    if v_equipment_id is null or v_quantity is null or v_quantity <= 0 then
      raise exception 'Equipment item and positive quantity are required';
    end if;
    select quantity_on_hand, selling_price into v_on_hand, v_price
      from public.shop_equipment_stock
      where shop_id = p_shop_id and equipment_supply_id = v_equipment_id for update;
    if v_on_hand is null then raise exception 'Equipment item is not stocked at this shop'; end if;
    if v_on_hand < v_quantity then raise exception 'Not enough equipment stock remaining'; end if;
    if v_price is null or v_price <= 0 then raise exception 'Set a positive selling price for this equipment item before sale'; end if;
    if coalesce((v_equipment_item->>'unit_price')::numeric, -1) <> v_price then
      raise exception 'The selling price for this equipment item changed. Refresh the sale and try again.';
    end if;
    update public.shop_equipment_stock set quantity_on_hand = quantity_on_hand - v_quantity, updated_at = now()
      where shop_id = p_shop_id and equipment_supply_id = v_equipment_id;
    insert into public.equipment_sale_items (sale_id, equipment_supply_id, quantity, unit_price)
      values (v_sale_id, v_equipment_id, v_quantity, v_price);
    v_equipment_total := v_equipment_total + v_quantity * v_price;
  end loop;
  if v_equipment_total <> 0 then update public.sales set total_amount = total_amount + v_equipment_total where id = v_sale_id; end if;
  return v_sale_id;
end;
$function$;

create or replace function public.set_equipment_supply_selling_price(
  p_shop_id uuid, p_equipment_supply_id uuid, p_selling_price numeric
) returns void
language plpgsql security definer set search_path = public
as $function$
declare
  v_staff public.staff;
  v_own_org uuid;
  v_target_org uuid;
begin
  select * into v_staff from public.staff where auth_user_id = auth.uid();
  if v_staff.id is null then raise exception 'A staff account is required.'; end if;
  if lower(coalesce(v_staff.role, '')) <> 'pharmacist'
     and lower(coalesce(v_staff.role, '')) not in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
    raise exception 'Only pharmacists and administrators can update equipment prices.';
  end if;
  if p_selling_price is null or p_selling_price <= 0 then raise exception 'Enter a positive selling price.'; end if;
  if v_staff.shop_id <> p_shop_id then
    if lower(coalesce(v_staff.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin') then
      select organization_id into v_own_org from public.shops where id = v_staff.shop_id;
      select organization_id into v_target_org from public.shops where id = p_shop_id;
      if v_own_org is null or v_target_org is distinct from v_own_org then raise exception 'You cannot update prices for this shop.'; end if;
    else
      raise exception 'You cannot update prices for this shop.';
    end if;
  end if;
  update public.shop_equipment_stock set selling_price = p_selling_price, updated_at = now()
    where shop_id = p_shop_id and equipment_supply_id = p_equipment_supply_id;
  if not found then raise exception 'This equipment item is not stocked at this shop.'; end if;
end;
$function$;

revoke all on function public.sell_stock_and_equipment(uuid, text, jsonb, uuid, text, text, date) from public, anon;
revoke all on function public.receive_equipment_supply(uuid, uuid, integer, numeric, numeric, text, text) from public, anon;
revoke all on function public.set_equipment_supply_selling_price(uuid, uuid, numeric) from public, anon;
grant execute on function public.sell_stock_and_equipment(uuid, text, jsonb, uuid, text, text, date) to authenticated;
grant execute on function public.receive_equipment_supply(uuid, uuid, integer, numeric, numeric, text, text) to authenticated;
grant execute on function public.set_equipment_supply_selling_price(uuid, uuid, numeric) to authenticated;
