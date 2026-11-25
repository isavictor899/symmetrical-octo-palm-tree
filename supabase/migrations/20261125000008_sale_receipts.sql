-- Receipt reprints: recent sales for one shop, shaped for printing.
-- Any active staff member of the shop (or an admin of its organization) may
-- reprint. Returns no patient data beyond what is already on the receipt.

create or replace function public.sale_receipts(
  p_shop_id uuid,
  p_search text default null,
  p_limit integer default 40
)
returns table (
  sale_id uuid,
  receipt_no text,
  sold_at timestamptz,
  payment_method text,
  total_amount numeric,
  served_by text,
  prescription_reference text,
  prescriber_name text,
  prescription_date date,
  items jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_search text := upper(regexp_replace(coalesce(p_search, ''), '[^A-Za-z0-9]', '', 'g'));
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 100);
begin
  if not exists (
    select 1
      from public.staff s
      join public.shops own_shop on own_shop.id = s.shop_id
      join public.shops target on target.id = p_shop_id
     where s.auth_user_id = auth.uid()
       and s.is_active
       and (s.shop_id = p_shop_id
            or (s.role = 'admin' and own_shop.organization_id = target.organization_id))
  ) then
    raise exception 'You cannot view receipts for this shop.' using errcode = 'P0001';
  end if;

  return query
  select
    sa.id,
    upper(left(replace(coalesce(sa.client_sale_id, sa.id)::text, '-', ''), 8)),
    sa.sold_at,
    sa.payment_method,
    sa.total_amount,
    st.full_name,
    sa.prescription_reference,
    sa.prescriber_name,
    sa.prescription_date,
    coalesce((
      select jsonb_agg(line order by line->>'name')
        from (
          select jsonb_build_object(
                   'name', d.name,
                   'qty', si.quantity,
                   'unitPrice', si.unit_price,
                   'originalUnitPrice', coalesce(sid.original_unit_price, si.unit_price)) as line
            from public.sale_items si
            join public.drugs d on d.id = si.drug_id
            left join public.sale_item_discounts sid on sid.sale_item_id = si.id
           where si.sale_id = sa.id
          union all
          select jsonb_build_object(
                   'name', es.name,
                   'qty', esi.quantity,
                   'unitPrice', esi.unit_price,
                   'originalUnitPrice', esi.unit_price)
            from public.equipment_sale_items esi
            join public.equipment_supplies es on es.id = esi.equipment_supply_id
           where esi.sale_id = sa.id
        ) lines
    ), '[]'::jsonb)
  from public.sales sa
  left join public.staff st on st.id = sa.staff_id
  where sa.shop_id = p_shop_id
    and (v_search = ''
         or upper(replace(coalesce(sa.client_sale_id, sa.id)::text, '-', '')) like v_search || '%')
  order by sa.sold_at desc
  limit v_limit;
end;
$$;

revoke all on function public.sale_receipts(uuid, text, integer) from public, anon;
grant execute on function public.sale_receipts(uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';