-- =============================================================================
-- CRITICAL #4: Offline sales attributed to the right person, and fixed-amount
--              discounts recorded exactly.
-- =============================================================================
-- Two problems solved in one wrapper RPC:
--
--  1. ATTRIBUTION. pending_sales.created_by_user_id was never sent to the
--     server, so sales.staff_id came from auth.uid() at sync time. Because the
--     local-only outbox survives sign-out, a sale queued by User A and flushed
--     by User B's session was recorded against B. sold_at was also the sync
--     time instead of the dispensing time.
--
--  2. DISCOUNT AS MONEY. sell_stock_with_discounts only accepts a percentage,
--     which cannot represent an exact KES amount (e.g. KES 0.01 off a KES 3.00
--     item has no exact percentage). This RPC validates the money amount and
--     records it directly.
--
-- sell_stock_with_discounts is left untouched, so an older cached PWA that
-- still calls it keeps working (with percentage discounts) or a percentage-based
-- fallback. The new client calls sell_stock_with_amount_discounts.
-- =============================================================================

create or replace function public.sell_stock_with_amount_discounts(
  p_shop_id                uuid,
  p_payment_method         text,
  p_items                  jsonb,
  p_client_sale_id         uuid        default null,
  p_prescription_reference text        default null,
  p_prescriber_name        text        default null,
  p_prescription_date      date        default null,
  p_created_by_user_id     uuid        default null,
  p_sold_at                timestamptz default null
) returns uuid
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
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must include at least one item'
      using errcode = 'P0001';
  end if;

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

  -- ---------------------------------------------------------------------------
  -- Attribution
  -- ---------------------------------------------------------------------------
  select * into v_caller
    from public.staff
   where auth_user_id = auth.uid()
   order by id
   limit 1;

  if v_caller.id is null then
    raise exception 'A staff account is required to record a sale.'
      using errcode = 'P0001';
  end if;

  if p_created_by_user_id is null then
    if p_sold_at is not null then
      update public.sales set sold_at = p_sold_at where id = v_sale_id;
    end if;
  else
    -- The originator must genuinely belong to the selling shop, so a till
    -- cannot attribute a sale to a colleague in another shop.
    select * into v_creator
      from public.staff
     where auth_user_id = p_created_by_user_id
       and shop_id      = p_shop_id
     order by id
     limit 1;

    if v_creator.id is null then
      raise exception 'The staff member who recorded this sale is not assigned to this shop.'
        using errcode = 'P0001';
    end if;

    -- An offline till may sync days later, but not months later. A future
    -- timestamp (device clock skew) is clamped rather than rejected, so a sale
    -- is never lost over a few minutes of clock drift.
    if p_sold_at is not null
       and p_sold_at < now() - interval '90 days' then
      raise exception 'The recorded sale time is more than 90 days old. Check the till clock and retry.'
        using errcode = 'P0001';
    end if;

    update public.sales
       set staff_id = v_creator.id,
           sold_at  = least(coalesce(p_sold_at, sold_at), now())
     where id = v_sale_id;
  end if;

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

comment on function public.sell_stock_with_amount_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz) is
  'Records a sale with fixed-amount discounts, attributing it to the staff member who created it offline and preserving the dispensing time.';

revoke all on function public.sell_stock_with_amount_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz)
  from public, anon;
grant execute on function public.sell_stock_with_amount_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz)
  to authenticated;


-- -----------------------------------------------------------------------------
-- Confirmation view: sales grouped by staff member and day.
-- -----------------------------------------------------------------------------
create or replace view public.sales_by_staff_daily
with (security_invoker = true) as
select
  sh.name                           as shop_name,
  coalesce(st.full_name, 'Unknown') as staff_name,
  st.role                           as staff_role,
  s.sold_at::date                   as sale_date,
  count(*)                          as sale_count,
  round(sum(s.total_amount), 2)     as total_amount
from public.sales s
join public.shops sh      on sh.id = s.shop_id
left join public.staff st on st.id = s.staff_id
group by sh.name, st.full_name, st.role, s.sold_at::date
order by s.sold_at::date desc, total_amount desc;

revoke all on public.sales_by_staff_daily from public, anon;
grant select on public.sales_by_staff_daily to authenticated;
