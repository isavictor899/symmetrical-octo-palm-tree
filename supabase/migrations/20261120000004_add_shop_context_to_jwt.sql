-- Add a small, server-derived pharmacy context to every newly issued JWT.
--
-- This does NOT authorize an operation by itself. Transaction RPCs must keep
-- checking auth.uid() against staff and shops in the database, because JWTs
-- can be stale after a staff transfer or role change. The claims let policies
-- and server code identify the signed-in user's current shop/organization
-- without ever trusting a shop ID supplied by a URL or browser state.
--
-- After applying this migration, enable this function as the "Custom Access
-- Token" SQL hook in Supabase Authentication > Hooks, then have users sign
-- out and back in (or refresh their tokens).

create or replace function public.pharmacy_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  claims jsonb;
  pharmacy_context jsonb;
begin
  claims := coalesce(event -> 'claims', '{}'::jsonb);

  -- The values are read from the database under the Auth service role. They
  -- are never accepted from a request parameter, URL, or user metadata.
  select jsonb_build_object(
    'shop_id', s.shop_id::text,
    'organization_id', sh.organization_id::text,
    'staff_role', s.role
  )
    into pharmacy_context
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = (event ->> 'user_id')::uuid
   order by s.id
   limit 1;

  if jsonb_typeof(claims -> 'app_metadata') is distinct from 'object' then
    claims := jsonb_set(claims, '{app_metadata}', '{}'::jsonb, true);
  end if;

  if pharmacy_context is null then
    -- Do not leave a former staff member with stale pharmacy context in a new
    -- token. The database RPC checks remain the final authorization guard.
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      (claims -> 'app_metadata') - 'pharmacy',
      true
    );
  else
    claims := jsonb_set(
      claims,
      '{app_metadata,pharmacy}',
      pharmacy_context,
      true
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

-- Supabase Auth invokes SQL hooks as supabase_auth_admin. Give that internal
-- role exactly the read access it needs, and prevent browser/API roles from
-- calling the hook directly.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.pharmacy_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.pharmacy_access_token_hook(jsonb) from public, anon, authenticated;

grant select (auth_user_id, shop_id, role) on public.staff to supabase_auth_admin;
grant select (id, organization_id) on public.shops to supabase_auth_admin;

do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'staff'
       and policyname = 'supabase_auth_admin_can_read_jwt_staff_context'
  ) then
    create policy supabase_auth_admin_can_read_jwt_staff_context
      on public.staff
      for select
      to supabase_auth_admin
      using (true);
  end if;

  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'shops'
       and policyname = 'supabase_auth_admin_can_read_jwt_shop_context'
  ) then
    create policy supabase_auth_admin_can_read_jwt_shop_context
      on public.shops
      for select
      to supabase_auth_admin
      using (true);
  end if;
end;
$$;

comment on function public.pharmacy_access_token_hook(jsonb) is
  'Supabase Custom Access Token hook. Adds server-derived app_metadata.pharmacy.shop_id, organization_id, and staff_role to new JWTs.';
