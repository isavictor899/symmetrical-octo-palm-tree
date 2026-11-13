-- =============================================================================
-- CRITICAL #5: the anon role could execute every RPC in the public schema
-- =============================================================================
-- Found by docs/security/verify-rls.sql section 5. PostgreSQL grants EXECUTE
-- on new functions to PUBLIC by default, and the anon key ships inside the
-- browser bundle. The audit showed:
--
--   sell_stock, receive_stock, write_off_expired_stock,
--   transfer_stock_between_shops, create_shop_drug,
--   set_shop_drug_prescription_status, create_equipment_supply,
--   receive_equipment_supply, generate_restock_insights, ...
--
-- Most of these check staff membership internally (auth.uid() is null for an
-- anonymous caller), so this is primarily defence in depth. It is still worth
-- closing: set_shop_drug_prescription_status can downgrade a prescription-only
-- drug, and a single missing check would be enough to abuse the rest.
--
-- This migration revokes the implicit PUBLIC grant, keeps the authenticated and
-- service roles working, and records the same rule as a default privilege so
-- future functions cannot silently regress.
-- =============================================================================

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')   -- functions and procedures, not aggregates
  loop
    execute format('revoke all on function %s from public, anon', fn.signature);
    execute format('grant execute on function %s to authenticated, service_role', fn.signature);
  end loop;
end $$;


-- No anonymous caller has any business reading or writing a business table.
-- RLS already hides the rows, but an explicit revoke means a future RLS mistake
-- does not turn straight into a data leak.
do $$
declare
  tbl record;
begin
  for tbl in
    select schemaname, tablename
      from pg_tables
     where schemaname = 'public'
  loop
    execute format('revoke all on table %I.%I from anon', tbl.schemaname, tbl.tablename);
  end loop;
end $$;


-- Applies to functions created later by the same role (the Supabase SQL editor
-- runs as postgres), so the default cannot quietly come back.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

notify pgrst, 'reload schema';
