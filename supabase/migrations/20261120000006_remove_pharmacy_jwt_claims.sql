-- Stop adding shop IDs, organization IDs, and staff roles to newly issued
-- access tokens. Database RPCs continue to authorize against auth.uid(), staff,
-- and shops. Keep the configured Postgres Auth hook as a no-op so projects
-- that already selected it do not fail token issuance.

create or replace function public.pharmacy_access_token_hook(event jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  select event;
$$;

-- The hook no longer reads staff/shops, so remove its table grants and the
-- narrowly scoped Auth-admin read policies added with the previous version.
revoke select (auth_user_id, shop_id, role) on public.staff from supabase_auth_admin;
revoke select (id, organization_id) on public.shops from supabase_auth_admin;
drop policy if exists supabase_auth_admin_can_read_jwt_staff_context on public.staff;
drop policy if exists supabase_auth_admin_can_read_jwt_shop_context on public.shops;

comment on function public.pharmacy_access_token_hook(jsonb) is
  'No-op Supabase Custom Access Token hook. Pharmacy authorization is resolved by database checks, not custom JWT pharmacy claims.';
