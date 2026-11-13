-- =============================================================================
-- Pharmacy POS — database security audit
-- =============================================================================
-- Run this in the Supabase Dashboard → SQL Editor.
-- It is read-only. Paste the whole file, run it, and send back the result
-- grids (sections 1, 2, 4, 5, 6 matter most).
--
-- Context: the repository contained no schema for these tables, so the
-- Row Level Security state below has never been reviewed as code.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Tables with RLS DISABLED  ← must be empty
--    Any row here means the public anon key can read AND write that table.
-- -----------------------------------------------------------------------------
select n.nspname as schema, c.relname as table, 'RLS DISABLED' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and not c.relrowsecurity
order by c.relname;


-- -----------------------------------------------------------------------------
-- 2. Tables with RLS ENABLED but NO policy  ← data is invisible to everyone
--    Usually a functional bug, but also means writes silently do nothing.
-- -----------------------------------------------------------------------------
select c.relname as table, 'RLS enabled, no policy' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  )
order by c.relname;


-- -----------------------------------------------------------------------------
-- 3. Full policy listing — read these carefully.
--    Every business table should scope by shop_id, or by organization_id for
--    administrator access. A policy using `true` is a red flag outside
--    reference/catalogue tables.
-- -----------------------------------------------------------------------------
select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- -----------------------------------------------------------------------------
-- 4. What the ANON role can touch  ← must be empty for business tables
--    The anon key ships inside the JS bundle and is public.
-- -----------------------------------------------------------------------------
select table_name, privilege_type
from information_schema.role_table_grants
where table_sc= 'public'
  and grantee = 'anon'hema 
order by table_name, privilege_type;


-- -----------------------------------------------------------------------------
-- 5. RPCs the ANON role can execute  ← should be empty
--    If any of these appear, an unauthenticated visitor can call them.
-- -----------------------------------------------------------------------------
select p.proname as function,
       pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and has_function_privilege('anon', p.oid, 'execute')
order by p.proname;


-- -----------------------------------------------------------------------------
-- 6. SECURITY DEFINER functions WITHOUT a pinned search_path
--    A mutable search_path on a SECURITY DEFINER function is a privilege
--    escalation vector. Every row here should be fixed with:
--        alter function <fn>(<args>) set search_path = public;
-- -----------------------------------------------------------------------------
select p.proname as function,
       pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
    where cfg like 'search_path=%'
  )
order by p.proname;


-- -----------------------------------------------------------------------------
-- 7. Tables without a primary key (PowerSync and the outbox both need one)
-- -----------------------------------------------------------------------------
select c.relname as table, 'no primary key' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not exists (
    select 1 from pg_index i
    where i.indrelid = c.oid and i.indisprimary
  )
order by c.relname;


-- -----------------------------------------------------------------------------
-- 8. Row counts — distinguishes "RLS blocks it" from "the table is empty"
--    when you cross-check section 4.
-- -----------------------------------------------------------------------------
select 'organizations' as table, count(*) from public.organizations
union all select 'shops',            count(*) from public.shops
union all select 'staff',            count(*) from public.staff
union all select 'drugs',            count(*) from public.drugs
union all select 'batches',          count(*) from public.batches
union all select 'shop_drugs',       count(*) from public.shop_drugs
union all select 'sales',            count(*) from public.sales
union all select 'sale_items',       count(*) from public.sale_items
union all select 'stock_movements',  count(*) from public.stock_movements
order by 1;
