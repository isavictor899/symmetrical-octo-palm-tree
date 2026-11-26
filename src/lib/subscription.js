import { supabase } from './supabaseClient';

// The pharmacy's subscription (plan, state, dates, limits), from
// get_my_subscription(). Cached per login so an offline till still knows it is
// read-only. The server enforces everything regardless; this only drives the
// banner and the till's checkout button.

const cacheKey = (userId) => `pharmacy-pos:subscription:${userId}`;

export function cachedSubscription(userId) {
  if (!userId) return null;
  try {
    return JSON.parse(window.localStorage.getItem(cacheKey(userId)) || 'null');
  } catch {
    return null;
  }
}

export async function fetchSubscription(userId) {
  const { data, error } = await supabase.rpc('get_my_subscription');
  if (error) return cachedSubscription(userId);
  try {
    if (data) window.localStorage.setItem(cacheKey(userId), JSON.stringify(data));
    else window.localStorage.removeItem(cacheKey(userId));
  } catch { /* storage may be unavailable */ }
  return data || null;
}

export function daysUntil(value) {
  if (!value) return null;
  return Math.ceil((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export function formatNairobiDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'long', year: 'numeric' });
}

export const PLAN_NAMES = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };

export const STATE_NAMES = {
  trial: 'Free trial',
  active: 'Active',
  complimentary: 'Active',
  grace: 'Expired, grace period',
  read_only: 'Expired, read-only',
  suspended: 'Suspended',
};

// Optional features a plan may include (same keys as the server's
// platform_features). Everything else is in every plan.
export const OPTIONAL_FEATURES = [
  ['purchase_orders', 'Purchase orders'],
  ['finance', 'Expenses & income'],
  ['stock_transfers', 'Transfers between shops'],
  ['ai_insights', 'AI monthly briefings'],
  ['advanced_reports', 'Advanced reports (purchase report, profit & loss)'],
];

export const CORE_FEATURES = 'Sales and receipts, stock and expiry tracking, barcodes, cash register, supplier debts, sales returns and Sales review';

// One short line: "Free trial · ends 12 December 2026".
export function planStatusLine(subscription) {
  if (!subscription) return '';
  const state = STATE_NAMES[subscription.state] || subscription.state;
  if (subscription.state === 'complimentary' || !subscription.expires_at) return state;
  if (subscription.state === 'grace') return `${state} until ${formatNairobiDate(subscription.grace_ends_at)}`;
  if (subscription.state === 'read_only' || subscription.state === 'suspended') return state;
  return `${state} · ${subscription.state === 'trial' ? 'ends' : 'renews by'} ${formatNairobiDate(subscription.expires_at)}`;
}