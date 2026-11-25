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