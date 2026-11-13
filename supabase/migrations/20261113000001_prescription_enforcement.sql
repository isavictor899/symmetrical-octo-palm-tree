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
  v_requires integer;
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

    elsif v_requires = 1 then
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
