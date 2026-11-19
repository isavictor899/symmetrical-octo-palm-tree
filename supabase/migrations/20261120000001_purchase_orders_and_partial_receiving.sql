-- Purchase orders and goods received notes. Purchase-order reads and writes
-- use RPCs so staff access is checked consistently and tables stay private.

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_number text not null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name text,
  notes text,
  status text not null default 'ordered' check (status in ('ordered', 'partial', 'received', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  ordered_at timestamptz not null default now(),
  unique (shop_id, order_number)
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  drug_id uuid not null references public.drugs(id),
  quantity_ordered integer not null check (quantity_ordered > 0),
  quantity_received integer not null default 0 check (quantity_received >= 0 and quantity_received <= quantity_ordered),
  unit_cost_estimate numeric check (unit_cost_estimate is null or unit_cost_estimate >= 0),
  created_at timestamptz not null default now(),
  unique (purchase_order_id, drug_id)
);

create table if not exists public.purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_item_id uuid not null references public.purchase_order_items(id) on delete cascade,
  client_batch_id uuid not null unique,
  quantity integer not null check (quantity > 0),
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz not null default now()
);

create index if not exists purchase_orders_shop_status_created_idx on public.purchase_orders (shop_id, status, created_at desc);
create index if not exists purchase_order_items_order_idx on public.purchase_order_items (purchase_order_id);

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_order_receipts enable row level security;
revoke all on public.purchase_orders, public.purchase_order_items, public.purchase_order_receipts from public, anon, authenticated;

create or replace function public.purchase_order_actor_can_manage(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.staff actor
      join public.shops actor_shop on actor_shop.id = actor.shop_id
      join public.shops target_shop on target_shop.id = p_shop_id
     where actor.auth_user_id = auth.uid()
       and lower(btrim(coalesce(actor.role, ''))) in ('pharmacist', 'admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
       and (
         actor.shop_id = p_shop_id
         or (
           lower(btrim(coalesce(actor.role, ''))) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
           and actor_shop.organization_id is not null
           and actor_shop.organization_id = target_shop.organization_id
         )
       )
  );
$$;

create or replace function public.create_purchase_order(
  p_shop_id uuid,
  p_supplier_id uuid default null,
  p_supplier_name text default null,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_order_number text;
begin
  if not public.purchase_order_actor_can_manage(p_shop_id) then
    raise exception 'Only a pharmacist or administrator assigned to this organization can create a purchase order.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase order needs at least one drug line.' using errcode = 'P0001';
  end if;
  if p_supplier_id is null and nullif(btrim(coalesce(p_supplier_name, '')), '') is null then
    raise exception 'Choose a supplier or enter a supplier name.' using errcode = 'P0001';
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'The selected supplier was not found.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) x(item)
     where nullif(x.item->>'drug_id', '') is null
        or coalesce((x.item->>'quantity')::integer, 0) <= 0
        or not exists (select 1 from public.drugs where id = (x.item->>'drug_id')::uuid)
  ) then
    raise exception 'Every purchase-order line needs a valid drug and a positive whole-unit quantity.' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(p_items)) <> (select count(distinct (item->>'drug_id')) from jsonb_array_elements(p_items) x(item)) then
    raise exception 'Add each drug only once to a purchase order.' using errcode = 'P0001';
  end if;

  v_order_number := 'PO-' || to_char(now() at time zone 'Africa/Nairobi', 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  insert into public.purchase_orders (shop_id, order_number, supplier_id, supplier_name, notes, created_by)
  values (p_shop_id, v_order_number, p_supplier_id, nullif(btrim(p_supplier_name), ''), nullif(btrim(p_notes), ''), auth.uid())
  returning id into v_order_id;

  for v_item in select item from jsonb_array_elements(p_items) x(item) loop
    insert into public.purchase_order_items (purchase_order_id, drug_id, quantity_ordered, unit_cost_estimate)
    values ((v_order_id), (v_item->>'drug_id')::uuid, (v_item->>'quantity')::integer,
      case when nullif(v_item->>'unit_cost_estimate', '') is null then null else (v_item->>'unit_cost_estimate')::numeric end);
  end loop;
  return v_order_id;
end;
$$;

create or replace function public.purchase_order_list(p_shop_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if not public.purchase_order_actor_can_manage(p_shop_id) then
    raise exception 'You do not have access to this shop''s purchase orders.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(row_to_json(po)::jsonb order by po.created_at desc), '[]'::jsonb) into v_result
  from (
    select o.id, o.order_number, o.supplier_id, coalesce(s.name, o.supplier_name, 'Supplier not recorded') as supplier_name,
      o.notes, o.status, o.created_at, o.ordered_at,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'drug_id', i.drug_id, 'drug_name', d.name, 'generic_name', d.generic_name,
        'quantity_ordered', i.quantity_ordered, 'quantity_received', i.quantity_received,
        'unit_cost_estimate', i.unit_cost_estimate
      ) order by d.name) filter (where i.id is not null), '[]'::jsonb) as items
    from public.purchase_orders o
    left join public.suppliers s on s.id = o.supplier_id
    left join public.purchase_order_items i on i.purchase_order_id = o.id
    left join public.drugs d on d.id = i.drug_id
    where o.shop_id = p_shop_id
    group by o.id, s.name
  ) po;
  return v_result;
