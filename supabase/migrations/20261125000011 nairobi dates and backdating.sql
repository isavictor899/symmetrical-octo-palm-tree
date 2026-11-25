-- Nairobi dates and sale-time limits.
--
-- 1. "Today" now means today in Kenya. The database runs on UTC, so between
--    midnight and 3am Nairobi time current_date was still yesterday: stock that
--    expired yesterday could be sold or received, and a prescription dated today
--    was rejected as "in the future". nairobi_today() replaces current_date in
--    every function that used it.
-- 2. Offline sales can be backdated by at most 7 days (was 90), on every path.
--    Previously a sale without p_created_by_user_id could set any sold_at at
--    all, including a future one.
-- 3. A sale recorded offline by a cashier who has since been deactivated still
--    syncs, but only if it was sold before the deactivation.
-- 4. sales.recorded_at and sales.synced_by record when and by whom a sale
--    actually reached the server, so a backdated sale can always be spotted.

create or replace function public.nairobi_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Africa/Nairobi')::date;
$$;

-- Swap current_date for nairobi_today() in the existing function bodies.
do $$
declare
  v_fn record;
  v_def text;
begin
  for v_fn in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname <> 'nairobi_today'
       and pg_get_functiondef(p.oid) ~ '\mcurrent_date\M'
  loop
    v_def := regexp_replace(pg_get_functiondef(v_fn.oid), '\mcurrent_date\M', 'public.nairobi_today()', 'g');
    execute v_def;
  end loop;
end;
$$;

-- Added without a default first so existing sales stay NULL ("not recorded")
-- instead of all showing today's date.
alter table public.sales add column if not exists recorded_at timestamptz;
alter table public.sales add column if not exists synced_by uuid;
alter table public.sales alter column recorded_at set default now();
alter table public.sales alter column synced_by set default auth.uid();

