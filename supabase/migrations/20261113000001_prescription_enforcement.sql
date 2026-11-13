-- =============================================================================
-- CRITICAL #2: Prescription-only (POM) enforcement on the server
-- =============================================================================
-- Before this migration, the "this drug needs a prescription" rule existed only
-- in the browser (src/components/SaleEntry.jsx). Any caller holding the public
-- anon key and a staff session could record a POM sale with no prescription.
--
-- This is enforced here as a DEFERRED constraint trigger on `sales`, so it does
-- not matter which RPC writes the sale, or in what order the sale row and its
-- sale_items rows are inserted. The check runs once at COMMIT, when both are
-- final, and raises P0001 (a permanent business rejection) so the offline
-- outbox in src/lib/powersync/flush.js stops retrying and surfaces the error.
-- =============================================================================

create or replace function public.assert_sale_prescription_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item     record;
  v_requires boolean;
begin
  for v_item in
    select si.drug_id, d.name
      from public.sale_items si
      left join public.drugs d on d.id = si.drug_id
     where si.sale_id = new.id
  loop
    -- shop_drugs is the per-shop classification and, when a row exists, it is
    -- authoritative even if its value is null ("unclassified" here means the
    -- same thing it means in SaleEntry.jsx). Only when the shop has never
    -- classified the product do we fall back to the global catalogue flag.
    select case
             when sd.shop_id is not null then sd.requires_prescription
             else d.requires_prescription
           end
      into v_requires
      from public.drugs d
      left join public.shop_drugs sd
        on sd.drug_id = d.id
       and sd.shop_id = new.shop_id
     where d.id = v_item.drug_id;

    if v_requires is null then
      raise exception
        'The product "%" has not been classified as prescription-only or over-the-counter. Set its classification in Stocked drugs before selling it.',
        coalesce(v_item.name, v_item.drug_id::text)
        using errcode = 'P0001';

    elsif v_requires then
      if nullif(btrim(coalesce(new.prescription_reference, '')), '') is null then
        raise exception 'A prescription reference is required for "%".',
          coalesce(v_item.name, 'this product') using errcode = 'P0001';
      end if;

      if nullif(btrim(coalesce(new.prescriber_name, '')), '') is null then
        raise exception 'The prescriber name is required for "%".',
          coalesce(v_item.name, 'this product') using errcode = 'P0001';
      end if;

      if new.prescription_date is null then
        raise exception 'The prescription date is required for "%".',
          coalesce(v_item.name, 'this product') using errcode = 'P0001';
      end if;

      if new.prescription_date > current_date then
        raise exception 'The prescription date for "%" cannot be in the future.',
          coalesce(v_item.name, 'this product') using errcode = 'P0001';
      end if;
    end if;
  end loop;

  return null; -- AFTER trigger: return value is ignored
end;
$$;

comment on function public.assert_sale_prescription_complete() is
  'Blocks a sale that contains a prescription-only or unclassified product without complete prescription details.';

-- Deferred → validates at COMMIT, after sale_items exist.
drop trigger if exists sales_enforce_prescription on public.sales;
create constraint trigger sales_enforce_prescription
  after insert or update on public.sales
  deferrable initially deferred
  for each row
  execute function public.assert_sale_prescription_complete();


-- -----------------------------------------------------------------------------
-- Only a pharmacist or administrator may reclassify a stocked drug.
-- -----------------------------------------------------------------------------
-- The UI already enforces this (canManageStockedDrugs in src/lib/roles.js),
-- but set_shop_drug_prescription_status is callable by any authenticated user.
-- Without this guard a cashier could downgrade a POM drug to OTC and then sell
-- it without a prescription. Enforcing it here covers every write path.
create or replace function public.assert_prescription_classifier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    public.staff;
  v_is_admin boolean;
begin
  -- Reclassifications only; an unrelated update must not be blocked.
  if tg_op = 'UPDATE'
     and new.requires_prescription is not distinct from old.requires_prescription then
    return new;
  end if;

  select * into v_actor
    from public.staff
   where auth_user_id = auth.uid()
   order by id
   limit 1;

  if v_actor.id is null then
    -- No JWT means a trusted context (SQL editor, service role, maintenance
    -- script). The anon role has no write grant on this table, so there is no
    -- anonymous path here.
    if auth.uid() is null then
      return new;
    end if;

    raise exception 'A staff account is required to change a prescription classification.'
      using errcode = 'P0001';
  end if;

  v_is_admin := lower(btrim(coalesce(v_actor.role, '')))
    in ('admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin');

  if not v_is_admin
     and lower(btrim(coalesce(v_actor.role, ''))) <> 'pharmacist' then
    raise exception 'Only a pharmacist or an administrator can change a prescription classification.'
      using errcode = 'P0001';
  end if;

  -- A pharmacist may only classify stock in their own shop; an administrator
  -- may act across shops in the same organization.
  if v_actor.shop_id <> new.shop_id and not v_is_admin then
    raise exception 'You cannot change the classification of another shop''s stock.'
      using errcode = 'P0001';
  end if;

  if v_actor.shop_id <> new.shop_id and v_is_admin and not exists (
    select 1
      from public.shops own
      join public.shops target on target.id = new.shop_id
     where own.id = v_actor.shop_id
       and own.organization_id is not distinct from target.organization_id
  ) then
    raise exception 'You cannot change the classification of another organization''s stock.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.assert_prescription_classifier() is
  'Restricts POM/OTC reclassification to pharmacists and administrators.';

drop trigger if exists shop_drugs_classifier_only on public.shop_drugs;
create trigger shop_drugs_classifier_only
  before insert or update on public.shop_drugs
  for each row
  execute function public.assert_prescription_classifier();

-- -----------------------------------------------------------------------------
-- Verification (run after applying):
--
--   -- should fail with "A prescription reference is required"
--   select public.sell_stock_with_discounts(
--     '<shop-uuid>', 'cash',
--     '[{"item_type":"drug","drug_id":"<pom-drug-uuid>","batch_id":"<batch-uuid>","quantity":1,"unit_price":10}]'::jsonb
--   );
--
--   -- should succeed
--   select public.sell_stock_with_discounts(
--     '<shop-uuid>', 'cash',
--     '[{"item_type":"drug","drug_id":"<otc-drug-uuid>","batch_id":"<batch-uuid>","quantity":1,"unit_price":10}]'::jsonb
--   );
-- -----------------------------------------------------------------------------
