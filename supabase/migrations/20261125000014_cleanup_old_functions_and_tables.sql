-- Clean-up after the security review.
--
-- 1. Old versions of functions. When a function gained a parameter, the old
--    version was left behind and stayed callable. Old versions skip newer
--    checks (that is how the direct-sale pricing hole happened), so:
--    * removed: versions nothing calls any more;
--    * kept but internal-only: the 11-argument receive_stock, which the
--      current receive_stock and purchase-order receiving call internally.
-- 2. Two functions without a fixed search_path get an empty one (their bodies
--    already use fully qualified names).
-- 3. Tables the app only reaches through server functions: stray read grants
--    removed and the intent recorded on each table.
-- 4. The backup made during the stock-ledger repair moves to a private
--    "archive" schema the API cannot reach, instead of being deleted outright.

-- 1. Old function versions --------------------------------------------------
drop function if exists public.receive_equipment_supply(uuid, uuid, integer, numeric, text, text);
drop function if exists public.receive_purchase_order_item(uuid, integer, text, date, numeric, numeric, uuid, boolean);
drop function if exists public.sell_stock_with_discounts(uuid, text, jsonb, uuid, text, text, date);

revoke execute on function public.receive_stock(uuid, uuid, uuid, text, text, date, numeric, numeric, integer, uuid, boolean)
  from public, anon, authenticated;

-- 2. Fixed search_path -------------------------------------------------------
alter function public.max_discount_percent(text) set search_path = '';
alter function public.enforce_private_drug_scope() set search_path = '';

-- 3. Server-function-only tables --------------------------------------------
revoke select on public.drug_generic_equivalents from authenticated;
revoke select on public.equipment_supply_receipts from authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'ai_insight_calls', 'cash_register_sessions', 'drug_generic_equivalents',
    'equipment_supply_receipts', 'finance_entries', 'purchase_order_items',
    'purchase_order_receipts', 'purchase_orders', 'stock_ledger_repairs', 'supplier_debts'
  ] loop
    execute format(
      'comment on table public.%I is %L', v_table,
      'Server-function only: row level security is on with no policies on purpose. Read and write it through the SECURITY DEFINER functions, never directly.'
    );
  end loop;
end;
$$;

-- 4. Archive the ledger-repair backup ---------------------------------------
create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
alter table public.stock_movements_sold_duplicates_backup set schema archive;
comment on table archive.stock_movements_sold_duplicates_backup is
  'Duplicate "sold" stock movements removed during the November 2026 stock-ledger repair (70 rows). Kept for audit; safe to drop.';

notify pgrst, 'reload schema';