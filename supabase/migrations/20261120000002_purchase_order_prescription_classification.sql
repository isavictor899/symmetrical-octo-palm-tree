-- Fix purchase-order receiving to use the deployed receive_stock signature
-- and persist the shop-specific POM/OTC choice in shop_drugs.
-- No table or column changes are needed.

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
  v_requires_prescription boolean;
begin
  if p_client_batch_id is null then
    raise exception 'A receipt request ID is required.' using errcode = 'P0001';
  end if;

  select * into v_item
    from public.purchase_order_items
   where id = p_purchase_order_item_id
   for update;
  if v_item.id is null then
    raise exception 'Purchase-order line was not found.' using errcode = 'P0001';
  end if;

  select * into v_order
    from public.purchase_orders
   where id = v_item.purchase_order_id
   for update;
  if not public.purchase_order_actor_can_manage(v_order.shop_id) then
    raise exception 'You do not have permission to receive this order.' using errcode = 'P0001';
  end if;

  -- Check retries only after authorization, and bind an idempotency key to its
  -- original order line so the same request cannot be reused elsewhere.
  select * into v_existing_receipt
    from public.purchase_order_receipts
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

  -- Reserve the idempotency key before calling receive_stock. If stock
  -- validation fails, PostgreSQL rolls this reservation back with the call.
  insert into public.purchase_order_receipts (purchase_order_item_id, client_batch_id, quantity, received_by)
  values (v_item.id, p_client_batch_id, p_quantity, auth.uid())
  returning id into v_receipt_id;

  select coalesce((select s.name from public.suppliers s where s.id = v_order.supplier_id), v_order.supplier_name)
    into v_supplier_name;

  -- receive_stock currently accepts ten arguments; classification is recorded
  -- below against the same per-shop drug row that receive_stock creates.
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
    p_client_batch_id => p_client_batch_id
  );

  if p_initial_requires_prescription is not null then
    insert into public.shop_drugs as current_shop_drug (shop_id, drug_id, requires_prescription)
    values (v_order.shop_id, v_item.drug_id, p_initial_requires_prescription)
    on conflict (shop_id, drug_id) do update
      set requires_prescription = coalesce(
        current_shop_drug.requires_prescription,
        excluded.requires_prescription
      );
  end if;

  select requires_prescription into v_requires_prescription
    from public.shop_drugs
   where shop_id = v_order.shop_id
     and drug_id = v_item.drug_id;
  if p_initial_requires_prescription is not null
     and v_requires_prescription is distinct from p_initial_requires_prescription then
    raise exception 'This shop''s classification changed while you were receiving stock. Reopen the receipt and confirm the current POM/OTC value.' using errcode = 'P0001';
  end if;
  if v_requires_prescription is null then
    raise exception 'Choose POM or OTC before receiving this drug for the shop.' using errcode = 'P0001';
  end if;

  update public.purchase_order_items
     set quantity_received = quantity_received + p_quantity
   where id = v_item.id;
  update public.purchase_orders
     set status = case
       when exists (
         select 1 from public.purchase_order_items
          where purchase_order_id = v_order.id
            and quantity_received < quantity_ordered
       ) then 'partial'
       else 'received'
     end
   where id = v_order.id;

  return v_receipt_id;
end;
$$;

revoke all on function public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) from public, anon;
grant execute on function public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
