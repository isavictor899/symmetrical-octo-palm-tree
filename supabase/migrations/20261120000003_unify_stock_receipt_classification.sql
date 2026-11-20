-- One classification-aware receiving path for ordinary receipts and purchase
-- order receipts. POM/OTC is stored per shop in shop_drugs.

create or replace function public.receive_stock(
  p_shop_id uuid,
  p_drug_id uuid,
  p_supplier_id uuid,
  p_supplier_name text,
  p_batch_number text,
  p_expiry_date date,
  p_cost_price numeric,
  p_selling_price numeric,
  p_quantity integer,
  p_client_batch_id uuid,
  p_initial_requires_prescription boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_supplier_id uuid;
  v_organization_id uuid;
  v_existing_classification boolean;
begin
  if not exists (
    select 1
      from public.staff s
      join public.shops actor_shop on actor_shop.id = s.shop_id
      join public.shops target_shop on target_shop.id = p_shop_id
     where s.auth_user_id = auth.uid()
       and (
         (
           lower(btrim(coalesce(s.role, ''))) in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin')
           and actor_shop.organization_id = target_shop.organization_id
         )
         or (
           lower(btrim(coalesce(s.role, ''))) in ('manager', 'pharmacist')
           and s.shop_id = p_shop_id
         )
       )
  ) then
    raise exception 'You are not permitted to receive stock for this shop' using errcode = 'P0001';
  end if;

  select organization_id into v_organization_id
    from public.shops where id = p_shop_id;
  if v_organization_id is null then
    raise exception 'Shop not found or has no organization' using errcode = 'P0001';
  end if;

  if p_client_batch_id is not null then
    select id into v_batch_id
      from public.batches
     where shop_id = p_shop_id
       and client_batch_id = p_client_batch_id;
    if v_batch_id is not null then
      return v_batch_id;
    end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Received quantity must be greater than zero' using errcode = 'P0001';
  end if;
  if p_cost_price is null or p_selling_price is null or p_cost_price < 0 or p_selling_price < 0 then
    raise exception 'Prices cannot be negative' using errcode = 'P0001';
  end if;
  if p_expiry_date is null or p_expiry_date < current_date then
    raise exception 'Expiry date cannot be in the past' using errcode = 'P0001';
  end if;

  select requires_prescription into v_existing_classification
    from public.shop_drugs
   where shop_id = p_shop_id
     and drug_id = p_drug_id
   limit 1;

  if v_existing_classification is null and p_initial_requires_prescription is null then
    raise exception 'Classify the drug as POM or OTC before adding it to stock.' using errcode = 'P0001';
  end if;
  if v_existing_classification is not null
     and p_initial_requires_prescription is not null
     and v_existing_classification is distinct from p_initial_requires_prescription then
    raise exception 'This drug is already classified for this shop. Change its classification from Stocked drugs.' using errcode = 'P0001';
  end if;

  v_supplier_id := p_supplier_id;
  if v_supplier_id is not null then
    if not exists (
      select 1 from public.suppliers
       where id = v_supplier_id
         and organization_id = v_organization_id
    ) then
      raise exception 'Selected supplier does not belong to this organization' using errcode = 'P0001';
    end if;
  else
    if nullif(btrim(coalesce(p_supplier_name, '')), '') is null then
      raise exception 'Select an existing supplier or enter a new supplier name' using errcode = 'P0001';
    end if;
    select id into v_supplier_id
      from public.suppliers
     where lower(name) = lower(btrim(p_supplier_name))
       and organization_id = v_organization_id
     limit 1;
    if v_supplier_id is null then
      insert into public.suppliers (name, organization_id)
      values (btrim(p_supplier_name), v_organization_id)
      returning id into v_supplier_id;
    end if;
  end if;

  insert into public.batches (
    shop_id, drug_id, supplier_id, batch_number, expiry_date,
    cost_price, selling_price, quantity_received, quantity_remaining, client_batch_id
  ) values (
    p_shop_id, p_drug_id, v_supplier_id, nullif(btrim(p_batch_number), ''), p_expiry_date,
    p_cost_price, p_selling_price, p_quantity, p_quantity, p_client_batch_id
  ) returning id into v_batch_id;

  insert into public.stock_movements (shop_id, drug_id, batch_id, movement_type, quantity)
  values (p_shop_id, p_drug_id, v_batch_id, 'received', p_quantity);

  insert into public.shop_drugs (shop_id, drug_id)
  values (p_shop_id, p_drug_id)
  on conflict (shop_id, drug_id) do nothing;

  if p_initial_requires_prescription is not null then
    update public.shop_drugs
       set requires_prescription = p_initial_requires_prescription
     where shop_id = p_shop_id
       and drug_id = p_drug_id
       and requires_prescription is null;
  end if;

  select requires_prescription into v_existing_classification
    from public.shop_drugs
   where shop_id = p_shop_id
     and drug_id = p_drug_id
   limit 1;
  if v_existing_classification is null then
    raise exception 'Classify the drug as POM or OTC before adding it to stock.' using errcode = 'P0001';
  end if;
  if p_initial_requires_prescription is not null
     and v_existing_classification is distinct from p_initial_requires_prescription then
    raise exception 'This drug classification changed while the receipt was being saved. Reopen the receipt and try again.' using errcode = 'P0001';
  end if;

  return v_batch_id;
end;
$$;

-- Keep older callers safe: they can receive only a drug that is already
-- classified, while all current app paths use the 11-argument function above.
create or replace function public.receive_stock(
  p_shop_id uuid,
  p_drug_id uuid,
  p_supplier_id uuid,
  p_supplier_name text,
  p_batch_number text,
  p_expiry_date date,
  p_cost_price numeric,
  p_selling_price numeric,
  p_quantity integer,
  p_client_batch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.receive_stock(
    p_shop_id, p_drug_id, p_supplier_id, p_supplier_name, p_batch_number,
    p_expiry_date, p_cost_price, p_selling_price, p_quantity,
    p_client_batch_id, null::boolean
  );
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
  v_existing_receipt public.purchase_order_receipts;
  v_receipt_id uuid;
begin
  if p_client_batch_id is null then
    raise exception 'A receipt request ID is required.' using errcode = 'P0001';
  end if;

  select * into v_item from public.purchase_order_items
   where id = p_purchase_order_item_id for update;
  if v_item.id is null then
    raise exception 'Purchase-order line was not found.' using errcode = 'P0001';
  end if;
  select * into v_order from public.purchase_orders
   where id = v_item.purchase_order_id for update;
  if not public.purchase_order_actor_can_manage(v_order.shop_id) then
    raise exception 'You do not have permission to receive this order.' using errcode = 'P0001';
  end if;

  select * into v_existing_receipt from public.purchase_order_receipts
   where client_batch_id = p_client_batch_id;
  if v_existing_receipt.id is not null then
    if v_existing_receipt.purchase_order_item_id <> v_item.id then
      raise exception 'This receipt request ID belongs to another order line.' using errcode = 'P0001';
    end if;
    return v_existing_receipt.id;
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'A cancelled purchase order cannot receive stock.' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Received quantity must be at least one unit.' using errcode = 'P0001';
  end if;
  v_remaining := v_item.quantity_ordered - v_item.quantity_received;
  if p_quantity > v_remaining then
    raise exception 'You can receive at most % remaining units on this purchase-order line.', v_remaining using errcode = 'P0001';
  end if;
  if exists (select 1 from public.batches where client_batch_id = p_client_batch_id) then
    raise exception 'This receipt request ID has already been used for a stock batch.' using errcode = 'P0001';
  end if;

  insert into public.purchase_order_receipts (purchase_order_item_id, client_batch_id, quantity, received_by)
  values (v_item.id, p_client_batch_id, p_quantity, auth.uid())
  returning id into v_receipt_id;

  select coalesce((select s.name from public.suppliers s where s.id = v_order.supplier_id), v_order.supplier_name)
    into v_supplier_name;
  perform public.receive_stock(
    p_shop_id => v_order.shop_id,
    p_drug_id => v_item.drug_id,
    p_supplier_id => v_order.supplier_id,
    p_supplier_name => v_supplier_name,
    p_batch_number => nullif(btrim(p_batch_number), ''),
    p_expiry_date => p_expiry_date,
    p_cost_price => p_cost_price,
    p_selling_price => p_selling_price,
    p_quantity => p_quantity,
    p_client_batch_id => p_client_batch_id,
    p_initial_requires_prescription => p_initial_requires_prescription
  );

  update public.purchase_order_items
     set quantity_received = quantity_received + p_quantity
   where id = v_item.id;
  update public.purchase_orders
     set status = case when exists (
       select 1 from public.purchase_order_items
        where purchase_order_id = v_order.id
          and quantity_received < quantity_ordered
     ) then 'partial' else 'received' end
   where id = v_order.id;
  return v_receipt_id;
end;
$$;

revoke all on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean) from public, anon;
grant execute on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean) to authenticated;
revoke all on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid) from public, anon;
grant execute on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid) to authenticated;
revoke all on function public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) from public, anon;
grant execute on function public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
