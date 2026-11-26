-- Row-level security: each pharmacy sees only its own data, staff cannot
-- give themselves more power, and anonymous visitors see nothing.
begin;
\ir _fixtures.psql

select plan(16);

-- True if the current role sees no rows of the table, or may not read it at all.
create function pg_temp.sees_nothing(p_table text) returns boolean language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from %s', p_table) into n;
  return n = 0;
exception when insufficient_privilege then
  return true;
end $$;
grant execute on function pg_temp.sees_nothing(text) to public;

do $$
begin
  perform pg_temp.sell('sale1', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 2, 100)));
end $$;

-- Another pharmacy's administrator.
select pg_temp.act_as('otherAdmin');
select is((select count(*)::int from public.sales where shop_id = pg_temp.fx('shopA')), 0, 'another pharmacy cannot see our sales');
select is((select count(*)::int from public.batches where shop_id = pg_temp.fx('shopA')), 0, 'another pharmacy cannot see our stock');
select is((select count(*)::int from public.staff where shop_id in (pg_temp.fx('shopA'), pg_temp.fx('shopB'))), 0, 'another pharmacy cannot see our staff');
select is((select count(*)::int from public.shops where organization_id = pg_temp.fx('org')), 0, 'another pharmacy cannot see our shops');
select is((select count(*)::int from public.organizations where id = pg_temp.fx('org')), 0, 'another pharmacy cannot see our organization');
reset role;

-- Our own people.
select pg_temp.act_as('cashier');
select is((select count(*)::int from public.batches where id = pg_temp.fx('batchA')), 1, 'a cashier sees the stock in their shop');
select is((select count(*)::int from public.sales where id = pg_temp.fx('sale1')), 1, 'a cashier sees their shop''s sales');
select is((select count(*)::int from public.batches where id = pg_temp.fx('otherBatch')), 0, 'a cashier cannot see another pharmacy''s stock');

-- Writes that must go through the checked functions, never straight to the tables.
select throws_ok($$ insert into public.sales (shop_id, total_amount, payment_method) values (pg_temp.fx('shopA'), 1, 'cash') $$,
  '42501', null, 'a cashier cannot write a sale straight into the table');
-- Each attempt is either refused outright or silently changes nothing.
do $$
begin
  begin update public.batches set selling_price = 1 where id = pg_temp.fx('batchA'); exception when insufficient_privilege then null; end;
  begin update public.staff set role = 'admin' where auth_user_id = pg_temp.fx('cashier'); exception when insufficient_privilege then null; end;
  begin update public.organizations set paid_until = now() + interval '10 years' where id = pg_temp.fx('org'); exception when insufficient_privilege then null; end;
end $$;
reset role;
select is((select selling_price from public.batches where id = pg_temp.fx('batchA')), 100::numeric, 'a cashier cannot change a price directly');
select is((select role from public.staff where auth_user_id = pg_temp.fx('cashier')), 'cashier', 'a cashier cannot make themselves an administrator');
select is((select paid_until from public.organizations where id = pg_temp.fx('org')), null::timestamptz, 'staff cannot extend their own subscription');

-- Enora Labs' own tables are closed to pharmacies, even to their administrators.
select pg_temp.act_as('admin');
select ok(pg_temp.sees_nothing('public.platform_admins'), 'a pharmacy administrator cannot list Enora Labs staff');
select ok(pg_temp.sees_nothing('public.subscription_payments'), 'or read payment records directly');
reset role;

-- Visitors who are not signed in.
select ok(not has_table_privilege('anon', 'public.sales', 'select') or not exists (select 1 from pg_policies where tablename = 'sales' and 'anon' = any(roles)),
  'the anonymous role has no route to sales');
set local role anon;
select ok(pg_temp.sees_nothing('public.shops'), 'someone not signed in sees no shops');
reset role;

select * from finish();
rollback;