-- =============================================================================
-- CRITICAL #3: Fixed-amount discounts, attributed to a person
-- =============================================================================
-- The discount is entered as MONEY (e.g. "KES 50 off"), not a percentage.
-- We store the amount as authoritative, keep the derived percentage for
-- reporting, and stamp WHO applied it so the dashboard can show that a
-- cashier / pharmacist / administrator gave the discount.
--
-- This file also adds a price-integrity guard on sale_items. That guard makes
-- sell_stock_with_discounts' price validation redundant, which is what lets
-- migration 03 record an exact money discount instead of a rounded percentage.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Price integrity: a sale line may never be priced above the batch list
--    price, or below zero. This protects every sale path, including any future
--    RPC that forgets to validate prices itself.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_sale_item_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_price numeric;
  v_shop_id    uuid;
begin
  select s.shop_id into v_shop_id
    from public.sales s
   where s.id = new.sale_id;

  if v_shop_id is null then
    raise exception 'The sale for this line could not be found.'
      using errcode = 'P0001';
  end if;

  select b.selling_price into v_shop_price
    from public.batches b
   where b.id = new.batch_id
     and b.shop_id = v_shop_id;

  if v_shop_price is null then
    raise exception 'The selected drug batch was not found for this shop.'
      using errcode = 'P0001';
  end if;

  if new.unit_price is null or new.unit_price < 0 then
    raise exception 'The sale price cannot be negative.'
      using errcode = 'P0001';
  end if;

  if new.unit_price > v_shop_price then
    raise exception 'The sale price cannot be higher than the listed price of %.',
      v_shop_price
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_sale_item_price() is
  'Blocks any sale line priced above the batch list price or below zero.';

drop trigger if exists sale_items_enforce_price on public.sale_items;
create trigger sale_items_enforce_price
  before insert or update of unit_price on public.sale_items
  for each row
  execute function public.enforce_sale_item_price();


-- -----------------------------------------------------------------------------
-- 2. Discount accounting columns
-- -----------------------------------------------------------------------------
alter table public.sale_item_discounts
  add column if not exists discounted_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_by   uuid references auth.users(id) on delete set null,
  add column if not exists shop_id       uuid references public.shops(id) on delete cascade,
  -- Snapshot of the actor at the time of the discount. The staff table's RLS
  -- only lets a non-admin see their own row, so the dashboard cannot reliably
  -- join names; and a snapshot stays correct if the person is renamed or
  -- leaves. This is audit data, not a foreign key.
  add column if not exists discounted_by_name text,
  add column if not exists discounted_by_role text;

-- Backfill shop_id for any discounts recorded before this migration.
update public.sale_item_discounts d
   set shop_id = s.shop_id
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
 where si.id = d.sale_item_id
   and d.shop_id is null;

create index if not exists sale_item_discounts_shop_created_idx
  on public.sale_item_discounts (shop_id, created_at desc);
create index if not exists sale_item_discounts_discounted_by_idx
  on public.sale_item_discounts (discounted_by, created_at desc);


-- -----------------------------------------------------------------------------
-- 3. Discount policy. ADJUST THESE NUMBERS TO MATCH YOUR OWN POLICY.
--    This is the single source of truth used by the trigger below.
-- -----------------------------------------------------------------------------
create or replace function public.max_discount_percent(p_role text)
returns numeric
language sql
immutable
as $$
  select case
    when lower(btrim(coalesce(p_role, '')))
         in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
      then 100::numeric
    when lower(btrim(coalesce(p_role, ''))) = 'pharmacist'
      then 50::numeric
    else 25::numeric
  end;
$$;

comment on function public.max_discount_percent(text) is
  'Maximum discount, as a percentage of the line price, that a role may give. Administrators 100, pharmacists 50, everyone else 25.';


-- -----------------------------------------------------------------------------
-- 4. Enforce the policy, normalise amount vs percentage, and stamp the actor.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_discount_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_shop  uuid;
  v_actor      public.staff;
  v_max_pct    numeric;
  v_max_amount numeric;
  v_is_admin   boolean;