create or replace function public.sell_stock_with_amount_discounts(
  p_shop_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_client_sale_id uuid default null,
  p_prescription_reference text default null,
  p_prescriber_name text default null,
  p_prescription_date date default null,
  p_created_by_user_id uuid default null,
  p_sold_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item          jsonb;
  v_batch_price   numeric;
  v_original      numeric;
  v_discount      numeric;
  v_unit_price    numeric;
  v_expected      numeric;
  v_sale_id       uuid;
  v_sale_item_id  uuid;
  v_caller        public.staff;
  v_creator       public.staff;
  v_sold_at       timestamptz;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must include at least one item'
      using errcode = 'P0001';
  end if;

  select * into v_caller
    from public.staff
   where auth_user_id = auth.uid()
   order by id
   limit 1;

  if v_caller.id is null then
    raise exception 'A staff account is required to record a sale.'
      using errcode = 'P0001';
  end if;

  -- A retry of a sale the server already has (the reply was lost) returns the
  -- existing sale, even if the age limit below has passed since.
  if p_client_sale_id is not null then
    select s.id into v_sale_id
      from public.sales s
     where s.client_sale_id = p_client_sale_id
       and s.shop_id = p_shop_id;
    if v_sale_id is not null then
      return v_sale_id;
    end if;
  end if;

  -- An offline till may sync days later, but not weeks later. A future time
  -- (device clock running fast) is clamped to now rather than rejected, so a
  -- sale is never lost over clock drift.
  if p_sold_at is not null and p_sold_at < now() - interval '7 days' then
    raise exception 'The recorded sale time is more than 7 days old. Check the till clock, or ask an administrator to record this sale.'
      using errcode = 'P0001';
  end if;
  v_sold_at := least(p_sold_at, now());

  -- ---------------------------------------------------------------------------
  -- Validate every drug line BEFORE any stock is touched.
  -- ---------------------------------------------------------------------------
  for v_item in
    select x.item
      from jsonb_array_elements(p_items) as x(item)
     where coalesce(x.item->>'item_type', 'drug') = 'drug'
  loop
    select b.selling_price into v_batch_price
      from public.batches b
     where b.id = (v_item->>'batch_id')::uuid
       and b.shop_id = p_shop_id;

    if v_batch_price is null then
      raise exception 'The selected drug batch was not found for this shop'
        using errcode = 'P0001';
    end if;

    v_original := coalesce((v_item->>'original_unit_price')::numeric, v_batch_price);

    if v_original <> v_batch_price then
      raise exception 'The drug price changed. Refresh the sale and try again.'
        using errcode = 'P0001';
    end if;

    -- The discount is a money amount per unit, not a percentage.
    v_discount := coalesce((v_item->>'discount_amount')::numeric, 0);

    if v_discount < 0 then
      raise exception 'A discount cannot be negative.'
        using errcode = 'P0001';
    end if;

    if v_discount > v_original then
      raise exception 'A discount of % cannot exceed the unit price of %.',
        v_discount, v_original
        using errcode = 'P0001';
    end if;

    v_unit_price := coalesce((v_item->>'unit_price')::numeric, v_original - v_discount);
    v_expected   := round(v_original - v_discount, 2);

    if round(v_unit_price, 2) <> v_expected then
      raise exception 'The discounted price does not match the discount amount. Refresh the sale and try again.'
        using errcode = 'P0001';
    end if;
  end loop;

  -- ---------------------------------------------------------------------------
  -- Attribution checks, also before any stock is touched.
  -- ---------------------------------------------------------------------------
  if p_created_by_user_id is not null then
    -- The originator must belong to the selling shop, so a till cannot
    -- attribute a sale to a colleague in another shop. A cashier deactivated
    -- after the sale is matched through former_auth_user_id.
    select * into v_creator
      from public.staff
     where shop_id = p_shop_id
       and (auth_user_id = p_created_by_user_id or former_auth_user_id = p_created_by_user_id)
     order by (auth_user_id = p_created_by_user_id) desc nulls last, id
     limit 1;

    if v_creator.id is null then
      raise exception 'The staff member who recorded this sale is not assigned to this shop.'
        using errcode = 'P0001';
    end if;

    -- A deactivated cashier's sale only counts if it happened while they
    -- were still active.
    if v_creator.auth_user_id is distinct from p_created_by_user_id
       and (v_sold_at is null
            or v_creator.deactivated_at is null
            or v_sold_at > v_creator.deactivated_at) then
      raise exception 'This sale was recorded after the staff member''s account was deactivated.'
        using errcode = 'P0001';
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Delegate the actual sale. Stock checks, equipment handling, client_sale_id
  -- idempotency, the prescription trigger and the sale_items price guard all
  -- still run inside this call.
  -- ---------------------------------------------------------------------------
  v_sale_id := public.sell_stock_and_equipment(
    p_shop_id,
    p_payment_method,
    p_items,
    p_client_sale_id,
    p_prescription_reference,
    p_prescriber_name,
    p_prescription_date
  );

  if v_sale_id is null then
    return null;
  end if;

  update public.sales
     set staff_id = coalesce(v_creator.id, staff_id),
         sold_at  = coalesce(v_sold_at, sold_at)
   where id = v_sale_id;

  -- ---------------------------------------------------------------------------
  -- Record the money discount and let the trigger stamp discounted_by/shop_id
  -- and enforce the role ceiling.
  -- ---------------------------------------------------------------------------
  for v_item in
    select x.item
      from jsonb_array_elements(p_items) as x(item)
     where coalesce(x.item->>'item_type', 'drug') = 'drug'
  loop
    v_discount := coalesce((v_item->>'discount_amount')::numeric, 0);

    if v_discount > 0 then
      select b.selling_price into v_original
        from public.batches b
       where b.id = (v_item->>'batch_id')::uuid
         and b.shop_id = p_shop_id;

      v_original := coalesce((v_item->>'original_unit_price')::numeric, v_original);

      select si.id into v_sale_item_id
        from public.sale_items si
       where si.sale_id  = v_sale_id
         and si.batch_id = (v_item->>'batch_id')::uuid
       order by si.id
       limit 1;

      if v_sale_item_id is null then
        raise exception 'The drug sale line could not be found for discount recording'
          using errcode = 'P0001';
      end if;

      insert into public.sale_item_discounts
        (sale_item_id, original_unit_price, discount_percent, discount_amount)
      values
        (v_sale_item_id, v_original, round(v_discount / v_original * 100, 2), v_discount)
      on conflict (sale_item_id) do update
        set original_unit_price = excluded.original_unit_price,
            discount_percent    = excluded.discount_percent,
            discount_amount     = excluded.discount_amount;
    end if;
  end loop;

  return v_sale_id;
end;
$$;

notify pgrst, 'reload schema';