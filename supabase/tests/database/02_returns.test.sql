-- Sales returns: who may refund, how much, how, and the stock coming back.
begin;
\ir _fixtures.psql

select plan(12);

do $$
begin
  perform pg_temp.sell('sale1', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 2, 100)));
end $$;

select throws_like($$ select pg_temp.return_item('r0', 'cashier', 'sale1', 1) $$,
  '%Only a pharmacist, manager or administrator%', 'a cashier cannot process a return');
select lives_ok($$ select pg_temp.return_item('r1', 'pharmacist', 'sale1', 1) $$,
  'a pharmacist can return 1 of the 2 sold');
select is(pg_temp.stock_left('batchA'), 49, 'the returned unit goes back on the batch (50 - 2 + 1)');
select is((select count(*)::int from public.stock_movements where batch_id = pg_temp.fx('batchA') and movement_type = 'return'), 1,
  'one return stock movement is written');

select throws_like($$ select pg_temp.return_item('r2', 'pharmacist', 'sale1', 2) $$,
  '%Only 1 unit(s) remain eligible%', 'more than what is left on the sale cannot be returned');
select throws_like($$ select pg_temp.return_item('r3', 'pharmacist', 'sale1', 0) $$,
  '%greater than zero%', 'a return of zero units is refused');
select throws_like($$ select pg_temp.return_item('r4', 'pharmacist', 'sale1', 1, 'mpesa') $$,
  '%original payment method%', 'the refund must go back the way the customer paid');
select throws_like($$ select pg_temp.return_item('r5', 'pharmacist', 'sale1', 1, 'cash', '') $$,
  '%reason%', 'a return needs a reason');
select throws_like($$ select pg_temp.return_item('r6', 'otherAdmin', 'sale1', 1) $$,
  '%another shop%', 'another pharmacy cannot return this pharmacy''s sale');

-- Returns older than 7 days need an administrator.
do $$
begin
  perform pg_temp.sell('oldSale', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 1, 100)));
  update public.sales set sold_at = now() - interval '9 days' where id = pg_temp.fx('oldSale');
end $$;
select throws_like($$ select pg_temp.return_item('r7', 'pharmacist', 'oldSale', 1) $$,
  '%older than 7 days need an administrator%', 'a pharmacist cannot return a sale older than 7 days');
select lives_ok($$ select pg_temp.return_item('r8', 'admin', 'oldSale', 1) $$,
  'an administrator can');

-- Retrying a return upload never refunds twice.
do $$
declare v_client uuid := gen_random_uuid();
begin
  perform pg_temp.sell('sale3', 'cashier', 'shopA', jsonb_build_array(pg_temp.line('batchA', 3, 100)));
  perform pg_temp.return_item('r9', 'pharmacist', 'sale3', 1, 'cash', 'Customer changed their mind', v_client);
  perform pg_temp.return_item('r9b', 'pharmacist', 'sale3', 1, 'cash', 'Customer changed their mind', v_client);
end $$;
select is((select coalesce(sum(quantity), 0)::int from public.stock_movements
            where movement_type = 'return' and reference_id in (pg_temp.fx('r9'), pg_temp.fx('r9b'))), 1,
  'the same return uploaded twice puts the stock back once');

select * from finish();
rollback;