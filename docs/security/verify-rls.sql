-- =============================================================================
-- Pharmacy POS — database security check
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor. Read-only.
--
-- It is one query, because the SQL Editor only shows the last result of a
-- script. It returns one row per problem. A clean database returns a single
-- row: "OK — no findings".
--
-- When you add a server function the app should call, add its name to
-- app_callable below; when a table is meant to be reached only through server
-- functions, comment it with 'Server-function only: ...' (see migration
-- 20261125000014).
-- =============================================================================

with
app_callable(name) as (
  -- Server functions signed-in users are meant to call. Anything else that
  -- they can call is reported (an old version left behind, a helper that
  -- skips checks). The helpers marked * are used inside row-level policies
  -- and must stay callable.
  values
    ('approve_held_sale'), ('cash_register_current'), ('close_cash_register'),
    ('consume_insight_quota'), ('create_equipment_supply'), ('create_finance_entry'),
    ('create_purchase_order'), ('create_shop'), ('create_shop_drug'),
    ('current_user_is_admin'),          -- *
    ('finance_actor_can_access'), ('finance_actor_can_manage'),
    ('finance_transaction_list'), ('get_monthly_insight'), ('held_sales_list'),
    ('hold_rejected_sale'), ('link_drug_barcode'), ('mark_sales_checked'),
    ('my_organization_id'),             -- *
    ('open_cash_register'), ('pay_supplier_debt'), ('purchase_order_actor_can_manage'),
    ('purchase_order_list'), ('receive_equipment_supply'), ('receive_purchase_order_item'),
    ('receive_stock'), ('record_purchase_order_receipt_payment'), ('record_stock_count'),
    ('return_sold_drug'), ('sale_receipts'), ('sales_review_counts'), ('sales_to_check'),
    ('save_monthly_insight'), ('sell_stock_with_amount_discounts'),
    ('set_equipment_supply_selling_price'), ('set_shop_drug_prescription_status'),
    ('supplier_debt_list'), ('supplier_debt_summary'), ('transfer_stock_between_shops'),
    ('unlink_drug_barcode'), ('update_shop_details'), ('void_held_sale'),
    ('write_off_expired_stock'), ('get_my_subscription'),
    -- Enora Labs console: each one checks platform_admins itself.
    ('platform_is_admin'), ('platform_overview'), ('platform_organizations'),
    ('platform_organization_detail'), ('platform_set_plan'), ('platform_record_payment'),
    ('platform_void_payment'), ('platform_set_dates'), ('platform_set_suspended'),
    ('platform_save_notes'), ('platform_require'), ('platform_me'), ('platform_team'),
    ('platform_set_admin_role'), ('platform_remove_admin'), ('platform_team_activity'),
    ('platform_feature_matrix'), ('platform_set_plan_feature'), ('platform_set_org_feature'),
    ('platform_org_features'), ('platform_announcements_list'), ('platform_save_announcement'),
    ('platform_end_announcement'), ('platform_reminders'), ('platform_mark_reminder_sent'),
    ('get_my_announcements')
),
public_tables as (
  select c.oid, c.relname, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
),
public_functions as (
  select p.oid, p.proname, p.prosecdef, p.proconfig,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
),
findings(severity, section, object, finding) as (
  -- 1. RLS switched off: the public anon key can read and write the table.
  select 'CRITICAL', '1 RLS disabled', relname::text, 'Row level security is off'
    from public_tables where not relrowsecurity

  -- 2. RLS on with no policy, and not marked server-function only: the app
  --    sees no rows (usually a bug).
  union all
  select 'WARN', '2 No policy', t.relname::text, 'RLS on, no policy, not marked server-function only'
    from public_tables t
   where t.relrowsecurity
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.relname)
     and coalesce(obj_description(t.oid, 'pg_class'), '') not like 'Server-function only%'

  -- 3. Policies open to every row (qual = true) on anything but reference data.
  union all
  select 'WARN', '3 Open policy', tablename || '.' || policyname, cmd || ' policy allows every row'
    from pg_policies
   where schemaname = 'public'
     and btrim(coalesce(qual, with_check, '')) = 'true'
     and tablename not in ('drugs', 'equipment_supplies', 'suppliers')

  -- 4. Anything the anon (logged-out) role can touch.
  union all
  select 'CRITICAL', '4 Anon table access', table_name::text, 'anon has ' || privilege_type
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'

  union all
  select 'CRITICAL', '5 Anon function access', proname || '(' || args || ')', 'anon can execute'
    from public_functions
   where has_function_privilege('anon', oid, 'execute')

  -- 6. Signed-in users can call a SECURITY DEFINER function that is not on
  --    the approved list.
  union all
  select 'HIGH', '6 Unexpected callable function', f.proname || '(' || f.args || ')',
         'signed-in users can execute this SECURITY DEFINER function; it is not in app_callable'
    from public_functions f
   where f.prosecdef
     and has_function_privilege('authenticated', f.oid, 'execute')
     and f.proname not in (select name from app_callable)

  -- 7. An approved function that exists in more than one version: the old
  --    one may skip newer checks.
  union all
  select 'HIGH', '7 Duplicate callable version', f.proname || '(' || f.args || ')',
         'another callable version with the same name exists'
    from public_functions f
   where has_function_privilege('authenticated', f.oid, 'execute')
     and (select count(*) from public_functions g
           where g.proname = f.proname and has_function_privilege('authenticated', g.oid, 'execute')) > 1

  -- 8. SECURITY DEFINER without a fixed search_path.
  union all
  select 'HIGH', '8 search_path not fixed', proname || '(' || args || ')', 'SECURITY DEFINER without set search_path'
    from public_functions
   where prosecdef
     and not exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')

  -- 9. No primary key (PowerSync and the outbox need one).
  union all
  select 'WARN', '9 No primary key', t.relname::text, 'table has no primary key'
    from public_tables t
   where not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indisprimary)
)
select severity, section, object, finding from findings
union all
select 'OK', '-', '-', 'OK — no findings' where not exists (select 1 from findings)
order by 1, 2, 3;