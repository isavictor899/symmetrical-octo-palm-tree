-- Sales review: nothing a till sold is lost, and unusual sales get a second look.
--
-- 1. Held sales. When the server rejects an offline sale under a business rule
--    (too old, out of stock, price changed...), the till used to mark it
--    "failed" on that one device, where only a Delete button was offered. The
--    medicine had already been handed over, so the books silently lost it.
--    Now the till sends the rejected sale here instead. An admin, on any
--    device, approves it (it is recorded as a sale) or voids it with a reason.
-- 2. Sales to check. The till says who made each sale and when. The server can
--    check those values are plausible, but not that they are true, so sales
--    recorded well after their sale time, or uploaded by someone other than
--    the person credited, are listed for an admin to confirm.
-- 3. Org admins can record sales for any shop in their organization. The app
--    already let an admin upload another shop's offline sales, but the server
--    refused them; approval of held sales needs the same permission.

-- ---------------------------------------------------------------------------
-- 3. Who may record a sale for a shop
-- ---------------------------------------------------------------------------
create or replace function public.sale_actor_staff_id(p_shop_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
    from public.staff s
    join public.shops own on own.id = s.shop_id
   where s.auth_user_id = auth.uid()
     and s.is_active
     and (
       s.shop_id = p_shop_id
       or (s.role = 'admin'
           and exists (select 1 from public.shops target
                        where target.id = p_shop_id
                          and target.organization_id = own.organization_id))
     )
   order by (s.shop_id = p_shop_id) desc, s.id
   limit 1;
$$;
revoke all on function public.sale_actor_staff_id(uuid) from public, anon, authenticated;

-- sell_stock and sell_stock_and_equipment looked the caller up as staff of
-- that exact shop. Swap that lookup for sale_actor_staff_id(). Each function
-- must contain the lookup exactly once, or the migration stops.
do $$
declare
  v_fn record;
  v_def text;
  v_new text;
  v_pattern constant text := 'select\s+id\s+into\s+v_staff_id\s+from\s+public\.staff\s+where\s+auth_user_id\s*=\s*auth\.uid\(\)\s+and\s+shop_id\s*=\s*p_shop_id\s*;';
begin
  for v_fn in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sell_stock', 'sell_stock_and_equipment')
       and p.prokind = 'f'
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    if (select count(*) from regexp_matches(v_def, v_pattern, 'g')) <> 1 then
      raise exception 'Expected one staff lookup in %, found a different number. Not patched.', v_fn.proname;
    end if;
    v_new := regexp_replace(v_def, v_pattern, 'v_staff_id := public.sale_actor_staff_id(p_shop_id);');
    execute v_new;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Held sales
-- ---------------------------------------------------------------------------
create table if not exists public.held_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.shops(id),
  client_sale_id uuid not null unique,
  payload jsonb not null,
  total_amount numeric not null default 0,
  claimed_sold_at timestamptz,
  claimed_by uuid,
  error_message text not null,
  held_by uuid not null,
  held_at timestamptz not null default now(),
  attempts integer not null default 1,
  status text not null default 'pending' check (status in ('pending', 'approved', 'voided')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  sale_id uuid references public.sales(id),
  check (status = 'pending' or (resolved_by is not null and resolved_at is not null)),
  check (status <> 'approved' or sale_id is not null),
  check (status <> 'voided' or length(btrim(coalesce(resolution_note, ''))) >= 5)
);
create index if not exists held_sales_org_status_idx on public.held_sales (organization_id, status, held_at desc);

alter table public.held_sales enable row level security;
revoke all on public.held_sales from public, anon, authenticated;
grant select on public.held_sales to authenticated;
drop policy if exists held_sales_admin_read on public.held_sales;
create policy held_sales_admin_read on public.held_sales
  for select to authenticated
  using (organization_id = public.my_organization_id() and public.current_user_is_admin());

alter table public.sales add column if not exists checked_by uuid;
alter table public.sales add column if not exists checked_at timestamptz;

-- The organization of the calling admin, or an error.
create or replace function public.review_admin_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select sh.organization_id into v_org
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = auth.uid()
     and s.is_active
     and s.role = 'admin'
   limit 1;
  if v_org is null then
    raise exception 'Administrator access is required to review sales.' using errcode = 'P0001';
  end if;
  return v_org;
end;
$$;
revoke all on function public.review_admin_organization() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sale itself. Shared by the till upload (checked) and admin approval
-- (trusted: an admin has looked at it, so the age limit, the deactivated-
-- cashier rule and the "price changed since" rule are not applied).
-- ---------------------------------------------------------------------------
create or replace function public.record_sale_with_discounts(
  p_shop_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_client_sale_id uuid,
  p_prescription_reference text,
  p_prescriber_name text,
  p_prescription_date date,
  p_created_by_user_id uuid,
  p_sold_at timestamptz,
  p_trusted boolean
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
  -- (device clock running fast) is clamped to now rather than rejected.
  if not p_trusted and p_sold_at is not null and p_sold_at < now() - interval '7 days' then
    raise exception 'The recorded sale time is more than 7 days old. An administrator can approve it under Sales review.'
      using errcode = 'P0001';
  end if;
  v_sold_at := least(p_sold_at, now());

  -- Validate every drug line before any stock is touched.
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

    if v_original <> v_batch_price and not p_trusted then
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

  -- Attribution, also before any stock is touched.
  if p_created_by_user_id is not null then
    -- The originator must belong to the selling shop. A cashier deactivated
    -- after the sale is matched through former_auth_user_id.
    select * into v_creator
      from public.staff
     where shop_id = p_shop_id
       and (auth_user_id = p_created_by_user_id or former_auth_user_id = p_created_by_user_id)
     order by (auth_user_id = p_created_by_user_id) desc nulls last, id
     limit 1;

    if v_creator.id is null and not p_trusted then
      raise exception 'The staff member who recorded this sale is not assigned to this shop.'
        using errcode = 'P0001';
    end if;

    -- A deactivated cashier's sale only counts if it happened while they
    -- were still active.
    if not p_trusted
       and v_creator.auth_user_id is distinct from p_created_by_user_id
       and (v_sold_at is null
            or v_creator.deactivated_at is null
            or v_sold_at > v_creator.deactivated_at) then
      raise exception 'This sale was recorded after the staff member''s account was deactivated.'
        using errcode = 'P0001';
    end if;
  end if;

  -- The sale itself: stock checks, equipment, idempotency, the prescription
  -- trigger and the sale_items price guard all run inside this call.
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

  -- Record each money discount on its own sale line: one with the same batch,
  -- quantity and price that has no discount yet. A batch that appears twice in
  -- one sale (once discounted, once not) used to get the discount on whichever
  -- line came first.
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
         and not exists (select 1 from public.sale_item_discounts sid where sid.sale_item_id = si.id)
       order by (si.quantity = (v_item->>'quantity')::integer
                 and round(si.unit_price, 2) = round(coalesce((v_item->>'unit_price')::numeric, v_original - v_discount), 2)) desc,
                si.id
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
revoke all on function public.record_sale_with_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz, boolean) from public, anon, authenticated;

-- The till's upload: same signature as before, all checks on.
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
language sql
security definer
set search_path = public
as $$
  select public.record_sale_with_discounts(
    p_shop_id, p_payment_method, p_items, p_client_sale_id,
    p_prescription_reference, p_prescriber_name, p_prescription_date,
    p_created_by_user_id, p_sold_at, false
  );
$$;
revoke all on function public.sell_stock_with_amount_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz) from public, anon;
grant execute on function public.sell_stock_with_amount_discounts(uuid, text, jsonb, uuid, text, text, date, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- The till hands over a sale the server rejected.
-- Returns 'recorded' if the sale is already on the server, otherwise 'held'.
-- Either way the till can drop its local copy.
-- ---------------------------------------------------------------------------
create or replace function public.hold_rejected_sale(
  p_shop_id uuid,
  p_client_sale_id uuid,
  p_payload jsonb,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_items jsonb;
  v_total numeric;
begin
  if public.sale_actor_staff_id(p_shop_id) is null then
    raise exception 'You are not permitted to send sales for this shop.' using errcode = 'P0001';
  end if;
  if p_client_sale_id is null then
    raise exception 'The sale has no ID.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales where client_sale_id = p_client_sale_id and shop_id = p_shop_id) then
    return 'recorded';
  end if;

  v_items := p_payload->'p_items';
  if jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) = 0
     or jsonb_array_length(v_items) > 200
     or length(p_payload::text) > 100000 then
    raise exception 'The held sale is incomplete.' using errcode = 'P0001';
  end if;

  select organization_id into v_org from public.shops where id = p_shop_id;
  select coalesce(sum(coalesce((i->>'quantity')::numeric, 0) * coalesce((i->>'unit_price')::numeric, 0)), 0)
    into v_total
    from jsonb_array_elements(v_items) i;

  insert into public.held_sales (
    organization_id, shop_id, client_sale_id, payload, total_amount,
    claimed_sold_at, claimed_by, error_message, held_by
  ) values (
    v_org, p_shop_id, p_client_sale_id, p_payload, v_total,
    nullif(p_payload->>'p_sold_at', '')::timestamptz,
    nullif(p_payload->>'p_created_by_user_id', '')::uuid,
    left(coalesce(nullif(btrim(p_error), ''), 'Rejected by the server.'), 500),
    auth.uid()
  )
  on conflict (client_sale_id) do update
    set attempts = held_sales.attempts + 1,
        error_message = case when held_sales.status = 'pending' then excluded.error_message else held_sales.error_message end
    where held_sales.shop_id = excluded.shop_id;

  return 'held';
end;
$$;
revoke all on function public.hold_rejected_sale(uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.hold_rejected_sale(uuid, uuid, jsonb, text) to authenticated;

-- Staff display name for a login, including a deactivated one.
create or replace function public.staff_name_for_login(p_login uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select full_name from public.staff
   where p_login is not null and (auth_user_id = p_login or former_auth_user_id = p_login)
   order by (auth_user_id = p_login) desc nulls last
   limit 1;
$$;
revoke all on function public.staff_name_for_login(uuid) from public, anon, authenticated;

create or replace function public.held_sales_list(p_status text default 'pending')
returns table (
  id uuid,
  shop_id uuid,
  shop_name text,
  receipt_no text,
  total_amount numeric,
  payment_method text,
  claimed_sold_at timestamptz,
  claimed_by_name text,
  held_by_name text,
  held_at timestamptz,
  attempts integer,
  error_message text,
  items jsonb,
  prescription_reference text,
  status text,
  resolved_by_name text,
  resolved_at timestamptz,
  resolution_note text,
  sale_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.review_admin_organization();
begin
  return query
  select h.id, h.shop_id, sh.name, upper(left(h.client_sale_id::text, 8)), h.total_amount,
         h.payload->>'p_payment_method',
         h.claimed_sold_at,
         public.staff_name_for_login(h.claimed_by),
         public.staff_name_for_login(h.held_by),
         h.held_at, h.attempts, h.error_message,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'name', coalesce(d.name, e.name, 'Unknown item'),
                    'quantity', (i->>'quantity')::numeric,
                    'unit_price', (i->>'unit_price')::numeric)), '[]'::jsonb)
            from jsonb_array_elements(h.payload->'p_items') i
            left join public.drugs d on d.id = nullif(i->>'drug_id', '')::uuid
            left join public.equipment_supplies e on e.id = nullif(i->>'equipment_supply_id', '')::uuid),
         h.payload->>'p_prescription_reference',
         h.status,
         public.staff_name_for_login(h.resolved_by),
         h.resolved_at, h.resolution_note, h.sale_id
    from public.held_sales h
    join public.shops sh on sh.id = h.shop_id
   where h.organization_id = v_org
     and (p_status is null or h.status = p_status)
   order by h.held_at desc
   limit 200;
