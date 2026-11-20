-- A shop-scoped operational finance ledger. Sales remain the source of truth
-- for revenue; this ledger records paid stock receipts and owner-entered
-- income/expenses. It deliberately does not turn an unpaid GRN into an
-- expense.

create table if not exists public.finance_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  entry_type text not null check (entry_type in ('income', 'expense')),
  category text not null,
  description text not null,
  amount numeric not null check (amount > 0),
  payment_method text not null default 'other' check (payment_method in ('cash', 'mpesa', 'card', 'bank', 'other')),
  occurred_at timestamptz not null default now(),
  source_type text,
  source_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists finance_entries_source_once_idx
  on public.finance_entries (source_type, source_id)
  where source_type is not null and source_id is not null;
create index if not exists finance_entries_shop_date_idx
  on public.finance_entries (shop_id, occurred_at desc);

create table if not exists public.cash_register_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  opened_by uuid not null references auth.users(id) on delete restrict,
  opened_at timestamptz not null default now(),
  opening_float numeric not null check (opening_float >= 0),
  closed_by uuid references auth.users(id) on delete restrict,
  closed_at timestamptz,
  counted_cash numeric check (counted_cash is null or counted_cash >= 0),
  expected_cash numeric,
  variance numeric,
  closing_note text,
  status text not null default 'open' check (status in ('open', 'closed')),
  check ((status = 'open' and closed_at is null and closed_by is null)
      or (status = 'closed' and closed_at is not null and closed_by is not null and counted_cash is not null))
);

create unique index if not exists cash_register_one_open_session_per_user_shop_idx
  on public.cash_register_sessions (shop_id, opened_by)
  where status = 'open';
create index if not exists cash_register_sessions_shop_opened_idx
  on public.cash_register_sessions (shop_id, opened_at desc);

alter table public.finance_entries enable row level security;
alter table public.cash_register_sessions enable row level security;
revoke all on public.finance_entries, public.cash_register_sessions from public, anon, authenticated;

