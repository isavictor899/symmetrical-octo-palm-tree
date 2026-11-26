-- Checking the current password when someone changes their own password.
--
-- Done here against the stored bcrypt hash, not by signing in again from the
-- edge function: all edge calls come from the same address, so repeated
-- sign-ins there would use up Supabase's sign-in rate limit for every
-- customer. This function has its own limit instead: 5 wrong attempts per
-- login in 15 minutes.

create table if not exists public.password_check_failures (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null,
  failed_at timestamptz not null default now()
);

create index if not exists password_check_failures_user_time
  on public.password_check_failures (auth_user_id, failed_at desc);

alter table public.password_check_failures enable row level security;
revoke all on table public.password_check_failures from public, anon, authenticated;
comment on table public.password_check_failures is
  'Server-function only: wrong current-password attempts, for the rate limit in staff_verify_own_password.';

create or replace function public.staff_verify_own_password(p_actor uuid, p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_recent int;
begin
  select count(*) into v_recent
    from public.password_check_failures
   where auth_user_id = p_actor and failed_at > now() - interval '15 minutes';
  if v_recent >= 5 then
    raise exception 'Too many wrong attempts. Wait 15 minutes and try again.' using errcode = 'P0001';
  end if;

  select u.encrypted_password into v_hash from auth.users u where u.id = p_actor;

  if v_hash is null or v_hash = '' or extensions.crypt(coalesce(p_password, ''), v_hash) <> v_hash then
    insert into public.password_check_failures (auth_user_id) values (p_actor);
    -- Keep the table small.
    delete from public.password_check_failures where failed_at < now() - interval '1 day';
    -- Returned, not raised, so the failure row above is kept.
    return false;
  end if;

  delete from public.password_check_failures where auth_user_id = p_actor;
  return true;
end;
$$;

revoke all on function public.staff_verify_own_password(uuid, text) from public, anon, authenticated;
grant execute on function public.staff_verify_own_password(uuid, text) to service_role;