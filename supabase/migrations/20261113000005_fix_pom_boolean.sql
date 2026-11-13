-- =============================================================================
-- HOTFIX: prescription enforcement failed with 22P02
--          "invalid input syntax for type integer: \"t\""
-- =============================================================================
-- Root cause: public.shop_drugs.requires_prescription and
-- public.drugs.requires_prescription are BOOLEAN columns (PowerSync maps them
-- to 0/1 in the local SQLite cache, which is why the client code uses
-- Number(...)). The first version of assert_sale_prescription_complete()
-- declared the variable as integer, so PL/pgSQL converted true to the text
-- 't' and then failed to parse 't' as an integer at COMMIT. Because that
-- happened on every sale with a classified drug, the outbox marked the sale
-- permanently failed (22P02 is non-retryable).
--
-- This replaces only that function. Migrations 02 and 04 can be applied
-- afterwards. 20261113000001 is already corrected for fresh installs.
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

-- Recreate the deferred trigger in case the original apply did not finish.
drop trigger if exists sales_enforce_prescription on public.sales;
create constraint trigger sales_enforce_prescription
  after insert or update on public.sales
  deferrable initially deferred
  for each row
  execute function public.assert_sale_prescription_complete();

notify pgrst, 'reload schema';
