import { supabase } from './supabaseClient';

// All staff changes go through the manage-staff Edge Function. The browser never
// creates logins itself; the function checks the caller is an admin of the shop's
// organization before anything happens.
export async function callManageStaff(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('manage-staff', {
    body: { action, ...payload },
  });

  if (error) {
    // The function returns { error: "message for the user" } with a 4xx/5xx status.
    let message = '';
    try {
      const body = await error.context?.json?.();
      message = body?.error || '';
    } catch {
      // Response body was not JSON; fall through to the generic message.
    }
    if (!message && typeof navigator !== 'undefined' && navigator.onLine === false) {
      message = 'You are offline. Staff changes need an internet connection.';
    }
    throw new Error(message || error.message || 'The staff request failed. Please try again.');
  }

  if (data?.error) throw new Error(data.error);
  return data;
}

// Readable temporary password: no look-alike characters (0/O, 1/l/I), easy to read
// out loud or write on a slip of paper for a new staff member.
export function generateTemporaryPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let password = '';
  for (const value of values) password += alphabet[value % alphabet.length];
  return password;
}

export const STAFF_ROLES = [
  { value: 'cashier', label: 'Cashier', help: 'Sells and prints receipts. No stock, refunds or reports.' },
  { value: 'pharmacist', label: 'Pharmacist', help: 'Sells, receives stock, counts stock, refunds, POM classification.' },
  { value: 'admin', label: 'Administrator', help: 'Everything, across all shops: staff, reports, finance, settings.' },
];

export const MIN_PASSWORD_LENGTH = 8;