begin
  select s.shop_id into v_sale_shop
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
   where si.id = new.sale_item_id;

  if v_sale_shop is null then
    raise exception 'The discounted sale line could not be found.'
      using errcode = 'P0001';
  end if;

  new.shop_id       := v_sale_shop;
  new.discounted_by := coalesce(auth.uid(), new.discounted_by);

  select * into v_actor
    from public.staff
   where auth_user_id = auth.uid()
   order by id
   limit 1;

  if v_actor.id is null then
    raise exception 'A staff account is required to apply a discount.'
      using errcode = 'P0001';
  end if;

  new.discounted_by_name := v_actor.full_name;
  new.discounted_by_role := v_actor.role;

  if new.original_unit_price is null or new.original_unit_price <= 0 then
    raise exception 'The original price is required to record a discount.'
      using errcode = 'P0001';
  end if;

  -- The amount is authoritative. Legacy percentage-only writes are converted.
  if new.discount_amount is null then
    new.discount_amount := round(
      new.original_unit_price * coalesce(new.discount_percent, 0) / 100, 2
    );
  end if;

  if new.discount_amount <= 0 then
    new.discount_amount := 0;
    new.discount_percent := 0;
    return new;
  end if;

  if new.discount_amount > new.original_unit_price then
    raise exception 'A discount of % cannot exceed the unit price of %.',
      new.discount_amount, new.original_unit_price
      using errcode = 'P0001';
  end if;

  new.discount_percent := round(
    new.discount_amount / new.original_unit_price * 100, 2
  );

  v_is_admin := lower(btrim(coalesce(v_actor.role, '')))
    in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin');

  if v_actor.shop_id <> v_sale_shop then
    if not v_is_admin then
      raise exception 'You cannot discount a sale that belongs to another shop.'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
        from public.shops own
        join public.shops target on target.id = v_sale_shop
       where own.id = v_actor.shop_id
         and own.organization_id is not distinct from target.organization_id
    ) then
      raise exception 'You cannot discount a sale that belongs to another organization.'
        using errcode = 'P0001';
    end if;
  end if;

  v_max_pct    := public.max_discount_percent(v_actor.role);
  v_max_amount := round(new.original_unit_price * v_max_pct / 100, 2);

  if new.discount_amount > v_max_amount then
    raise exception
      'A % discount on a % item exceeds the % percent limit allowed for the "%" role (maximum % per unit). An administrator must approve larger discounts.',
      new.discount_amount, new.original_unit_price, v_max_pct, v_actor.role, v_max_amount
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_discount_policy() is
  'Stamps who gave the discount and blocks discounts above the role ceiling.';

drop trigger if exists sale_item_discounts_enforce_policy on public.sale_item_discounts;
create trigger sale_item_discounts_enforce_policy
  before insert or update on public.sale_item_discounts
  for each row
  execute function public.enforce_discount_policy();


-- -----------------------------------------------------------------------------
-- 5. Reporting view used by the dashboard. security_invoker keeps the existing
--    RLS policies on sales / sale_items / sale_item_discounts in force.
-- -----------------------------------------------------------------------------
create or replace view public.discount_audit
with (security_invoker = true) as
select
  d.created_at,
  s.sold_at,
  sh.name                              as shop_name,
  coalesce(d.discounted_by_name, st.full_name, 'Unknown') as discounted_by_name,
  coalesce(d.discounted_by_role, st.role)                 as discounted_by_role,
  dg.name                              as product_name,
  si.quantity,
  d.original_unit_price,
  d.discount_amount,
  d.discount_percent,
  round(d.discount_amount * si.quantity, 2) as total_discount_value
from public.sale_item_discounts d
join public.sale_items si  on si.id = d.sale_item_id
join public.sales s        on s.id  = si.sale_id
join public.shops sh       on sh.id = s.shop_id
join public.drugs dg       on dg.id = si.drug_id
left join public.staff st  on st.auth_user_id = d.discounted_by
where d.discount_amount > 0
order by d.created_at desc;

revoke all on public.discount_audit from public, anon;
grant select on public.discount_audit to authenticated;
