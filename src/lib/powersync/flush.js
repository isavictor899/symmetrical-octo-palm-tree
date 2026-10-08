import { supabase } from '../supabaseClient';

const activeFlushes = new WeakMap();

function errorMessage(error) {
  return error?.message || String(error || 'Unknown server error');
}

function isPermanentRejection(error) {
  // Both stock RPCs use RAISE EXCEPTION for business-rule failures. Supabase
  // exposes these consistently as PostgreSQL's P0001 code, regardless of
  // the message text, so new server validation cannot accidentally retry
  // forever just because its wording was not added to a client-side regex.
  return error?.code === 'P0001';
}

function isAdminRole(value) {
  const role = String(value ?? '').trim().toLowerCase();
  return ['admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin'].includes(role);
}

async function flushTable(db, table, rpcName, mapArgs) {
  const rows = await db.getAll(
    `SELECT * FROM ${table} WHERE status IS NULL OR status = 'pending' ORDER BY created_at`
  );
  let uploaded = 0;
  const staffByUser = new Map();
  const organizationByShop = new Map();

  for (const row of rows) {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) return uploaded;

    let staffInfo = staffByUser.get(session.user.id);
    if (staffInfo === undefined) {
      const { data: staff, error: staffError } = await supabase
        .from('staff')
        .select('shop_id, role, shops(organization_id)')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
      staffInfo = {
        shopId: staff?.shop_id || null,
        role: staff?.role || null,
        organizationId: staff?.shops?.organization_id || null,
        lookupError: staffError || null,
      };
      staffByUser.set(session.user.id, staffInfo);
    }

    if (staffInfo.lookupError) {
      const message = `Unable to verify the current staff shop: ${errorMessage(staffInfo.lookupError)}`;
      await db.execute(
        `UPDATE ${table} SET last_error = ? WHERE id = ?`,
        [message, row.id]
      ).catch(() => {});
      console.warn(`[PowerSync] ${table} upload deferred:`, message);
      break;
    }

    if (!staffInfo.shopId) {
      const message = 'The signed-in account has no staff shop and cannot upload this transaction.';
      await db.execute(
        `UPDATE ${table} SET status = 'failed', last_error = ? WHERE id = ?`,
        [message, row.id]
      );
      continue;
    }

    let canUploadForShop = staffInfo.shopId === row.shop_id;
    if (!canUploadForShop && isAdminRole(staffInfo.role) && staffInfo.organizationId) {
      let targetOrganizationId = organizationByShop.get(row.shop_id);
      if (targetOrganizationId === undefined) {
        const { data: targetShop, error: targetShopError } = await supabase
          .from('shops')
          .select('organization_id')
          .eq('id', row.shop_id)
          .maybeSingle();
        if (targetShopError) {
          const message = `Unable to verify the transaction shop: ${errorMessage(targetShopError)}`;
          await db.execute(
            `UPDATE ${table} SET last_error = ? WHERE id = ?`,
            [message, row.id]
          ).catch(() => {});
          console.warn(`[PowerSync] ${table} upload deferred:`, message);
          break;
        }
        targetOrganizationId = targetShop?.organization_id || null;
        organizationByShop.set(row.shop_id, targetOrganizationId);
      }
      canUploadForShop = targetOrganizationId === staffInfo.organizationId;
    }

    if (!canUploadForShop) {
      const message = 'This transaction belongs to a different shop and cannot be synced by the current staff account.';
      await db.execute(
        `UPDATE ${table} SET status = 'failed', last_error = ? WHERE id = ?`,
        [message, row.id]
      );
      continue;
    }

    try {
      const { error } = await supabase.rpc(rpcName, mapArgs(row));
      if (error) throw error;
      await db.execute(`DELETE FROM ${table} WHERE id = ?`, [row.id]);
      uploaded += 1;
    } catch (error) {
      const message = errorMessage(error);
      if (isPermanentRejection(error)) {
        await db.execute(
          `UPDATE ${table} SET status = 'failed', last_error = ? WHERE id = ?`,
          [message, row.id]
        );
      } else {
        // Network/authentication failures remain retryable. Keep a diagnostic
        // message, but do not mark the transaction failed.
        await db.execute(
          `UPDATE ${table} SET last_error = ? WHERE id = ?`,
          [message, row.id]
        ).catch(() => {});
        console.warn(`[PowerSync] ${table} upload will retry:`, message);
        break;
      }
    }
  }

  return uploaded;
}

async function flushAllOnce(db) {
  if (!navigator.onLine) return;

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return;

  await flushTable(db, 'pending_sales', 'sell_stock', (row) => ({
    p_shop_id: row.shop_id,
    p_payment_method: row.payment_method,
    p_items: JSON.parse(row.items_json),
    p_client_sale_id: row.id,
    p_prescription_reference: row.prescription_reference || null,
    p_prescriber_name: row.prescriber_name || null,
    p_prescription_date: row.prescription_date || null,
  }));

  await flushTable(db, 'pending_receipts', 'receive_stock', (row) => ({
    p_shop_id: row.shop_id,
    p_drug_id: row.drug_id,
    p_supplier_id: row.supplier_id || null,
    p_supplier_name: row.supplier_name || null,
    p_batch_number: row.batch_number || null,
    p_expiry_date: row.expiry_date,
    p_cost_price: row.cost_price,
    p_selling_price: row.selling_price,
    p_quantity: row.quantity,
    p_client_batch_id: row.id,
    p_initial_requires_prescription: row.initial_requires_prescription === null
      || row.initial_requires_prescription === undefined
      || row.initial_requires_prescription === ''
      ? null
      : Number(row.initial_requires_prescription) === 1,
  }));
}

export function flushAll(db) {
  const active = activeFlushes.get(db);
  if (active) return active;

  const flush = flushAllOnce(db)
    .catch((error) => console.warn('[PowerSync] Outbox flush deferred:', error))
    .finally(() => activeFlushes.delete(db));
  activeFlushes.set(db, flush);
  return flush;
}

export const flushPendingSales = flushAll;
export const flushPendingReceipts = flushAll;