end;
$$;
revoke all on function public.held_sales_list(text) from public, anon;
grant execute on function public.held_sales_list(text) to authenticated;

create or replace function public.approve_held_sale(p_held_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.review_admin_organization();
  v_held public.held_sales;
  v_sale_id uuid;
begin
  select * into v_held from public.held_sales where id = p_held_id and organization_id = v_org for update;
  if v_held.id is null then
    raise exception 'That held sale was not found.' using errcode = 'P0001';
  end if;
  if v_held.status <> 'pending' then
    raise exception 'That held sale has already been %.', v_held.status using errcode = 'P0001';
  end if;

  v_sale_id := public.record_sale_with_discounts(
    v_held.shop_id,
    v_held.payload->>'p_payment_method',
    v_held.payload->'p_items',
    v_held.client_sale_id,
    nullif(v_held.payload->>'p_prescription_reference', ''),
    nullif(v_held.payload->>'p_prescriber_name', ''),
    nullif(v_held.payload->>'p_prescription_date', '')::date,
    v_held.claimed_by,
    v_held.claimed_sold_at,
    true
  );

  -- The admin has looked at it, so it does not also need "Sales to check".
  update public.sales set checked_by = auth.uid(), checked_at = now() where id = v_sale_id;

  update public.held_sales
     set status = 'approved', sale_id = v_sale_id, resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where id = v_held.id;
  return v_sale_id;
end;
$$;
revoke all on function public.approve_held_sale(uuid, text) from public, anon;
grant execute on function public.approve_held_sale(uuid, text) to authenticated;

create or replace function public.void_held_sale(p_held_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.review_admin_organization();
  v_held public.held_sales;
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason of at least 5 characters for voiding this sale.' using errcode = 'P0001';
  end if;
  select * into v_held from public.held_sales where id = p_held_id and organization_id = v_org for update;
  if v_held.id is null then
    raise exception 'That held sale was not found.' using errcode = 'P0001';
  end if;
  if v_held.status <> 'pending' then
    raise exception 'That held sale has already been %.', v_held.status using errcode = 'P0001';
  end if;
  update public.held_sales
     set status = 'voided', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = left(btrim(p_reason), 500)
   where id = v_held.id;
end;
$$;
revoke all on function public.void_held_sale(uuid, text) from public, anon;
grant execute on function public.void_held_sale(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Sales to check
-- ---------------------------------------------------------------------------
create or replace function public.sales_to_check(p_days integer default 30)
returns table (
  id uuid,
  shop_name text,
  receipt_no text,
  total_amount numeric,
  payment_method text,
  sold_at timestamptz,
  recorded_at timestamptz,
  credited_name text,
  uploaded_by_name text,
  is_late boolean,
  is_reassigned boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.review_admin_organization();
begin
  return query
  select s.id, sh.name, upper(left(coalesce(s.client_sale_id, s.id)::text, 8)), s.total_amount, s.payment_method,
         s.sold_at, s.recorded_at, st.full_name, public.staff_name_for_login(s.synced_by),
         s.recorded_at > s.sold_at + interval '15 minutes',
         s.synced_by is not null and s.synced_by is distinct from coalesce(st.auth_user_id, st.former_auth_user_id)
    from public.sales s
    join public.shops sh on sh.id = s.shop_id
    left join public.staff st on st.id = s.staff_id
   where sh.organization_id = v_org
     and s.recorded_at is not null
     and s.checked_at is null
     and s.recorded_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366))
     and (s.recorded_at > s.sold_at + interval '15 minutes'
          or (s.synced_by is not null and s.synced_by is distinct from coalesce(st.auth_user_id, st.former_auth_user_id)))
   order by s.recorded_at desc
   limit 200;
end;
$$;
revoke all on function public.sales_to_check(integer) from public, anon;
grant execute on function public.sales_to_check(integer) to authenticated;

create or replace function public.mark_sales_checked(p_sale_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.review_admin_organization();
  v_count integer;
begin
  if coalesce(cardinality(p_sale_ids), 0) = 0 or cardinality(p_sale_ids) > 200 then
    raise exception 'Choose between 1 and 200 sales.' using errcode = 'P0001';
  end if;
  update public.sales s
     set checked_by = auth.uid(), checked_at = now()
    from public.shops sh
   where sh.id = s.shop_id
     and sh.organization_id = v_org
     and s.id = any(p_sale_ids)
     and s.checked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_sales_checked(uuid[]) from public, anon;
grant execute on function public.mark_sales_checked(uuid[]) to authenticated;

-- Numbers for the menu badge. Non-admins get zeros rather than an error.
create or replace function public.sales_review_counts()
returns table (held integer, to_check integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select sh.organization_id into v_org
    from public.staff s join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = auth.uid() and s.is_active and s.role = 'admin'
   limit 1;
  if v_org is null then
    return query select 0, 0;
    return;
  end if;
  return query
  select (select count(*)::int from public.held_sales h where h.organization_id = v_org and h.status = 'pending'),
         (select count(*)::int from public.sales_to_check(30));
end;
$$;
revoke all on function public.sales_review_counts() from public, anon;
grant execute on function public.sales_review_counts() to authenticated;

notify pgrst, 'reload schema';