-- A shop ID supplied by the browser is only a requested scope. These helpers
-- prove it against auth.uid(), staff, and the shops' live organization data.
create or replace function public.finance_actor_can_access(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.staff actor
      join public.shops actor_shop on actor_shop.id = actor.shop_id
      join public.shops target_shop on target_shop.id = p_shop_id
     where actor.auth_user_id = auth.uid()
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

create or replace function public.finance_actor_can_manage(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.staff actor
      join public.shops actor_shop on actor_shop.id = actor.shop_id
      join public.shops target_shop on target_shop.id = p_shop_id
     where actor.auth_user_id = auth.uid()
       and lower(btrim(coalesce(actor.role, ''))) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
       and (
         actor.shop_id = p_shop_id
         or (
           actor_shop.organization_id is not null
           and actor_shop.organization_id = target_shop.organization_id
         )
       )
  );
$$;

create or replace function public.create_finance_entry(
  p_shop_id uuid,
  p_entry_type text,
  p_category text,
  p_description text,
  p_amount numeric,
  p_payment_method text default 'other',
  p_occurred_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.finance_actor_can_manage(p_shop_id) then
    raise exception 'Only an administrator or owner can add manual finance entries for this shop.' using errcode = 'P0001';
  end if;
  if p_entry_type not in ('income', 'expense')
     or nullif(btrim(p_category), '') is null
     or nullif(btrim(p_description), '') is null
     or p_amount is null or p_amount <= 0
     or coalesce(p_payment_method, 'other') not in ('cash', 'mpesa', 'card', 'bank', 'other') then
    raise exception 'Enter a valid type, category, description, positive amount, and payment method.' using errcode = 'P0001';
  end if;
  insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, occurred_at, created_by)
  values (p_shop_id, p_entry_type, btrim(p_category), btrim(p_description), p_amount, coalesce(p_payment_method, 'other'), coalesce(p_occurred_at, now()), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finance_transaction_list(
  p_shop_id uuid,
  p_kind text default 'all',
  p_start date default null,
  p_end date default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You do not have access to this shop''s financial records.' using errcode = 'P0001';
  end if;
  if p_kind not in ('all', 'income', 'expense') then
    raise exception 'Unknown financial transaction type.' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.occurred_at desc), '[]'::jsonb)
    into v_rows
    from (
      select s.id, 'income'::text as entry_type, 'sales'::text as category,
             'POS sale'::text as description, s.total_amount::numeric as amount,
             coalesce(s.payment_method, 'other') as payment_method, s.sold_at as occurred_at,
             'sale'::text as source_type
        from public.sales s
       where s.shop_id = p_shop_id
         and (p_start is null or s.sold_at >= p_start::timestamptz)
         and (p_end is null or s.sold_at < (p_end + 1)::timestamptz)
      union all
      select r.id, 'expense'::text as entry_type, 'refunds'::text as category,
             'Customer return'::text as description, r.total_amount::numeric as amount,
             coalesce(r.refund_method, 'other') as payment_method, r.created_at as occurred_at,
             'return'::text as source_type
        from public.sales_returns r
       where r.shop_id = p_shop_id
         and (p_start is null or r.created_at >= p_start::timestamptz)
         and (p_end is null or r.created_at < (p_end + 1)::timestamptz)
      union all
      select f.id, f.entry_type, f.category, f.description, f.amount, f.payment_method,
             f.occurred_at, coalesce(f.source_type, 'manual') as source_type
        from public.finance_entries f
       where f.shop_id = p_shop_id
         and (p_start is null or f.occurred_at >= p_start::timestamptz)
         and (p_end is null or f.occurred_at < (p_end + 1)::timestamptz)
    ) entry
   where p_kind = 'all' or entry.entry_type = p_kind;
  return v_rows;
end;
$$;

create or replace function public.cash_register_current(p_shop_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_session public.cash_register_sessions; v_expected numeric := 0;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You do not have access to this shop''s cash register.' using errcode = 'P0001';
  end if;
  select * into v_session from public.cash_register_sessions
   where shop_id = p_shop_id and opened_by = auth.uid() and status = 'open'
   order by opened_at desc limit 1;
  if v_session.id is null then return null; end if;
  select v_session.opening_float
       + coalesce((select sum(total_amount) from public.sales where shop_id = p_shop_id and payment_method = 'cash' and sold_at >= v_session.opened_at), 0)
       - coalesce((select sum(total_amount) from public.sales_returns where shop_id = p_shop_id and refund_method = 'cash' and created_at >= v_session.opened_at), 0)
       + coalesce((select sum(case when entry_type = 'income' then amount else -amount end) from public.finance_entries where shop_id = p_shop_id and payment_method = 'cash' and occurred_at >= v_session.opened_at), 0)
    into v_expected;
  return jsonb_build_object('id', v_session.id, 'opened_at', v_session.opened_at,
    'opening_float', v_session.opening_float, 'expected_cash', v_expected);
end;
$$;

create or replace function public.open_cash_register(p_shop_id uuid, p_opening_float numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You cannot open a cash register for this shop.' using errcode = 'P0001';
  end if;
  if p_opening_float is null or p_opening_float < 0 then
    raise exception 'Opening cash cannot be negative.' using errcode = 'P0001';
  end if;
  insert into public.cash_register_sessions (shop_id, opened_by, opening_float)
  values (p_shop_id, auth.uid(), p_opening_float) returning id into v_id;
  return public.cash_register_current(p_shop_id);
exception when unique_violation then
  raise exception 'You already have an open cash register at this shop. Close it before opening another.' using errcode = 'P0001';
end;
$$;

create or replace function public.close_cash_register(p_shop_id uuid, p_counted_cash numeric, p_closing_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_current jsonb; v_id uuid; v_expected numeric; v_variance numeric;
begin
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Counted cash cannot be negative.' using errcode = 'P0001';
  end if;
  v_current := public.cash_register_current(p_shop_id);
  if v_current is null then
    raise exception 'There is no open cash register for your account at this shop.' using errcode = 'P0001';
  end if;
  v_id := (v_current->>'id')::uuid; v_expected := (v_current->>'expected_cash')::numeric;
  v_variance := p_counted_cash - v_expected;
  update public.cash_register_sessions
     set status = 'closed', closed_by = auth.uid(), closed_at = now(), counted_cash = p_counted_cash,
         expected_cash = v_expected, variance = v_variance, closing_note = nullif(btrim(p_closing_note), '')
   where id = v_id and status = 'open';
  return jsonb_build_object('id', v_id, 'expected_cash', v_expected, 'counted_cash', p_counted_cash, 'variance', v_variance);
end;
$$;

-- Purchase-order receipts already have an immutable receipt ID. This lets the
-- receiving pharmacist record a supplier payment once, without granting them
-- access to create arbitrary owner finance entries.
create or replace function public.record_purchase_order_receipt_payment(p_receipt_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_shop_id uuid; v_client_batch_id uuid; v_amount numeric; v_drug_name text; v_entry_id uuid;
begin
  select po.shop_id, por.client_batch_id, b.cost_price * por.quantity, d.name
    into v_shop_id, v_client_batch_id, v_amount, v_drug_name
    from public.purchase_order_receipts por
    join public.purchase_order_items poi on poi.id = por.purchase_order_item_id
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join public.batches b on b.client_batch_id = por.client_batch_id and b.shop_id = po.shop_id
    join public.drugs d on d.id = poi.drug_id
   where por.id = p_receipt_id;
  if v_shop_id is null then
    raise exception 'Goods-received note was not found.' using errcode = 'P0001';
  end if;
  if not public.purchase_order_actor_can_manage(v_shop_id) then
    raise exception 'You do not have permission to record payment for this goods-received note.' using errcode = 'P0001';
  end if;
  insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, source_type, source_id, created_by)
  values (v_shop_id, 'expense', 'stock purchase', 'Paid purchase-order receipt: ' || coalesce(v_drug_name, 'drug'),
    round(v_amount, 2), 'other', 'purchase_order_receipt', p_receipt_id, auth.uid())
  on conflict (source_type, source_id) where source_type is not null and source_id is not null
  do update set source_id = excluded.source_id
  returning id into v_entry_id;
  return v_entry_id;
end;
$$;

-- The paid-now form of PO receiving is atomic: inventory, GRN, order status,
-- and the expense either all commit together or all roll back together.
create or replace function public.receive_purchase_order_item(
  p_purchase_order_item_id uuid,
  p_quantity integer,
  p_batch_number text,
  p_expiry_date date,
  p_cost_price numeric,
  p_selling_price numeric,
  p_client_batch_id uuid,
  p_initial_requires_prescription boolean,
  p_paid_now boolean
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_item public.purchase_order_items;
  v_order public.purchase_orders;
  v_supplier_name text;
  v_remaining integer;
  v_existing_receipt public.purchase_order_receipts;
  v_receipt_id uuid;
begin
  if p_client_batch_id is null then raise exception 'A receipt request ID is required.' using errcode = 'P0001'; end if;
  select * into v_item from public.purchase_order_items where id = p_purchase_order_item_id for update;
  if v_item.id is null then raise exception 'Purchase-order line was not found.' using errcode = 'P0001'; end if;
  select * into v_order from public.purchase_orders where id = v_item.purchase_order_id for update;
  if not public.purchase_order_actor_can_manage(v_order.shop_id) then raise exception 'You do not have permission to receive this order.' using errcode = 'P0001'; end if;
  select * into v_existing_receipt from public.purchase_order_receipts where client_batch_id = p_client_batch_id;
  if v_existing_receipt.id is not null then
    if v_existing_receipt.purchase_order_item_id <> v_item.id then raise exception 'This receipt request ID belongs to another order line.' using errcode = 'P0001'; end if;
    if coalesce(p_paid_now, false) then perform public.record_purchase_order_receipt_payment(v_existing_receipt.id); end if;
    return v_existing_receipt.id;
  end if;
  if v_order.status = 'cancelled' then raise exception 'A cancelled purchase order cannot receive stock.' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Received quantity must be at least one unit.' using errcode = 'P0001'; end if;
  v_remaining := v_item.quantity_ordered - v_item.quantity_received;
  if p_quantity > v_remaining then raise exception 'You can receive at most % remaining units on this purchase-order line.', v_remaining using errcode = 'P0001'; end if;
  if exists (select 1 from public.batches where client_batch_id = p_client_batch_id) then raise exception 'This receipt request ID has already been used for a stock batch.' using errcode = 'P0001'; end if;
  insert into public.purchase_order_receipts (purchase_order_item_id, client_batch_id, quantity, received_by)
  values (v_item.id, p_client_batch_id, p_quantity, auth.uid()) returning id into v_receipt_id;
  select coalesce((select s.name from public.suppliers s where s.id = v_order.supplier_id), v_order.supplier_name) into v_supplier_name;
  perform public.receive_stock(
    p_shop_id => v_order.shop_id, p_drug_id => v_item.drug_id, p_supplier_id => v_order.supplier_id,
    p_supplier_name => v_supplier_name, p_batch_number => nullif(btrim(p_batch_number), ''),
    p_expiry_date => p_expiry_date, p_cost_price => p_cost_price, p_selling_price => p_selling_price,
    p_quantity => p_quantity, p_client_batch_id => p_client_batch_id,
    p_initial_requires_prescription => p_initial_requires_prescription
  );
  if coalesce(p_paid_now, false) then perform public.record_purchase_order_receipt_payment(v_receipt_id); end if;
  update public.purchase_order_items set quantity_received = quantity_received + p_quantity where id = v_item.id;
  update public.purchase_orders set status = case when exists (
    select 1 from public.purchase_order_items where purchase_order_id = v_order.id and quantity_received < quantity_ordered
  ) then 'partial' else 'received' end where id = v_order.id;
  return v_receipt_id;
end;
$$;

-- Add a paid-now variation without changing existing callers. The base stock
-- receiving RPC remains the inventory authority; the wrapper adds one
-- idempotent expense only when the caller confirms the bill was paid.
create or replace function public.receive_stock(
  p_shop_id uuid, p_drug_id uuid, p_supplier_id uuid, p_supplier_name text,
  p_batch_number text, p_expiry_date date, p_cost_price numeric,
  p_selling_price numeric, p_quantity integer, p_client_batch_id uuid,
  p_initial_requires_prescription boolean, p_paid_now boolean
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_batch_id uuid; v_drug_name text;
begin
  v_batch_id := public.receive_stock(p_shop_id, p_drug_id, p_supplier_id, p_supplier_name,
    p_batch_number, p_expiry_date, p_cost_price, p_selling_price, p_quantity,
    p_client_batch_id, p_initial_requires_prescription);
  if coalesce(p_paid_now, false) then
    if p_client_batch_id is null then
      raise exception 'A receipt ID is required to record a stock payment.' using errcode = 'P0001';
    end if;
    select name into v_drug_name from public.drugs where id = p_drug_id;
    insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, source_type, source_id, created_by)
    values (p_shop_id, 'expense', 'stock purchase', 'Paid stock receipt: ' || coalesce(v_drug_name, 'drug'),
      round(p_cost_price * p_quantity, 2), 'other', 'stock_receipt', p_client_batch_id, auth.uid())
    on conflict (source_type, source_id) where source_type is not null and source_id is not null do nothing;
  end if;
  return v_batch_id;
end;
$$;

revoke all on function public.finance_actor_can_access(uuid), public.finance_actor_can_manage(uuid) from public, anon, authenticated;
revoke all on function public.create_finance_entry(uuid, text, text, text, numeric, text, timestamptz), public.finance_transaction_list(uuid, text, date, date), public.cash_register_current(uuid), public.open_cash_register(uuid, numeric), public.close_cash_register(uuid, numeric, text), public.record_purchase_order_receipt_payment(uuid), public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean, boolean), public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean, boolean) from public, anon;
grant execute on function public.create_finance_entry(uuid, text, text, text, numeric, text, timestamptz), public.finance_transaction_list(uuid, text, date, date), public.cash_register_current(uuid), public.open_cash_register(uuid, numeric), public.close_cash_register(uuid, numeric, text), public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean, boolean), public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';
