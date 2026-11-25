-- Append-only stock ledger, balance guard, and audited stock counts.

alter table public.stock_movements add column if not exists created_by uuid default auth.uid();
alter table public.stock_movements add column if not exists note text;

alter table public.stock_movements add constraint stock_movements_quantity_sign check (
  (movement_type = 'adjustment' and quantity <> 0)
  or (movement_type <> 'adjustment' and quantity > 0)
);

create index if not exists idx_stock_movements_batch on public.stock_movements (batch_id);

create or replace function public.stock_movements_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Stock movements are an audit ledger and cannot be changed or deleted. Record a stock count instead.'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.stock_movements_append_only() from public, anon, authenticated;

drop trigger if exists stock_movements_no_update_delete on public.stock_movements;
create trigger stock_movements_no_update_delete
  before update or delete on public.stock_movements
  for each row execute function public.stock_movements_append_only();

drop trigger if exists stock_movements_no_truncate on public.stock_movements;
create trigger stock_movements_no_truncate
  before truncate on public.stock_movements
  for each statement execute function public.stock_movements_append_only();

create or replace function public.assert_batch_ledger_balanced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_remaining integer;
  v_ledger integer;
begin
  if tg_table_name = 'batches' then
    v_batch := new.id;
  else
    v_batch := new.batch_id;
  end if;
  if v_batch is null then return null; end if;

  select quantity_remaining into v_remaining from public.batches where id = v_batch;
  if v_remaining is null then return null; end if;

  select coalesce(sum(public.stock_movement_delta(movement_type, quantity)), 0)
    into v_ledger
    from public.stock_movements
   where batch_id = v_batch;

  if v_ledger <> v_remaining then
    raise exception 'Stock ledger mismatch for batch % (shelf % vs ledger %). Every stock change must be recorded as a stock movement.',
      v_batch, v_remaining, v_ledger
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke all on function public.assert_batch_ledger_balanced() from public, anon, authenticated;

drop trigger if exists batches_ledger_balanced on public.batches;
create constraint trigger batches_ledger_balanced
  after insert or update of quantity_remaining on public.batches
  deferrable initially deferred
  for each row execute function public.assert_batch_ledger_balanced();

drop trigger if exists stock_movements_ledger_balanced on public.stock_movements;
create constraint trigger stock_movements_ledger_balanced
  after insert on public.stock_movements
  deferrable initially deferred
  for each row execute function public.assert_batch_ledger_balanced();

create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  client_count_id uuid unique,
  shop_id uuid not null references public.shops(id),
  batch_id uuid not null references public.batches(id),
  drug_id uuid not null references public.drugs(id),
  system_quantity integer not null,
  counted_quantity integer not null check (counted_quantity >= 0),
  variance integer generated always as (counted_quantity - system_quantity) stored,
  reason text,
  counted_by uuid not null default auth.uid(),
  counted_by_staff_id uuid references public.staff(id),
  counted_at timestamptz not null default now()
);
create index if not exists idx_stock_counts_batch on public.stock_counts (batch_id, counted_at desc);
create index if not exists idx_stock_counts_shop on public.stock_counts (shop_id, counted_at desc);

alter table public.stock_counts enable row level security;
revoke all on public.stock_counts from public, anon, authenticated;
grant select on public.stock_counts to authenticated;

drop policy if exists stock_counts_shop_read on public.stock_counts;
create policy stock_counts_shop_read on public.stock_counts
  for select to authenticated
  using (
    shop_id = (select s.shop_id from public.staff s where s.auth_user_id = auth.uid())
    or (
      shop_id in (select sh.id from public.shops sh where sh.organization_id = public.my_organization_id())
      and public.current_user_is_admin()
    )
  );

create or replace function public.record_stock_count(
  p_shop_id uuid,
  p_batch_id uuid,
  p_counted_quantity integer,
  p_reason text default null,
  p_client_count_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_batch public.batches;
  v_count_id uuid;
  v_variance integer;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select s.* into v_staff
    from public.staff s
    join public.shops actor_shop on actor_shop.id = s.shop_id
    join public.shops target_shop on target_shop.id = p_shop_id
   where s.auth_user_id = auth.uid()
     and (
       (s.role in ('pharmacist', 'manager') and s.shop_id = p_shop_id)
       or (s.role = 'admin' and actor_shop.organization_id = target_shop.organization_id)
     )
   limit 1;

  if v_staff.id is null then
    raise exception 'Only a pharmacist, manager or administrator can record a stock count for this shop.'
      using errcode = 'P0001';
  end if;

  if p_client_count_id is not null then
    select id into v_count_id from public.stock_counts
     where client_count_id = p_client_count_id and shop_id = p_shop_id;
    if v_count_id is not null then return v_count_id; end if;
  end if;

  if p_counted_quantity is null or p_counted_quantity < 0 then
    raise exception 'Enter the counted quantity (zero or more).' using errcode = 'P0001';
  end if;

  select * into v_batch from public.batches
   where id = p_batch_id and shop_id = p_shop_id
   for update;
  if v_batch.id is null then
    raise exception 'Batch not found in this shop.' using errcode = 'P0001';
  end if;

  v_variance := p_counted_quantity - v_batch.quantity_remaining;
  if v_variance <> 0 and (v_reason is null or length(v_reason) < 3) then
    raise exception 'Explain the difference of % unit(s) before saving (for example damaged, theft, miscount).', v_variance
      using errcode = 'P0001';
  end if;

  insert into public.stock_counts
    (client_count_id, shop_id, batch_id, drug_id, system_quantity, counted_quantity, reason, counted_by, counted_by_staff_id)
  values
    (p_client_count_id, p_shop_id, p_batch_id, v_batch.drug_id, v_batch.quantity_remaining, p_counted_quantity, v_reason, auth.uid(), v_staff.id)
  returning id into v_count_id;

  if v_variance <> 0 then
    update public.batches set quantity_remaining = p_counted_quantity where id = p_batch_id;
    insert into public.stock_movements (shop_id, drug_id, batch_id, movement_type, quantity, reference_id, note)
    values (p_shop_id, v_batch.drug_id, p_batch_id, 'adjustment', v_variance, v_count_id, v_reason);
  end if;

  return v_count_id;
end;
$$;
revoke all on function public.record_stock_count(uuid, uuid, integer, text, uuid) from public, anon;
grant execute on function public.record_stock_count(uuid, uuid, integer, text, uuid) to authenticated;

create or replace view public.stock_reconciliation
with (security_invoker = true) as
select
  b.id as batch_id,
  b.shop_id,
  b.drug_id,
  d.name as drug_name,
  b.batch_number,
  b.expiry_date,
  b.quantity_remaining,
  coalesce(l.ledger_quantity, 0) as ledger_quantity,
  b.quantity_remaining - coalesce(l.ledger_quantity, 0) as drift,
  c.counted_at as last_counted_at,
  c.variance as last_variance
from public.batches b
join public.drugs d on d.id = b.drug_id
left join lateral (
  select sum(public.stock_movement_delta(m.movement_type, m.quantity))::integer as ledger_quantity
  from public.stock_movements m
  where m.batch_id = b.id
) l on true
left join lateral (
  select sc.counted_at, sc.variance
  from public.stock_counts sc
  where sc.batch_id = b.id
  order by sc.counted_at desc
  limit 1
) c on true;

revoke all on public.stock_reconciliation from public, anon, authenticated;
grant select on public.stock_reconciliation to authenticated;

notify pgrst, 'reload schema';