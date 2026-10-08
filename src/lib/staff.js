import { supabase } from './supabaseClient';

// Single source of truth for "get this user's staff row into the local
// PowerSync database". Previously this logic was copy-pasted into App,
// SaleEntry and ReceiveStock.

const STAFF_COLUMNS = 'id, shop_id, full_name, role, auth_user_id';

function toStaff(row) {
  return { id: row.id, shopId: row.shop_id, role: row.role };
}

// Reads the signed-in user's staff row from the LOCAL database (works
// offline). Returns null when there isn't one yet — db.get() throws on an
// empty result set, and any other local read failure is treated the same way.
export async function readLocalStaff(db, userId) {
  try {
    const row = await db.get('SELECT id, shop_id, role FROM staff WHERE auth_user_id = ?', [userId]);
    return row ? toStaff(row) : null;
  } catch (err) {
    console.warn('[staff] no local staff row for', userId, err?.message || err);
    return null;
  }
}

// Fetches the staff row from Supabase and stores it locally so the app can
// resolve the shop offline next time. Throws if there is no row or the
// request fails.
export async function syncStaffFromRemote(db, userId) {
  const { data: remoteRow, error } = await supabase
    .from('staff')
    .select(STAFF_COLUMNS)
    .eq('auth_user_id', userId)
    .single();

  if (error || !remoteRow) {
    throw new Error(error?.message || 'No remote staff row found');
  }

  await db.execute(
    'INSERT OR REPLACE INTO staff (id, shop_id, full_name, role, auth_user_id) VALUES (?, ?, ?, ?, ?)',
    [remoteRow.id, remoteRow.shop_id, remoteRow.full_name || '', remoteRow.role || '', remoteRow.auth_user_id]
  );

  return toStaff(remoteRow);
}

// For code that only needs the row to exist locally (App, right after
// sign-in). Never throws.
export async function ensureLocalStaff(db, userId) {
  const local = await readLocalStaff(db, userId);
  if (local) return local;

  try {
    return await syncStaffFromRemote(db, userId);
  } catch (err) {
    console.error('[staff] failed to fetch or insert remote staff row:', err);
    return null;
  }
}