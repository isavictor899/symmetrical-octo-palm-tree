-- Add a small, server-derived pharmacy context to every newly issued JWT.
--
-- Membership decision: each signed-in user has one home-shop staff record.
-- Multi-shop access is granted by an administrator role within that home
-- shop's organization; it is not represented by multiple staff rows.
--
-- This does NOT authorize an operation by itself. Transaction RPCs must keep
-- checking auth.uid() against staff and shops in the database, because JWTs
-- can be stale after a staff transfer or role change. The claims identify the
-- signed-in user's home shop/organization without ever trusting a shop ID
-- supplied by a URL or browser state.
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
  staff_record_count integer;
begin
  claims := coalesce(event -> 'claims', '{}'::jsonb);

  -- The values are read from the database under the Auth service role. They
  -- are never accepted from a request parameter, URL, or user metadata.
  -- The current application deliberately supports ONE home-shop staff record
  -- per authenticated user. Administrators may manage other shops in the
  -- same organization through their role; they do not get extra staff rows.
  -- Do not select an arbitrary row if bad data violates that invariant.
  select count(*)
    into staff_record_count
    from public.staff s
   where s.auth_user_id = (event ->> 'user_id')::uuid;

  if staff_record_count = 1 then
    select jsonb_build_object(
      'home_shop_id', s.shop_id::text,
      'organization_id', sh.organization_id::text,
      'staff_role', s.role
    )
      into pharmacy_context
      from public.staff s
      join public.shops sh on sh.id = s.shop_id
     where s.auth_user_id = (event ->> 'user_id')::uuid;
  end if;

  if jsonb_typeof(claims -> 'app_metadata') is distinct from 'object' then
    claims := jsonb_set(claims, '{app_metadata}', '{}'::jsonb, true);
  end if;

  if pharmacy_context is null then
    -- Do not leave a former staff member with stale pharmacy context in a new
    -- token. This also withholds shop claims from an account with multiple
    -- staff rows until that invalid membership data is repaired. The database
    -- RPC checks remain the final authorization guard.
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
  'Supabase Custom Access Token hook. Adds server-derived app_metadata.pharmacy.home_shop_id, organization_id, and staff_role to new JWTs.';
