-- Subscriptions: trial, grace, read-only and suspended states, plan
-- features and plan limits, all enforced by the database (not the app).
begin;
\ir _fixtures.psql

select plan(18);

create function pg_temp.state() returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims_for('admin');
  v := public.get_my_subscription() ->> 'state';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.finance_entry() returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.claims_for('admin');
  v := public.create_finance_entry(pg_temp.fx('shopA'), 'expense', 'rent', 'Test rent', 1000, 'cash', now());
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.transfer(p_quantity int default 1) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.claims_for('admin');
  v := public.transfer_stock_between_shops(pg_temp.fx('shopA'), pg_temp.fx('shopB'), pg_temp.fx('batchA'), p_quantity, gen_random_uuid());
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- States.
select is(pg_temp.state(), 'complimentary', 'no dates set: complimentary');

update public.organizations set trial_ends_at = now() + interval '5 days' where id = pg_temp.fx('org');
select is(pg_temp.state(), 'trial', 'trial ending in 5 days: trial');

update public.organizations set trial_ends_at = now() - interval '3 days' where id = pg_temp.fx('org');
select is(pg_temp.state(), 'grace', 'trial ended 3 days ago: grace period');
select lives_ok($$ select pg_temp.sell('graceSale', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100))) $$,
  'sales still work during the grace period');

update public.organizations set trial_ends_at = now() - interval '10 days' where id = pg_temp.fx('org');
select is(pg_temp.state(), 'read_only', 'trial ended 10 days ago: read-only');
select throws_like($$ select pg_temp.sell('roSale', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100))) $$,
  '%read-only%', 'no sales once read-only');
select throws_like($$ select pg_temp.receive('roBatch', 'shopA', 'paracetamol', 'admin') $$,
  '%read-only%', 'no stock receipts once read-only');
select is((select count(*)::int from public.sales where shop_id = pg_temp.fx('shopA')), 1, 'nothing is deleted: the earlier sale is still there');

update public.organizations set paid_until = now() + interval '30 days' where id = pg_temp.fx('org');
select is(pg_temp.state(), 'active', 'after a payment: active');
select lives_ok($$ select pg_temp.sell('paidSale', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100))) $$,
  'and sales work again');

update public.organizations set suspended_at = now(), suspended_reason = 'Test suspension' where id = pg_temp.fx('org');
select is(pg_temp.state(), 'suspended', 'suspended overrides everything');
select throws_like($$ select pg_temp.sell('susSale', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100))) $$,
  '%suspended%', 'no sales while suspended');
update public.organizations set suspended_at = null, suspended_reason = null where id = pg_temp.fx('org');

-- Plan features.
update public.organizations set plan = 'basic' where id = pg_temp.fx('org');
select throws_like($$ select pg_temp.finance_entry() $$, '%not included in your plan%', 'Basic plan: no expenses & income');
select throws_like($$ select pg_temp.transfer() $$, '%not included in your plan%', 'Basic plan: no transfers between shops');
insert into public.organization_features (organization_id, feature, enabled) values (pg_temp.fx('org'), 'finance', true);
select lives_ok($$ select pg_temp.finance_entry() $$, 'a feature switched on for one pharmacy works on any plan');

update public.organizations set plan = 'pro' where id = pg_temp.fx('org');
select lives_ok($$ select pg_temp.transfer() $$, 'Pro plan: transfers work');

-- Plan limits (the org already has 2 shops and 4 active staff).
update public.organizations set max_shops = 2, max_staff = 4 where id = pg_temp.fx('org');
select throws_like($$ select pg_temp.new_shop('shopC', 'org') $$, '%plan allows 2 shop%', 'no third shop when the plan allows 2');
select throws_like($$ select pg_temp.new_staff('extra', 'shopA', 'cashier') $$, '%active staff accounts%', 'no fifth active staff member when the plan allows 4');

select * from finish();
rollback;