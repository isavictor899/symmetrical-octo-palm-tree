# Database tests

pgTAP tests for the rules the database enforces: sales pricing and discounts,
returns, data isolation between pharmacies, subscription states and plan
limits, Sales review, temporary passwords and the Enora Labs console.

Each `*.test.sql` file runs in one transaction and ends with `ROLLBACK`. The
shared setup (`database/_fixtures.psql`) builds a test pharmacy with two shops,
staff, a second unrelated pharmacy and some stock. All of it, pgTAP included,
disappears when the file finishes, so the tests can run against any copy of
the database.

## Run

```bash
# Supabase > Connect > Session pooler (port 5432) or Direct connection
export DATABASE_URL="postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
# Optional but recommended: verify the server certificate
# (Supabase > Database settings > SSL configuration > Download certificate)
export DATABASE_CA_CERT=./prod-ca-2021.crt

npm run test:db              # all files
npm run test:db -- sales     # only files with "sales" in the name
VERBOSE=1 npm run test:db    # print every passing test too
```

Or with the Supabase CLI against a local database: `supabase test db`.

Run them after every migration, before deploying.

## Writing a test

```sql
begin;
\ir _fixtures.psql
select plan(1);

select throws_like($$ select pg_temp.sell('s1', 'cashier', 'shopA',
    jsonb_build_array(pg_temp.line('batchA', 1, 100, 30))) $$,
  '%exceeds the 25 percent limit%', 'a cashier cannot give a 30% discount');

select * from finish();
rollback;
```

Fixture keys: `org`, `shopA`, `shopB`, `admin`, `pharmacist`, `cashier`
(shop A), `cashierB` (shop B), `otherOrg`, `otherShop`, `otherAdmin`,
`paracetamol`, `batchA` (50 at KES 100 in shop A), `otherBatch`.
`pg_temp.fx('<key>')` gives the id. For people, `pg_temp.fx('cashier')` is the
login and `pg_temp.fx('cashier.staff')` the staff row.
`select pg_temp.act_as('cashier');` makes the following statements run as that
user through RLS; `reset role;` switches back.