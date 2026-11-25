-- One-time repair: make batches.quantity_remaining agree with the stock ledger.
-- Cause (verified 2026-11-25): an earlier sale flow wrote duplicate 'sold' rows and
-- deducted stock twice. The duplicates were later deleted from stock_movements
-- (copies in stock_movements_sold_duplicates_backup) without restoring batch stock.
-- 4 seed batches were inserted without a 'received' movement.

create table if not exists public.stock_ledger_repairs (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.batches(id),
  shop_id uuid not null references public.shops(id),
  old_quantity_remaining integer not null,
  new_quantity_remaining integer not null,
  reason text not null,
  repaired_at timestamptz not null default now()
);
alter table public.stock_ledger_repairs enable row level security;
revoke all on public.stock_ledger_repairs from public, anon, authenticated;

create or replace function public.stock_movement_delta(p_type text, p_quantity integer)
returns integer
language sql immutable
set search_path = ''
as $$
  select case
    when p_type in ('received', 'transfer_in', 'return') then p_quantity
    when p_type in ('sold', 'transfer_out', 'write_off') then -p_quantity
    when p_type = 'adjustment' then p_quantity
  end;
$$;
revoke all on function public.stock_movement_delta(text, integer) from public, anon;
grant execute on function public.stock_movement_delta(text, integer) to authenticated, service_role;

alter table public.stock_movements disable trigger capture_supplier_debt_after_receipt;

insert into public.stock_movements (shop_id, drug_id, batch_id, movement_type, quantity, created_at)
select b.shop_id, b.drug_id, b.id, 'received', b.quantity_received, coalesce(b.received_at, now())
from public.batches b
where not exists (
  select 1 from public.stock_movements m
  where m.batch_id = b.id and m.movement_type in ('received', 'transfer_in')
);

alter table public.stock_movements enable trigger capture_supplier_debt_after_receipt;

insert into public.stock_movements (shop_id, drug_id, batch_id, movement_type, quantity, reference_id, created_at)
select r.shop_id, si.drug_id, si.batch_id, 'return', ri.quantity, r.id, r.created_at
from public.sales_return_items ri
join public.sales_returns r on r.id = ri.return_id
join public.sale_items si on si.id = ri.original_sale_item_id
where not exists (
  select 1 from public.stock_movements m
  where m.movement_type = 'return' and m.reference_id = r.id and m.batch_id = si.batch_id
);

with ledger as (
  select batch_id, sum(public.stock_movement_delta(movement_type, quantity))::integer as qty
  from public.stock_movements
  group by batch_id
), fix as (
  select b.id, b.shop_id, b.quantity_remaining as old_q, coalesce(l.qty, 0) as new_q
  from public.batches b
  left join ledger l on l.batch_id = b.id
  where b.quantity_remaining <> coalesce(l.qty, 0)
), logged as (
  insert into public.stock_ledger_repairs (batch_id, shop_id, old_quantity_remaining, new_quantity_remaining, reason)
  select id, shop_id, old_q, new_q,
    'Restored stock double-deducted by the duplicate sold-movement bug; seed batches given opening movements; past returns added to the ledger.'
  from fix
  returning batch_id
)
update public.batches b
set quantity_remaining = f.new_q
from fix f
where b.id = f.id;

alter table public.batches validate constraint batches_quantity_remaining_nonneg;