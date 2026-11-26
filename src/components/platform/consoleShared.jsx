// Shared pieces of the Enora Labs console: formatting, labels, modal shell,
// and the call into the platform-admin edge function.
import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

export const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 });
export const DAY_MS = 24 * 60 * 60 * 1000;

export const STATE_LABELS = {
  active: 'Active',
  trial: 'Trial',
  complimentary: 'Complimentary',
  grace: 'Grace period',
  read_only: 'Read-only',
  suspended: 'Suspended',
};
export const PLAN_LABELS = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
export const PLAN_DEFAULTS = { basic: { shops: 1, staff: 5 }, pro: { shops: 5, staff: 25 }, enterprise: { shops: null, staff: null } };
export const METHOD_LABELS = { mpesa: 'M-Pesa', bank: 'Bank', cash: 'Cash', other: 'Other' };
export const ACTION_LABELS = {
  onboarded: 'Pharmacy onboarded',
  plan_changed: 'Plan changed',
  payment_recorded: 'Payment recorded',
  payment_voided: 'Payment voided',
  dates_changed: 'Dates changed',
  suspended: 'Suspended',
  reactivated: 'Reactivated',
  notes_updated: 'Notes updated',
  admin_password_reset: 'Admin password reset',
  feature_override: 'Feature switched for this pharmacy',
  plan_feature_changed: 'Plan features changed',
  announcement_saved: 'Announcement saved',
  announcement_ended: 'Announcement ended',
  team_member_added: 'Console member added',
  team_member_removed: 'Console member removed',
  team_role_changed: 'Console role changed',
  team_mfa_reset: 'Console authenticator reset',
};

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeDays(value) {
  if (!value) return '';
  const days = Math.round((new Date(value) - Date.now()) / DAY_MS);
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
}

// yyyy-mm-dd in Nairobi, for <input type="date">.
export function dateInputValue(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// End of that day in Nairobi.
export function endOfNairobiDay(dateText) {
  return dateText ? new Date(`${dateText}T23:59:59+03:00`).toISOString() : null;
}

export function limitText(used, limit) {
  return limit == null ? `${used} / unlimited` : `${used} / ${limit}`;
}

export function StateBadge({ state }) {
  return <span className={`console-state ${state}`}>{STATE_LABELS[state] || state}</span>;
}

export async function callPlatformFunction(body) {
  const { data, error } = await supabase.functions.invoke('platform-admin', { body });
  if (error) {
    let message = error.message;
    try {
      const payload = await error.context?.json?.();
      if (payload?.error) message = payload.error;
    } catch { /* keep the generic message */ }
    throw new Error(message || 'The request failed.');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export function csvCell(value) {
  const textValue = value == null ? '' : String(value);
  return /[",\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

export function exportCsv(rows) {
  const columns = [
    ['Pharmacy', 'name'], ['Plan', (row) => PLAN_LABELS[row.plan]], ['Status', (row) => STATE_LABELS[row.state]],
    ['Expires', (row) => dateInputValue(row.expires_at)], ['Trial ends', (row) => dateInputValue(row.trial_ends_at)],
    ['Paid until', (row) => dateInputValue(row.paid_until)], ['Shops', 'shops'], ['Active staff', 'active_staff'],
    ['Sales (30 days)', 'sales_30d'], ['Sales value (30 days)', 'sales_total_30d'], ['Last sale', (row) => dateInputValue(row.last_sale_at)],
    ['Last sign-in', (row) => dateInputValue(row.last_sign_in_at)], ['Total paid', 'total_paid'],
    ['Contact', 'contact_name'], ['Contact phone', 'contact_phone'], ['Contact email', 'contact_email'],
    ['Admin', 'admin_name'], ['Admin email', 'admin_email'], ['Joined', (row) => dateInputValue(row.created_at)],
  ];
  const lines = [columns.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, key]) => csvCell(typeof key === 'function' ? key(row) : row[key])).join(','));
  }
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pharmacies-${dateInputValue(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
export function Modal({ title, children, onClose, onSubmit, submitLabel, working, danger, error, wide }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <form className={`classification-modal console-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
        <h3>{title}</h3>
        {children}
        {error ? <p className="error console-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={working}>{onSubmit ? 'Cancel' : 'Close'}</button>
          {onSubmit ? <button type="submit" className={danger ? 'danger-button' : undefined} disabled={working}>{working ? 'Working…' : submitLabel}</button> : null}
        </div>
      </form>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="classification-reason">
      <span>{label}{hint ? <span className="muted"> {hint}</span> : null}</span>
      {children}
    </label>
  );
}

export function CredentialsModal({ credentials, onClose }) {
  const [copied, setCopied] = useState(false);
  const message = `Your Pharmacy POS login\nWebsite: https://pos.enoralabs.co.ke\nEmail: ${credentials.email}\nTemporary password: ${credentials.temporary_password}\nYou will be asked to choose your own password when you sign in.`;
  return (
    <Modal title={credentials.title} onClose={onClose}>
      <p className="muted small">Share these with the pharmacy owner now. The password is shown only once; they must change it at first sign-in.</p>
      <dl className="staff-credentials console-credentials">
        <dt>Website</dt><dd>pos.enoralabs.co.ke</dd>
        <dt>Email</dt><dd>{credentials.email}</dd>
        <dt>Password</dt><dd><code>{credentials.temporary_password}</code></dd>
      </dl>
      <div className="console-credential-actions">
        <button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(message); setCopied(true); } catch { setCopied(false); } }}>
          {copied ? 'Copied' : 'Copy message'}
        </button>
        <a className="secondary-button" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">Send by WhatsApp</a>
      </div>
    </Modal>
  );
}