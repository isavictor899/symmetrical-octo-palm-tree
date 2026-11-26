-- Passwords: a login holding a temporary password cannot record anything
-- until it is changed, and the current-password check is rate limited.
begin;
\ir _fixtures.psql

select plan(13);

create function pg_temp.new_session(p_key text, p_started timestamptz) returns uuid
language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.sessions (id, user_id, created_at, updated_at) values (v, pg_temp.fx(p_key), p_started, p_started);
  insert into fx values (p_key || '.session.' || v, v);
  return v;
end $$;

-- Sells as the cashier from a given session.
create function pg_temp.sell_in_session(p_session uuid) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.fx('cashier'), 'role', 'authenticated',
                     'aal', 'aal1', 'session_id', p_session)::text, true);
  v := public.sell_stock_with_amount_discounts(pg_temp.fx('shopA'), 'cash', jsonb_build_array(pg_temp.line('batchA', 1, 100)),
         gen_random_uuid(), null, null, null, pg_temp.fx('cashier'), now());
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

do $$
begin
  -- Signed in an hour ago with the cashier's own password.
  insert into fx values ('oldSession', pg_temp.new_session('cashier', now() - interval '1 hour'));
end $$;

-- The administrator resets the cashier's password (temporary password issued now).
update public.staff set must_change_password = true where id = pg_temp.fx('cashier.staff');
select isnt((select password_reset_at from public.staff where id = pg_temp.fx('cashier.staff')), null,
  'issuing a temporary password records when');

do $$
begin
  -- Signed in after the reset, i.e. with the temporary password.
  insert into fx values ('newSession', pg_temp.new_session('cashier', clock_timestamp() + interval '1 second'));
end $$;

select lives_ok($$ select pg_temp.sell_in_session(pg_temp.fx('oldSession')) $$,
  'a till that was already signed in keeps working (its offline sales still upload)');
select throws_ok($$ select pg_temp.sell_in_session(pg_temp.fx('newSession')) $$, 'PWCHG', null,
  'a session using the temporary password cannot record a sale');
select throws_ok($$ select pg_temp.sell_in_session(null) $$, 'PWCHG', null,
  'nor can a request with no session');

do $$
begin
  perform public.staff_self_password_changed(pg_temp.fx('cashier'));
end $$;
select is((select password_reset_at from public.staff where id = pg_temp.fx('cashier.staff')), null,
  'changing the password clears the flag');
select lives_ok($$ select pg_temp.sell_in_session(pg_temp.fx('newSession')) $$,
  'after the change, the new session can sell');

-- New staff start with a temporary password too.
do $$
declare v_user uuid;
begin
  v_user := pg_temp.new_user('newHire');
  insert into public.staff (shop_id, full_name, role, auth_user_id, email, is_active, must_change_password)
  values (pg_temp.fx('shopA'), 'Test new hire', 'cashier', v_user, 'newhire@tests.invalid', true, true);
end $$;
select isnt((select password_reset_at from public.staff where auth_user_id = pg_temp.fx('newHire')), null,
  'a new staff member''s first password counts as temporary');

-- Current-password check (used by "Change password").
select is(public.staff_verify_own_password(pg_temp.fx('admin'), 'Test-Password-1'), true, 'the right current password is accepted');
select is(public.staff_verify_own_password(pg_temp.fx('admin'), 'not-my-password'), false, 'a wrong one is refused');
do $$
begin
  for i in 1..4 loop perform public.staff_verify_own_password(pg_temp.fx('admin'), 'still-wrong'); end loop;
end $$;
select throws_like($$ select public.staff_verify_own_password(pg_temp.fx('admin'), 'Test-Password-1') $$,
  '%Too many wrong attempts%', 'after 5 wrong attempts even the right password is refused for 15 minutes');

-- Only the server (service role) may use these.
select ok(not has_function_privilege('authenticated', 'public.staff_verify_own_password(uuid,text)', 'execute'),
  'the app cannot call the password check directly');
select ok(not has_function_privilege('anon', 'public.staff_verify_own_password(uuid,text)', 'execute'),
  'nor can anonymous visitors');
select ok(not has_table_privilege('authenticated', 'public.password_check_failures', 'select'),
  'the failed-attempt log is not readable from the app');

select * from finish();
rollback;