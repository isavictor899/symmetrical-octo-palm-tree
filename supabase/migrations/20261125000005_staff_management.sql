-- Staff management: invite, edit, deactivate/reactivate, password resets.
--
-- How deactivation is enforced everywhere at once:
--   Every RPC and RLS policy finds "the current staff member" with
--   staff.auth_user_id = auth.uid(). Deactivating moves auth_user_id into
--   former_auth_user_id, so that lookup fails for the leaver in every function
--   and policy, with no per-function changes. History (sales.staff_id etc.)
--   points at staff.id, so past records still show who did what.
--   The Edge Function also bans the login in Supabase Auth.
--
-- All admin_* functions are callable ONLY by the service role (the manage-staff
-- Edge Function), which passes the verified caller as p_actor.

alter table public.staff
  add column if not exists is_active boolean not null default true,
  add column if not exists must_change_password boolean not null default false,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid,
  add column if not exists former_auth_user_id uuid;

update public.staff s
   set email = u.email
  from auth.users u
 where u.id = s.auth_user_id
   and s.email is null;

alter table public.staff add constraint staff_active_has_login check (
  (is_active and auth_user_id is not null) or (not is_active and auth_user_id is null)
);
alter table public.staff add constraint staff_full_name_present check (length(trim(full_name)) >= 2);

