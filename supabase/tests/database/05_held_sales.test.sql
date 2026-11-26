-- Sales review: sales the server refused after the medicine was handed over
-- are held for an administrator, never lost and never recorded silently.
begin;
\ir _fixtures.psql

select plan(14);

-- Sends a sale to review as p_by, with the payload the till uploads.
create function pg_temp.hold(p_key text, p_by text, p_shop_key text, p_quantity int default 1,
                             p_sold_at timestamptz default now() - interval '2 hours') returns text
language plpgsql as $$
declare v_client uuid := gen_random_uuid(); v text;
begin
  perform pg_temp.claims_for(p_by);
  v := public.hold_rejected_sale(pg_temp.fx(p_shop_key), v_client, jsonb_build_object(
         'p_payment_method', 'cash',
         'p_items', jsonb_build_array(pg_temp.line('batchA', p_quantity, 100)),
         'p_created_by_user_id', pg_temp.fx(p_by),
         'p_sold_at', p_sold_at), 'Test: rejected by the server');
  perform set_config('request.jwt.claims', '', true);
  insert into fx values (p_key, (select id from public.held_sales where client_sale_id = v_client));
  return v;
end $$;

create function pg_temp.approve(p_held_key text, p_by text default 'admin') returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.claims_for(p_by);
  v := public.approve_held_sale(pg_temp.fx(p_held_key), 'Checked with the cashier');
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.void(p_held_key text, p_reason text, p_by text default 'admin') returns void
language plpgsql as $$
begin
  perform pg_temp.claims_for(p_by);
  perform public.void_held_sale(pg_temp.fx(p_held_key), p_reason);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.pending_count(p_by text) returns int
language plpgsql as $$
declare v int;
begin
  perform pg_temp.claims_for(p_by);
  select count(*) into v from public.held_sales_list('pending');
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

select is(pg_temp.hold('held1', 'cashier', 'shopA', 2), 'held', 'a cashier''s rejected sale is held');
do $$ begin perform pg_temp.hold('held2', 'cashier', 'shopA', 1); end $$;
select is(pg_temp.stock_left('batchA'), 50, 'holding a sale does not touch the stock');
select is(pg_temp.pending_count('admin'), 2, 'the administrator sees both held sales');
select throws_like($$ select pg_temp.pending_count('cashier') $$, '%Administrator access is required%', 'a cashier cannot open the review queue');
select is(pg_temp.pending_count('otherAdmin'), 0, 'another pharmacy does not see our held sales');
select throws_like($$ select pg_temp.hold('held3', 'cashierB', 'shopA') $$, '%not permitted%', 'staff of another shop cannot send sales for this one');

select throws_like($$ select pg_temp.approve('held1', 'otherAdmin') $$, '%not found%', 'another pharmacy cannot approve our held sale');
select throws_like($$ select pg_temp.approve('held1', 'cashier') $$, '%Administrator access is required%', 'a cashier cannot approve a held sale');
select isnt(pg_temp.approve('held1'), null, 'the administrator approves it and a sale is recorded');
select is(pg_temp.stock_left('batchA'), 48, 'approving takes the stock (2 units)');
select throws_like($$ select pg_temp.approve('held1') $$, '%already been%', 'a held sale cannot be approved twice');

select throws_like($$ select pg_temp.void('held2', 'no') $$, '%at least 5 characters%', 'voiding needs a real reason');
select lives_ok($$ select pg_temp.void('held2', 'Customer did not take the medicine') $$, 'the administrator can void a held sale');
select is((select status from public.held_sales where id = pg_temp.fx('held2')), 'voided', 'and it is marked voided, not deleted');

select * from finish();
rollback;