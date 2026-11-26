-- assert_password_changed raises its own error code, PWCHG, instead of P0001,
-- so a till's upload queue keeps sales and retries them once the password has
-- been changed (flush.js treats P0001 as a permanent rejection).
-- 20261126000021 already has this version; this file records the live change.

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

  if v_reset_at is not null and v_session_started is not null and v_session_started < v_reset_at then
    return new;
  end if;

  raise exception 'You are still using a temporary password. Change your password (profile menu > Change password) before recording anything.'
    using errcode = 'PWCHG';
end;
$$;

revoke all on function public.assert_password_changed() from public, anon, authenticated;