end;
$$;

create or replace function public.receive_purchase_order_item(
  p_purchase_order_item_id uuid,
  p_quantity integer,
  p_batch_number text,
  p_expiry_date date,
  p_cost_price numeric,
  p_selling_price numeric,
  p_client_batch_id uuid,
  p_initial_requires_prescription boolean default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_item public.purchase_order_items;
  v_order public.purchase_orders;
  v_supplier_name text;
  v_remaining integer;
begin
  if exists (select 1 from public.purchase_order_receipts where client_batch_id = p_client_batch_id) then
    return p_client_batch_id;
  end if;
  select * into v_item from public.purchase_order_items where id = p_purchase_order_item_id for update;
  if v_item.id is null then raise exception 'Purchase-order line was not found.' using errcode = 'P0001'; end if;
  select * into v_order from public.purchase_orders where id = v_item.purchase_order_id for update;
  if not public.purchase_order_actor_can_manage(v_order.shop_id) then raise exception 'You do not have permission to receive this order.' using errcode = 'P0001'; end if;
  if v_order.status = 'cancelled' then raise exception 'A cancelled purchase order cannot receive stock.' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Received quantity must be at least one unit.' using errcode = 'P0001'; end if;
  v_remaining := v_item.quantity_ordered - v_item.quantity_received;
  if p_quantity > v_remaining then raise exception 'You can receive at most % remaining units on this purchase-order line.', v_remaining using errcode = 'P0001'; end if;

  select coalesce((select s.name from public.suppliers s where s.id = v_order.supplier_id), v_order.supplier_name)
    into v_supplier_name;
  perform public.receive_stock(
    p_shop_id => v_order.shop_id, p_drug_id => v_item.drug_id, p_supplier_id => v_order.supplier_id,
    p_supplier_name => v_supplier_name, p_batch_number => nullif(btrim(p_batch_number), ''),
    p_expiry_date => p_expiry_date, p_cost_price => p_cost_price, p_selling_price => p_selling_price,
    p_quantity => p_quantity, p_client_batch_id => p_client_batch_id,
    p_initial_requires_prescription => p_initial_requires_prescription
  );
  insert into public.purchase_order_receipts (purchase_order_item_id, client_batch_id, quantity, received_by)
  values (v_item.id, p_client_batch_id, p_quantity, auth.uid());
  update public.purchase_order_items set quantity_received = quantity_received + p_quantity where id = v_item.id;
  update public.purchase_orders set status = case
    when exists (select 1 from public.purchase_order_items where purchase_order_id = v_order.id and quantity_received < quantity_ordered) then 'partial'
    else 'received' end where id = v_order.id;
  return p_client_batch_id;
end;
$$;

revoke all on function public.purchase_order_actor_can_manage(uuid), public.create_purchase_order(uuid, uuid, text, text, jsonb), public.purchase_order_list(uuid), public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) from public, anon;
grant execute on function public.create_purchase_order(uuid, uuid, text, text, jsonb), public.purchase_order_list(uuid), public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
