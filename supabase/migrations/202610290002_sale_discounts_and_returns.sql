-- Sale discounts and returns are kept in side tables so the existing
-- sales, sale_items, and stock trigger structures remain unchanged.

create table if not exists public.sale_item_discounts (
  sale_item_id uuid primary key references public.sale_items(id) on delete cascade,
  original_unit_price numeric not null check (original_unit_price >= 0),
  discount_percent numeric not null default 0 check (discount_percent between 0 and 100),
  discount_amount numeric not null default 0 check (discount_amount >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.sales_returns (
  id uuid primary key default gen_random_uuid(),
  client_return_id uuid,
  shop_id uuid not null references public.shops(id),
  sale_id uuid not null references public.sales(id),
  staff_id uuid references public.staff(id),
  refund_method text not null,
  reason text not null,
  total_amount numeric not null check (total_amount >= 0),
  created_at timestamptz not null default now()
);
alter table public.sales_returns add column if not exists client_return_id uuid;
create unique index if not exists sales_returns_client_return_id_idx
  on public.sales_returns(client_return_id) where client_return_id is not null;

create table if not exists public.sales_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sales_returns(id) on delete cascade,
  original_sale_item_id uuid not null references public.sale_items(id),
  quantity integer not null check (quantity > 0),
  refund_unit_price numeric not null check (refund_unit_price >= 0),
  subtotal numeric generated always as (quantity * refund_unit_price) stored,
  created_at timestamptz not null default now()
);

create index if not exists sales_returns_shop_created_idx
  on public.sales_returns(shop_id, created_at desc);
create index if not exists sales_return_items_original_idx
  on public.sales_return_items(original_sale_item_id);

alter table public.sale_item_discounts enable row level security;
alter table public.sales_returns enable row level security;
alter table public.sales_return_items enable row level security;
drop policy if exists sale_item_discounts_shop_read on public.sale_item_discounts;
create policy sale_item_discounts_shop_read on public.sale_item_discounts for select to authenticated
  using (exists (
    select 1 from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.staff viewer on viewer.auth_user_id = auth.uid()
    join public.shops sale_shop on sale_shop.id = s.shop_id
    join public.shops viewer_shop on viewer_shop.id = viewer.shop_id
    where si.id = sale_item_discounts.sale_item_id
      and (s.shop_id = viewer.shop_id or (
        lower(coalesce(viewer.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
        and sale_shop.organization_id = viewer_shop.organization_id
      ))
  ));
drop policy if exists sales_returns_shop_read on public.sales_returns;
create policy sales_returns_shop_read on public.sales_returns for select to authenticated
  using (
    shop_id = (select s.shop_id from public.staff s where s.auth_user_id = auth.uid())
    or exists (
      select 1 from public.staff viewer
      join public.shops viewer_shop on viewer_shop.id = viewer.shop_id
      join public.shops return_shop on return_shop.id = sales_returns.shop_id
      where viewer.auth_user_id = auth.uid()
        and lower(coalesce(viewer.role, '')) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
        and viewer_shop.organization_id = return_shop.organization_id
    )
  );
drop policy if exists sales_return_items_shop_read on public.sales_return_items;
create policy sales_return_items_shop_read on public.sales_return_items for select to authenticated
  using (exists (
    select 1 from public.sales_returns r where r.id = sales_return_items.return_id
  ));
grant select on public.sale_item_discounts, public.sales_returns, public.sales_return_items to authenticated;

-- Existing sale RPCs remain unchanged. This wrapper validates discounts,
-- delegates stock and sale creation to the established mixed-sale RPC, then
-- stores the original price and discount on each drug line atomically.
create or replace function public.sell_stock_with_discounts(
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
  v_item jsonb;
  v_batch_price numeric;
  v_original_price numeric;
  v_sale_price numeric;
  v_discount_percent numeric;
  v_expected_price numeric;
  v_sale_id uuid;
  v_sale_item_id uuid;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must include at least one item';
  end if;

  for v_item in select x.item from jsonb_array_elements(p_items) as x(item)
    where coalesce(x.item->>'item_type', 'drug') = 'drug'
  loop
    select selling_price into v_batch_price
      from public.batches
      where id = (v_item->>'batch_id')::uuid and shop_id = p_shop_id;
    if v_batch_price is null then raise exception 'The selected drug batch was not found for this shop'; end if;
    v_original_price := coalesce((v_item->>'original_unit_price')::numeric, v_batch_price);
    v_sale_price := (v_item->>'unit_price')::numeric;
    v_discount_percent := coalesce((v_item->>'discount_percent')::numeric, 0);
    if v_discount_percent < 0 or v_discount_percent > 100 then raise exception 'Discount must be between 0 and 100 percent'; end if;
    if v_original_price <> v_batch_price then raise exception 'The drug price changed. Refresh the sale and try again.'; end if;
    if v_sale_price < 0 or v_sale_price > v_original_price then raise exception 'Sale price must be between zero and the listed price'; end if;
    v_expected_price := round(v_original_price * (1 - v_discount_percent / 100), 2);
    if v_sale_price <> v_expected_price then raise exception 'The discount price is invalid. Refresh the sale and try again.'; end if;
  end loop;

  v_sale_id := public.sell_stock_and_equipment(
    p_shop_id, p_payment_method, p_items, p_client_sale_id,
    p_prescription_reference, p_prescriber_name, p_prescription_date
  );

  for v_item in select x.item from jsonb_array_elements(p_items) as x(item)
    where coalesce(x.item->>'item_type', 'drug') = 'drug'
  loop
    v_original_price := coalesce((v_item->>'original_unit_price')::numeric, (v_item->>'unit_price')::numeric);
    v_discount_percent := coalesce((v_item->>'discount_percent')::numeric, 0);
    select id into v_sale_item_id from public.sale_items
      where sale_id = v_sale_id and batch_id = (v_item->>'batch_id')::uuid
      order by id limit 1 for update;
    if v_sale_item_id is null then raise exception 'The drug sale line could not be found for discount recording'; end if;
    insert into public.sale_item_discounts (sale_item_id, original_unit_price, discount_percent, discount_amount)
      values (v_sale_item_id, v_original_price, v_discount_percent,
        v_original_price - (v_item->>'unit_price')::numeric)
      on conflict (sale_item_id) do update set
        original_unit_price = excluded.original_unit_price,
        discount_percent = excluded.discount_percent,
        discount_amount = excluded.discount_amount;
  end loop;
  return v_sale_id;
end;
$function$;

create or replace function public.return_sold_drug(
  p_sale_item_id uuid,
  p_quantity integer,
  p_refund_method text,
  p_reason text default 'Customer return',
  p_client_return_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $function$
declare
  v_staff public.staff;
  v_sale_item public.sale_items;
  v_sale public.sales;
  v_returned integer;
  v_available integer;
  v_return_id uuid := gen_random_uuid();
  v_existing_return_id uuid;
  v_batch_quantity integer;
  v_refund numeric;
begin
  select * into v_staff from public.staff where auth_user_id = auth.uid();
  if v_staff.id is null then raise exception 'A staff account is required.'; end if;
  if p_client_return_id is not null then
    select id into v_existing_return_id from public.sales_returns
      where client_return_id = p_client_return_id and shop_id = v_staff.shop_id;
    if v_existing_return_id is not null then return v_existing_return_id; end if;
  end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Return quantity must be greater than zero'; end if;
  if nullif(trim(coalesce(p_refund_method, '')), '') is null then raise exception 'Choose a refund method'; end if;
  if lower(trim(p_refund_method)) not in ('cash', 'mpesa', 'card', 'insurance', 'sha') then
    raise exception 'Choose a supported refund method';
  end if;

  select * into v_sale_item from public.sale_items where id = p_sale_item_id for update;
  if v_sale_item.id is null then raise exception 'The original sale item was not found'; end if;
  select * into v_sale from public.sales where id = v_sale_item.sale_id;
  if v_sale.shop_id is distinct from v_staff.shop_id then raise exception 'You cannot return an item from another shop'; end if;

  select coalesce(sum(ri.quantity), 0)::integer into v_returned
    from public.sales_return_items ri
    join public.sales_returns r on r.id = ri.return_id
    where ri.original_sale_item_id = p_sale_item_id;
  v_available := v_sale_item.quantity - v_returned;
  if p_quantity > v_available then raise exception 'Only % unit(s) remain eligible for return', v_available; end if;

  select quantity_remaining into v_batch_quantity
    from public.batches where id = v_sale_item.batch_id and shop_id = v_sale.shop_id for update;
  if v_batch_quantity is null then raise exception 'The original batch could not be found'; end if;

  v_refund := p_quantity * v_sale_item.unit_price;
  insert into public.sales_returns (id, client_return_id, shop_id, sale_id, staff_id, refund_method, reason, total_amount)
    values (v_return_id, p_client_return_id, v_sale.shop_id, v_sale.id, v_staff.id, trim(p_refund_method),
      coalesce(nullif(trim(p_reason), ''), 'Customer return'), v_refund);
  insert into public.sales_return_items (return_id, original_sale_item_id, quantity, refund_unit_price)
    values (v_return_id, p_sale_item_id, p_quantity, v_sale_item.unit_price);
  update public.batches set quantity_remaining = quantity_remaining + p_quantity where id = v_sale_item.batch_id;
  return v_return_id;
end;
$function$;

revoke all on function public.sell_stock_with_discounts(uuid, text, jsonb, uuid, text, text, date) from public, anon;
revoke all on function public.return_sold_drug(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.sell_stock_with_discounts(uuid, text, jsonb, uuid, text, text, date) to authenticated;
grant execute on function public.return_sold_drug(uuid, integer, text, text, uuid) to authenticated;
