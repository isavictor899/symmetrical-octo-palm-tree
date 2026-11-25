-- 20261125000002_stock_integrity_and_returns.sql
alter table public.batches
  add constraint batches_quantity_remaining_nonneg
  check (quantity_remaining >= 0) not valid;   -- run "validate constraint" after the stock take

alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('received','sold','adjustment','transfer_out','transfer_in','write_off','return'));

create or replace function public.return_sold_drug(
  p_sale_item_id uuid, p_quantity integer, p_refund_method text,
  p_reason text default 'Customer return', p_client_return_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff; v_sale_item public.sale_items; v_sale public.sales; v_batch public.batches;
  v_returned integer; v_available integer; v_existing uuid;
  v_return_id uuid := gen_random_uuid(); v_refund numeric; v_is_admin boolean;
  v_method text := lower(trim(coalesce(p_refund_method, '')));
begin
  select * into v_staff from public.staff where auth_user_id = auth.uid();
  if v_staff.id is null then raise exception 'A staff account is required.' using errcode='P0001'; end if;
  v_is_admin := v_staff.role = 'admin';
  if not (v_is_admin or v_staff.role in ('pharmacist','manager')) then
    raise exception 'Only a pharmacist, manager or administrator can process a return.' using errcode='P0001';
  end if;

  if p_client_return_id is not null then
    select id into v_existing from public.sales_returns
     where client_return_id = p_client_return_id and shop_id = v_staff.shop_id;
    if v_existing is not null then return v_existing; end if;
  end if;

  if p_quantity is null or p_quantity < 1 then raise exception 'Return quantity must be greater than zero' using errcode='P0001'; end if;
  if v_method not in ('cash','mpesa','card','insurance','sha') then raise exception 'Choose a supported refund method' using errcode='P0001'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason for the return' using errcode='P0001'; end if;

  select * into v_sale_item from public.sale_items where id = p_sale_item_id for update;
  if v_sale_item.id is null then raise exception 'The original sale item was not found' using errcode='P0001'; end if;
  select * into v_sale from public.sales where id = v_sale_item.sale_id;
  if v_sale.shop_id is distinct from v_staff.shop_id then raise exception 'You cannot return an item from another shop' using errcode='P0001'; end if;

  if not v_is_admin and v_sale.sold_at < now() - interval '7 days' then
    raise exception 'Returns older than 7 days need an administrator.' using errcode='P0001';
  end if;
  if not v_is_admin and v_method <> v_sale.payment_method then
    raise exception 'Refund must use the original payment method (%).', v_sale.payment_method using errcode='P0001';
  end if;

  select coalesce(sum(ri.quantity),0)::integer into v_returned
    from public.sales_return_items ri where ri.original_sale_item_id = p_sale_item_id;
  v_available := v_sale_item.quantity - v_returned;
  if p_quantity > v_available then raise exception 'Only % unit(s) remain eligible for return', v_available using errcode='P0001'; end if;

  select * into v_batch from public.batches
   where id = v_sale_item.batch_id and shop_id = v_sale.shop_id for update;
  if v_batch.id is null then raise exception 'The original batch could not be found' using errcode='P0001'; end if;

  v_refund := p_quantity * v_sale_item.unit_price;
  insert into public.sales_returns (id, client_return_id, shop_id, sale_id, staff_id, refund_method, reason, total_amount)
  values (v_return_id, p_client_return_id, v_sale.shop_id, v_sale.id, v_staff.id, v_method, trim(p_reason), v_refund);
  insert into public.sales_return_items (return_id, original_sale_item_id, quantity, refund_unit_price)
  values (v_return_id, p_sale_item_id, p_quantity, v_sale_item.unit_price);

  -- Only unexpired batches go back on the shelf; expired returns are refunded but not restocked.
  -- Policy question for you and the PPB: should dispensed medicine be restocked at all?
  if v_batch.expiry_date >= (now() at time zone 'Africa/Nairobi')::date then
    update public.batches set quantity_remaining = quantity_remaining + p_quantity where id = v_batch.id;
    insert into public.stock_movements (shop_id, drug_id, batch_id, movement_type, quantity, reference_id)
    values (v_sale.shop_id, v_sale_item.drug_id, v_batch.id, 'return', p_quantity, v_return_id);
  end if;
  return v_return_id;
end;
$$;
revoke all on function public.return_sold_drug(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.return_sold_drug(uuid, integer, text, text, uuid) to authenticated;