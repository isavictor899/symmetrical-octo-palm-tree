-- Track unpaid drug receipts as supplier liabilities and let authorized staff
-- settle them once, recording the cash expense at the time it is paid.
create table if not exists public.supplier_debts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  client_batch_id uuid not null unique,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name text not null,
  drug_name text not null,
  batch_number text,
  quantity integer not null check (quantity > 0),
  amount numeric not null check (amount > 0),
  received_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  payment_method text check (payment_method is null or payment_method in ('cash', 'mpesa', 'card', 'bank', 'other')),
  check ((paid_at is null and paid_by is null and payment_method is null)
      or (paid_at is not null and paid_by is not null and payment_method is not null))
);

create index if not exists supplier_debts_shop_status_idx
  on public.supplier_debts (shop_id, paid_at, received_at desc);
alter table public.supplier_debts enable row level security;
revoke all on public.supplier_debts from public, anon, authenticated;

create or replace function public.capture_supplier_debt_for_receipt()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_batch public.batches;
  v_supplier_name text;
  v_drug_name text;
begin
  if new.movement_type <> 'received' then return new; end if;
  select * into v_batch from public.batches where id = new.batch_id;
  if v_batch.id is null or v_batch.client_batch_id is null then return new; end if;
  if v_batch.cost_price * v_batch.quantity_received <= 0 then return new; end if;
  select coalesce(s.name, 'Supplier not recorded') into v_supplier_name
    from (select v_batch.supplier_id as id) source
    left join public.suppliers s on s.id = source.id;
  select coalesce(name, 'Unknown drug') into v_drug_name from public.drugs where id = v_batch.drug_id;
  insert into public.supplier_debts (
    shop_id, client_batch_id, supplier_id, supplier_name, drug_name,
    batch_number, quantity, amount
  ) values (
    v_batch.shop_id, v_batch.client_batch_id, v_batch.supplier_id,
    coalesce(v_supplier_name, 'Supplier not recorded'), coalesce(v_drug_name, 'Unknown drug'),
    v_batch.batch_number, v_batch.quantity_received,
    round(v_batch.cost_price * v_batch.quantity_received, 2)
  ) on conflict (client_batch_id) do nothing;
  return new;
end;
$$;

drop trigger if exists capture_supplier_debt_after_receipt on public.stock_movements;
create trigger capture_supplier_debt_after_receipt
  after insert on public.stock_movements
  for each row execute function public.capture_supplier_debt_for_receipt();

create or replace function public.supplier_debt_list(p_shop_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You do not have access to this shop''s supplier debts.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.received_at desc), '[]'::jsonb)
    into v_rows
    from (
      select id, supplier_name, drug_name, batch_number, quantity, amount,
             received_at, paid_at, payment_method
        from public.supplier_debts
       where shop_id = p_shop_id and paid_at is null
    ) d;
  return v_rows;
end;
$$;

create or replace function public.supplier_debt_summary(p_shop_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You do not have access to this shop''s supplier debts.' using errcode = 'P0001';
  end if;
  select jsonb_build_object('amount', coalesce(sum(amount), 0), 'count', count(*))
    into v_result from public.supplier_debts where shop_id = p_shop_id and paid_at is null;
  return v_result;
end;
$$;

create or replace function public.pay_supplier_debt(p_debt_id uuid, p_payment_method text default 'other')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_debt public.supplier_debts;
  v_entry_id uuid;
begin
  select * into v_debt from public.supplier_debts where id = p_debt_id for update;
  if v_debt.id is null then raise exception 'Supplier debt was not found.' using errcode = 'P0001'; end if;
  if not public.purchase_order_actor_can_manage(v_debt.shop_id) then
    raise exception 'You do not have permission to record supplier payments for this shop.' using errcode = 'P0001';
  end if;
  if v_debt.paid_at is not null then raise exception 'This supplier debt has already been paid.' using errcode = 'P0001'; end if;
  if coalesce(p_payment_method, 'other') not in ('cash', 'mpesa', 'card', 'bank', 'other') then
    raise exception 'Choose a valid payment method.' using errcode = 'P0001';
  end if;
  insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, source_type, source_id, created_by)
  values (v_debt.shop_id, 'expense', 'stock purchase',
    'Supplier payment: ' || v_debt.supplier_name || ' · ' || v_debt.drug_name,
    v_debt.amount, coalesce(p_payment_method, 'other'), 'supplier_debt_payment', v_debt.id, auth.uid())
  on conflict (source_type, source_id) where source_type is not null and source_id is not null
  do update set source_id = excluded.source_id
  returning id into v_entry_id;
  update public.supplier_debts
     set paid_at = now(), paid_by = auth.uid(), payment_method = coalesce(p_payment_method, 'other')
   where id = v_debt.id;
  return v_entry_id;
