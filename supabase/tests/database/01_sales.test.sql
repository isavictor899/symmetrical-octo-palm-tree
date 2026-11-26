-- Sales: prices, discounts, stock, attribution and who may sell where.
begin;
\ir _fixtures.psql

select plan(20);

-- A normal sale by the cashier.
select lives_ok($$ select pg_temp.sell('sale1', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 2, 100))) $$,
  'a cashier can sell at the listed price');
select is(pg_temp.stock_left('batchA'), 48, 'selling 2 takes 2 off the batch');
select is((select total_amount from public.sales where id = pg_temp.fx('sale1')), 200::numeric, 'the sale total is quantity x price');
select is((select staff_id from public.sales where id = pg_temp.fx('sale1')), pg_temp.fx('cashier.staff'), 'the sale is credited to the cashier');
select is((select count(*)::int from public.stock_movements where batch_id = pg_temp.fx('batchA') and movement_type = 'sold'), 1,
  'one stock movement is written for the sale');

-- Prices cannot be lowered without a recorded discount, or changed behind the till's back.
select throws_like($$ select pg_temp.sell('x1', 'cashier', 'shopA',
    jsonb_build_array(pg_temp.line('batchA', 1, 100) || '{"unit_price": 50}')) $$,
  '%does not match the discount%', 'a lower price without a discount is refused');
select throws_like($$ select pg_temp.sell('x2', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 80))) $$,
  '%price changed%', 'a sale at an out-of-date price is refused');
select throws_like($$ select pg_temp.sell('x3', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100, -5))) $$,
  '%cannot be negative%', 'a negative discount is refused');
select throws_like($$ select pg_temp.sell('x4', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100, 150))) $$,
  '%cannot exceed the unit price%', 'a discount bigger than the price is refused');

-- Discount limits by role: cashier 25%, pharmacist 50%, admin 100%.
select lives_ok($$ select pg_temp.sell('disc1', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100, 25))) $$,
  'a cashier can give a 25% discount');
select throws_like($$ select pg_temp.sell('x5', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100, 30))) $$,
  '%exceeds the 25 percent limit%', 'a cashier cannot give a 30% discount');
select lives_ok($$ select pg_temp.sell('disc2', 'pharmacist', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100, 50))) $$,
  'a pharmacist can give a 50% discount');

-- Stock and shop boundaries.
select throws_like($$ select pg_temp.sell('x6', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1000, 100))) $$,
  '%Not enough stock%', 'selling more than is in stock is refused');
select throws_like($$ select pg_temp.sell('x7', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('otherBatch', 1, 100))) $$,
  '%batch was not found for this shop%', 'another pharmacy''s batch cannot be sold');
select throws_like($$ select pg_temp.sell('x8', 'cashierB', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100))) $$,
  '%not assigned to this shop%', 'a cashier from another shop cannot sell from this shop');
select throws_like($$ select pg_temp.sell('x9', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100)), now() - interval '8 days') $$,
  '%more than 7 days old%', 'a sale dated more than 7 days ago is refused (it goes to Sales review)');

-- Retrying an upload never sells twice.
do $$
declare v_client uuid := gen_random_uuid(); v1 uuid; v2 uuid;
begin
  perform pg_temp.claims_for('cashier');
  v1 := public.sell_stock_with_amount_discounts(pg_temp.fx('shopA'), 'cash', jsonb_build_array(pg_temp.line('batchA', 3, 100)),
          v_client, null, null, null, pg_temp.fx('cashier'), now());
  v2 := public.sell_stock_with_amount_discounts(pg_temp.fx('shopA'), 'cash', jsonb_build_array(pg_temp.line('batchA', 3, 100)),
          v_client, null, null, null, pg_temp.fx('cashier'), now());
  insert into fx values ('retry1', v1), ('retry2', v2);
end $$;
select is(pg_temp.fx('retry2'), pg_temp.fx('retry1'), 'the same sale uploaded twice returns the same sale');
select is(pg_temp.stock_left('batchA'), 43, 'and the stock is only taken once (48 - 1 - 1 - 3)');

-- The app may only use the checked entry point; the internal ones are closed.
select ok(not has_function_privilege('authenticated', 'public.record_sale_with_discounts(uuid,text,jsonb,uuid,text,text,date,uuid,timestamptz,boolean)', 'execute'),
  'the trusted sale function cannot be called from the app');
select ok(not has_function_privilege('authenticated', 'public.sell_stock_and_equipment(uuid,text,jsonb,uuid,text,text,date)', 'execute'),
  'the unchecked sale function cannot be called from the app');

select * from finish();
rollback;