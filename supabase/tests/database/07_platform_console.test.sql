-- The Enora Labs console: only platform staff, only with the authenticator
-- code (aal2), owners vs support, and every change is audited.
begin;
\ir _fixtures.psql

select plan(15);

do $$
begin
  perform pg_temp.new_user('enoraOwner');
  perform pg_temp.new_user('enoraSupport');
  insert into public.platform_admins (user_id, email, role) values
    (pg_temp.fx('enoraOwner'), 'owner@tests.invalid', 'owner'),
    (pg_temp.fx('enoraSupport'), 'support@tests.invalid', 'support');
end $$;

-- Who counts as platform staff.
select pg_temp.claims_for('admin', 'aal2');
select is(public.platform_is_admin(), false, 'a pharmacy administrator is not platform staff');
select throws_like($$ select public.platform_overview() $$, '%platform access is required%',
  'and cannot open the console, even with an authenticator code');

select pg_temp.claims_for('enoraOwner', 'aal1');
select is(public.platform_is_admin(), true, 'the console owner is platform staff');
select throws_like($$ select public.platform_overview() $$, '%authenticator app%',
  'but without the authenticator code the console is locked');

select pg_temp.claims_for('enoraOwner', 'aal2');
select lives_ok($$ select public.platform_overview() $$, 'with the code, the owner can open the console');

select pg_temp.claims_for('enoraSupport', 'aal2');
select lives_ok($$ select public.platform_overview() $$, 'support staff can read the console');
select throws_like($$ select public.platform_set_plan(pg_temp.fx('org'), 'basic', null, null) $$, '%console owner%',
  'but support staff cannot change a plan');
select throws_like($$ select public.platform_record_payment(pg_temp.fx('org'), 3000, 'mpesa', 'TESTREF001', now(), 1, null) $$, '%console owner%',
  'or record a payment');

-- Owner actions.
select pg_temp.claims_for('enoraOwner', 'aal2');
select lives_ok($$ select public.platform_set_plan(pg_temp.fx('org'), 'pro', null, null) $$, 'the owner can change a plan');
select is((select plan from public.organizations where id = pg_temp.fx('org')), 'pro', 'the plan is changed');
select ok(exists (select 1 from public.platform_audit_log where actor = pg_temp.fx('enoraOwner')),
  'and the change is in the audit log');

select lives_ok($$ select public.platform_record_payment(pg_temp.fx('org'), 9000, 'mpesa', 'TESTREF002', now(), 3, 'Test payment') $$,
  'the owner can record a 3-month payment');
select ok((select paid_until from public.organizations where id = pg_temp.fx('org')) > now() + interval '85 days',
  'which moves paid-until about 3 months ahead');
select throws_like($$ select public.platform_record_payment(pg_temp.fx('org'), 9000, 'mpesa', 'TESTREF002', now(), 3, null) $$,
  '%already recorded%', 'the same M-Pesa code cannot be recorded twice');

select throws_like($$ select public.platform_set_suspended(pg_temp.fx('org'), true, 'no') $$, '%at least 5 characters%',
  'suspending needs a reason the pharmacy will see');

select * from finish();
rollback;