end;
$$;

-- The existing PO payment RPC is also used by paid-now PO receiving.
create or replace function public.record_purchase_order_receipt_payment(p_receipt_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_shop_id uuid; v_client_batch_id uuid; v_amount numeric; v_drug_name text; v_entry_id uuid; v_debt_id uuid;
begin
  select po.shop_id, por.client_batch_id, b.cost_price * por.quantity, d.name
    into v_shop_id, v_client_batch_id, v_amount, v_drug_name
    from public.purchase_order_receipts por
    join public.purchase_order_items poi on poi.id = por.purchase_order_item_id
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join public.batches b on b.client_batch_id = por.client_batch_id and b.shop_id = po.shop_id
    join public.drugs d on d.id = poi.drug_id
   where por.id = p_receipt_id;
  if v_shop_id is null then raise exception 'Goods-received note was not found.' using errcode = 'P0001'; end if;
  if not public.purchase_order_actor_can_manage(v_shop_id) then
    raise exception 'You do not have permission to record payment for this goods-received note.' using errcode = 'P0001';
  end if;
  insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, source_type, source_id, created_by)
  values (v_shop_id, 'expense', 'stock purchase', 'Paid purchase-order receipt: ' || coalesce(v_drug_name, 'drug'),
    round(v_amount, 2), 'other', 'purchase_order_receipt', p_receipt_id, auth.uid())
  on conflict (source_type, source_id) where source_type is not null and source_id is not null
  do update set source_id = excluded.source_id
  returning id into v_entry_id;
  select id into v_debt_id from public.supplier_debts where client_batch_id = v_client_batch_id for update;
  if v_debt_id is not null then
    update public.supplier_debts set paid_at = coalesce(paid_at, now()), paid_by = coalesce(paid_by, auth.uid()), payment_method = coalesce(payment_method, 'other') where id = v_debt_id;
  end if;
  return v_entry_id;
end;
$$;

-- Preserve the established stock receipt RPC signature while creating the
-- expense for paid receipts or leaving the trigger-created liability open.
create or replace function public.receive_stock(
  p_shop_id uuid, p_drug_id uuid, p_supplier_id uuid, p_supplier_name text,
  p_batch_number text, p_expiry_date date, p_cost_price numeric,
  p_selling_price numeric, p_quantity integer, p_client_batch_id uuid,
  p_initial_requires_prescription boolean, p_paid_now boolean
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_batch_id uuid; v_drug_name text; v_debt_id uuid;
begin
  if coalesce(p_paid_now, false) and p_client_batch_id is null then
    raise exception 'A receipt ID is required to record a stock payment.' using errcode = 'P0001';
  end if;
  v_batch_id := public.receive_stock(p_shop_id, p_drug_id, p_supplier_id, p_supplier_name,
    p_batch_number, p_expiry_date, p_cost_price, p_selling_price, p_quantity,
    p_client_batch_id, p_initial_requires_prescription);
  select name into v_drug_name from public.drugs where id = p_drug_id;
  if coalesce(p_paid_now, false) then
    insert into public.finance_entries (shop_id, entry_type, category, description, amount, payment_method, source_type, source_id, created_by)
    values (p_shop_id, 'expense', 'stock purchase', 'Paid stock receipt: ' || coalesce(v_drug_name, 'drug'),
      round(p_cost_price * p_quantity, 2), 'other', 'stock_receipt', p_client_batch_id, auth.uid())
    on conflict (source_type, source_id) where source_type is not null and source_id is not null do nothing;
    select id into v_debt_id from public.supplier_debts where client_batch_id = p_client_batch_id for update;
    if v_debt_id is not null then
      update public.supplier_debts set paid_at = coalesce(paid_at, now()), paid_by = coalesce(paid_by, auth.uid()), payment_method = coalesce(payment_method, 'other') where id = v_debt_id;
    end if;
  end if;
  return v_batch_id;
end;
$$;

revoke all on function public.capture_supplier_debt_for_receipt(), public.supplier_debt_list(uuid), public.supplier_debt_summary(uuid), public.pay_supplier_debt(uuid, text) from public, anon;
grant execute on function public.supplier_debt_list(uuid), public.supplier_debt_summary(uuid), public.pay_supplier_debt(uuid, text) to authenticated;
revoke all on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean, boolean), public.record_purchase_order_receipt_payment(uuid) from public, anon;
grant execute on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean, boolean), public.record_purchase_order_receipt_payment(uuid) to authenticated;
