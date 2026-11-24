create or replace function public.finance_transaction_list(
  p_shop_id uuid,
  p_kind text default 'all',
  p_start date default null,
  p_end date default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.finance_actor_can_access(p_shop_id) then
    raise exception 'You do not have access to this shop''s financial records.' using errcode = 'P0001';
  end if;
  if p_kind not in ('all', 'income', 'expense') then
    raise exception 'Unknown financial transaction type.' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.occurred_at desc), '[]'::jsonb)
    into v_rows
    from (
      select s.id, 'income'::text as entry_type, 'sales'::text as category,
             'POS sale'::text as description, s.total_amount::numeric as amount,
             coalesce(s.payment_method, 'other') as payment_method, s.sold_at as occurred_at,
             'sale'::text as source_type
        from public.sales s
       where s.shop_id = p_shop_id
         and (p_start is null or s.sold_at >= (p_start::timestamp at time zone 'Africa/Nairobi'))
         and (p_end is null or s.sold_at < ((p_end + 1)::timestamp at time zone 'Africa/Nairobi'))
      union all
      select r.id, 'expense'::text as entry_type, 'refunds'::text as category,
             'Customer return'::text as description, r.total_amount::numeric as amount,
             coalesce(r.refund_method, 'other') as payment_method, r.created_at as occurred_at,
             'return'::text as source_type
        from public.sales_returns r
       where r.shop_id = p_shop_id
         and (p_start is null or r.created_at >= (p_start::timestamp at time zone 'Africa/Nairobi'))
         and (p_end is null or r.created_at < ((p_end + 1)::timestamp at time zone 'Africa/Nairobi'))
      union all
      select f.id, f.entry_type, f.category, f.description, f.amount, f.payment_method,
             f.occurred_at, coalesce(f.source_type, 'manual') as source_type
        from public.finance_entries f
       where f.shop_id = p_shop_id
         and (p_start is null or f.occurred_at >= (p_start::timestamp at time zone 'Africa/Nairobi'))
         and (p_end is null or f.occurred_at < ((p_end + 1)::timestamp at time zone 'Africa/Nairobi'))
    ) entry
   where p_kind = 'all' or entry.entry_type = p_kind;
  return v_rows;
end;
$$;

revoke all on function public.finance_transaction_list(uuid, text, date, date) from public, anon;
grant execute on function public.finance_transaction_list(uuid, text, date, date) to authenticated;
