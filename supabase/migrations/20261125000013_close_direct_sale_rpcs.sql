-- Close a pricing hole: the low-level sale functions were callable directly.
--
-- sell_stock, sell_stock_and_equipment and the old sell_stock_with_discounts
-- accept any unit price up to the listed price and record no discount. A
-- signed-in cashier calling them directly (not through the app) could sell a
-- KSh 30 item for KSh 1, bypassing the discount limits and the discount audit.
-- The app only uses sell_stock_with_amount_discounts, which checks every price
-- against its discount and runs these as the database owner, so direct access
-- is not needed.

do $$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sell_stock', 'sell_stock_and_equipment', 'sell_stock_with_discounts')
       and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_fn.sig);
  end loop;
end;
$$;

notify pgrst, 'reload schema';