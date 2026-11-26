-- Server-side "change your temporary password first".
--
-- Until now must_change_password was only enforced by the app's screen: a
-- user holding a temporary password (set by an admin or by Enora Labs) could
-- skip the screen and call the API directly. Now the database refuses new
-- sales, stock, money and cash-register records from a session that signed in
-- with a temporary password, until the password has been changed.
--
-- Sessions that were already signed in BEFORE the reset (the real person, with
-- their old password) keep working, so a till with offline sales waiting to
-- upload is not cut off the moment an admin resets that cashier's password.

alter table public.staff add column if not exists password_reset_at timestamptz;

comment on column public.staff.password_reset_at is
  'When must_change_password was last switched on (temporary password issued). Sessions created after this are blocked from writing until the password is changed.';

-- Stamp the time whenever a temporary password is issued, whichever function
-- does it (staff_admin_create, staff_admin_mark_password_reset, the console).
create or replace function public.stamp_password_reset_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.must_change_password and (tg_op = 'INSERT' or not coalesce(old.must_change_password, false)) then
    new.password_reset_at := now();
  elsif not new.must_change_password then
    new.password_reset_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_stamp_password_reset_at on public.staff;
create trigger staff_stamp_password_reset_at
  before insert or update of must_change_password on public.staff
  for each row execute function public.stamp_password_reset_at();

-- Existing staff still waiting to change: treat every session as temporary.
update public.staff set password_reset_at = coalesce(password_reset_at, created_at)
 where must_change_password;

create or replace function public.assert_password_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_reset_at timestamptz;
  v_session_started timestamptz;
begin
  -- Server jobs (service role, cron) have no user.
  if v_uid is null then
    return new;
  end if;

  select s.password_reset_at into v_reset_at
    from public.staff s
   where s.auth_user_id = v_uid and s.is_active and s.must_change_password
   limit 1;
  if not found then
    return new;
  end if;

  select ses.created_at into v_session_started
    from auth.sessions ses
   where ses.id = nullif(auth.jwt() ->> 'session_id', '')::uuid;

  -- Signed in before the temporary password was issued: the real user.
  if v_reset_at is not null and v_session_started is not null and v_session_started < v_reset_at then
    return new;
  end if;

  -- Own error code (not P0001) so the till's upload queue keeps the record
  -- and retries it after the password is changed, instead of treating it as
  -- a permanent rejection and sending sales to review.
  raise exception 'You are still using a temporary password. Change your password (profile menu > Change password) before recording anything.'
    using errcode = 'PWCHG';
end;
$$;

revoke all on function public.assert_password_changed() from public, anon, authenticated;
revoke all on function public.stamp_password_reset_at() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['sales', 'stock_movements', 'finance_entries', 'purchase_orders',
                           'cash_register_sessions', 'equipment_supply_receipts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_assert_password_changed', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.assert_password_changed()',
                   t || '_assert_password_changed', t);
  end loop;
end;
$$;