-- ---------------------------------------------------------------------------
-- Audit log of every staff change.
-- ---------------------------------------------------------------------------
create table if not exists public.staff_audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id),
  actor_auth_user_id uuid not null,
  target_staff_id uuid references public.staff(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_audit_org on public.staff_audit_log (organization_id, created_at desc);

alter table public.staff_audit_log enable row level security;
revoke all on public.staff_audit_log from public, anon, authenticated;
grant select on public.staff_audit_log to authenticated;

drop policy if exists staff_audit_admin_read on public.staff_audit_log;
create policy staff_audit_admin_read on public.staff_audit_log
  for select to authenticated
  using (organization_id = public.my_organization_id() and public.current_user_is_admin());

-- ---------------------------------------------------------------------------
-- Internal: resolve and authorise the acting admin.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_actor(p_actor uuid)
returns table (staff_id uuid, organization_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select s.id, sh.organization_id
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.auth_user_id = p_actor
     and s.is_active
     and s.role = 'admin';

  if not found then
    raise exception 'Only an active administrator can manage staff.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.staff_admin_assert_shop(p_organization_id uuid, p_shop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not exists (
    select 1 from public.shops where id = p_shop_id and organization_id = p_organization_id
  ) then
    raise exception 'Choose a shop in your organization.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.staff_admin_assert_role(p_role text)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_role is null or p_role not in ('admin', 'pharmacist', 'cashier') then
    raise exception 'Choose a role: admin, pharmacist or cashier.' using errcode = 'P0001';
  end if;
end;
$$;

-- Active admins in an organization, optionally ignoring one staff member.
create or replace function public.staff_admin_active_admin_count(p_organization_id uuid, p_excluding uuid default null)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where sh.organization_id = p_organization_id
     and s.is_active
     and s.role = 'admin'
     and (p_excluding is null or s.id <> p_excluding);
$$;

-- Loads a target staff member and checks they belong to the actor's organization.
create or replace function public.staff_admin_target(p_organization_id uuid, p_staff_id uuid)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.staff;
begin
  select s.* into v_target
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
   where s.id = p_staff_id
     and sh.organization_id = p_organization_id
   for update of s;

  if v_target.id is null then
    raise exception 'Staff member not found in your organization.' using errcode = 'P0001';
  end if;
  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- List staff for the actor's organization.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_list(p_actor uuid)
returns table (
  id uuid,
  full_name text,
  role text,
  shop_id uuid,
  shop_name text,
  email text,
  phone text,
  is_active boolean,
  must_change_password boolean,
  is_self boolean,
  created_at timestamptz,
  deactivated_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
begin
  select * into v_actor from public.staff_admin_actor(p_actor);

  return query
  select s.id, s.full_name, s.role, s.shop_id, sh.name, coalesce(s.email, u.email::text), s.phone,
         s.is_active, s.must_change_password, (s.auth_user_id = p_actor),
         s.created_at, s.deactivated_at, u.last_sign_in_at
    from public.staff s
    join public.shops sh on sh.id = s.shop_id
    left join auth.users u on u.id = coalesce(s.auth_user_id, s.former_auth_user_id)
   where sh.organization_id = v_actor.organization_id
   order by s.is_active desc, sh.name, s.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create: validated BEFORE the login is created, then the staff row after.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_check_create(p_actor uuid, p_shop_id uuid, p_role text, p_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
begin
  select * into v_actor from public.staff_admin_actor(p_actor);
  perform public.staff_admin_assert_shop(v_actor.organization_id, p_shop_id);
  perform public.staff_admin_assert_role(p_role);
  if length(trim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'Enter the staff member''s full name.' using errcode = 'P0001';
  end if;
  -- Plan limits (max_staff) plug in here later.
end;
$$;

create or replace function public.staff_admin_create(
  p_actor uuid,
  p_auth_user_id uuid,
  p_shop_id uuid,
  p_role text,
  p_full_name text,
  p_email text,
  p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
  v_staff_id uuid;
begin
  perform public.staff_admin_check_create(p_actor, p_shop_id, p_role, p_full_name);
  select * into v_actor from public.staff_admin_actor(p_actor);

  if exists (select 1 from public.staff where auth_user_id = p_auth_user_id or former_auth_user_id = p_auth_user_id) then
    raise exception 'This login already belongs to a staff member.' using errcode = 'P0001';
  end if;

  insert into public.staff (shop_id, full_name, role, auth_user_id, email, phone, is_active, must_change_password)
  values (p_shop_id, trim(p_full_name), p_role, p_auth_user_id, lower(trim(p_email)), nullif(trim(coalesce(p_phone, '')), ''), true, true)
  returning id into v_staff_id;

  insert into public.staff_audit_log (organization_id, actor_auth_user_id, target_staff_id, action, details)
  values (v_actor.organization_id, p_actor, v_staff_id, 'created',
          jsonb_build_object('role', p_role, 'shop_id', p_shop_id, 'email', lower(trim(p_email))));

  return v_staff_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Update name, role, shop, phone.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_update(
  p_actor uuid,
  p_staff_id uuid,
  p_full_name text,
  p_role text,
  p_shop_id uuid,
  p_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
  v_target public.staff;
begin
  select * into v_actor from public.staff_admin_actor(p_actor);
  v_target := public.staff_admin_target(v_actor.organization_id, p_staff_id);
  perform public.staff_admin_assert_shop(v_actor.organization_id, p_shop_id);
  perform public.staff_admin_assert_role(p_role);

  if length(trim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'Enter the staff member''s full name.' using errcode = 'P0001';
  end if;

  if v_target.auth_user_id = p_actor and p_role <> v_target.role then
    raise exception 'You cannot change your own role. Ask another administrator.' using errcode = 'P0001';
  end if;

  if v_target.role = 'admin' and p_role <> 'admin' and v_target.is_active
     and public.staff_admin_active_admin_count(v_actor.organization_id, v_target.id) = 0 then
    raise exception 'This is the last active administrator. Make someone else an administrator first.' using errcode = 'P0001';
  end if;

  update public.staff
     set full_name = trim(p_full_name),
         role = p_role,
         shop_id = p_shop_id,
         phone = nullif(trim(coalesce(p_phone, '')), '')
   where id = v_target.id;

  insert into public.staff_audit_log (organization_id, actor_auth_user_id, target_staff_id, action, details)
  values (v_actor.organization_id, p_actor, v_target.id, 'updated',
          jsonb_build_object(
            'role', jsonb_build_object('from', v_target.role, 'to', p_role),
            'shop_id', jsonb_build_object('from', v_target.shop_id, 'to', p_shop_id),
            'full_name', jsonb_build_object('from', v_target.full_name, 'to', trim(p_full_name))));
end;
$$;

-- ---------------------------------------------------------------------------
-- Deactivate / reactivate. Returns the login id so the Edge Function can
-- ban or unban it in Supabase Auth.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_set_active(p_actor uuid, p_staff_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
  v_target public.staff;
  v_login uuid;
begin
  select * into v_actor from public.staff_admin_actor(p_actor);
  v_target := public.staff_admin_target(v_actor.organization_id, p_staff_id);

  if p_active is null then
    raise exception 'Choose activate or deactivate.' using errcode = 'P0001';
  end if;

  if not p_active then
    if not v_target.is_active then
      return v_target.former_auth_user_id;  -- already inactive: idempotent
    end if;
    if v_target.auth_user_id = p_actor then
      raise exception 'You cannot deactivate your own account.' using errcode = 'P0001';
    end if;
    if v_target.role = 'admin'
       and public.staff_admin_active_admin_count(v_actor.organization_id, v_target.id) = 0 then
      raise exception 'This is the last active administrator and cannot be deactivated.' using errcode = 'P0001';
    end if;

    v_login := v_target.auth_user_id;
    update public.staff
       set is_active = false,
           former_auth_user_id = v_login,
           auth_user_id = null,
           deactivated_at = now(),
           deactivated_by = p_actor
     where id = v_target.id;
  else
    if v_target.is_active then
      return v_target.auth_user_id;  -- already active: idempotent
    end if;
    v_login := v_target.former_auth_user_id;
    if v_login is null then
      raise exception 'This staff member has no login to restore. Add them again as a new staff member.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.staff where auth_user_id = v_login) then
      raise exception 'This login is now used by another staff record.' using errcode = 'P0001';
    end if;

    update public.staff
       set is_active = true,
           auth_user_id = v_login,
           former_auth_user_id = null,
           deactivated_at = null,
           deactivated_by = null
     where id = v_target.id;
  end if;

  insert into public.staff_audit_log (organization_id, actor_auth_user_id, target_staff_id, action)
  values (v_actor.organization_id, p_actor, v_target.id, case when p_active then 'reactivated' else 'deactivated' end);

  return v_login;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin password reset: flags the account so the staff member must choose a
-- new password at next sign-in. Returns the login id for the Edge Function.
-- ---------------------------------------------------------------------------
create or replace function public.staff_admin_mark_password_reset(p_actor uuid, p_staff_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
  v_target public.staff;
begin
  select * into v_actor from public.staff_admin_actor(p_actor);
  v_target := public.staff_admin_target(v_actor.organization_id, p_staff_id);

  if not v_target.is_active then
    raise exception 'Reactivate this staff member before resetting their password.' using errcode = 'P0001';
  end if;
  if v_target.auth_user_id = p_actor then
    raise exception 'Use "Change password" in your profile to change your own password.' using errcode = 'P0001';
  end if;

  update public.staff set must_change_password = true where id = v_target.id;

  insert into public.staff_audit_log (organization_id, actor_auth_user_id, target_staff_id, action)
  values (v_actor.organization_id, p_actor, v_target.id, 'password_reset');

  return v_target.auth_user_id;
end;
$$;

-- Called by the Edge Function after the signed-in user sets their own new password.
create or replace function public.staff_self_password_changed(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.staff
     set must_change_password = false
   where auth_user_id = p_actor
     and is_active;
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the service role (Edge Function) may call any of these.
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'staff\_admin\_%' or p.proname = 'staff_self_password_changed')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';