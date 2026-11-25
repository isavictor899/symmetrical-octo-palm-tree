import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconArrowLeft, IconDownload, IconLogout2, IconPlus, IconRefresh } from '@tabler/icons-react';
import { supabase } from '../../lib/supabaseClient';
import './PlatformConsole.css';

const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 });
const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_LABELS = {
  active: 'Active',
  trial: 'Trial',
  complimentary: 'Complimentary',
  grace: 'Grace period',
  read_only: 'Read-only',
  suspended: 'Suspended',
};
const PLAN_LABELS = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
const PLAN_DEFAULTS = { basic: { shops: 1, staff: 5 }, pro: { shops: 5, staff: 25 }, enterprise: { shops: null, staff: null } };
const METHOD_LABELS = { mpesa: 'M-Pesa', bank: 'Bank', cash: 'Cash', other: 'Other' };
const ACTION_LABELS = {
  onboarded: 'Pharmacy onboarded',
  plan_changed: 'Plan changed',
  payment_recorded: 'Payment recorded',
  payment_voided: 'Payment voided',
  dates_changed: 'Dates changed',
  suspended: 'Suspended',
  reactivated: 'Reactivated',
  notes_updated: 'Notes updated',
  admin_password_reset: 'Admin password reset',
};

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeDays(value) {
  if (!value) return '';
  const days = Math.round((new Date(value) - Date.now()) / DAY_MS);
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
}

// yyyy-mm-dd in Nairobi, for <input type="date">.
function dateInputValue(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// End of that day in Nairobi.
function endOfNairobiDay(dateText) {
  return dateText ? new Date(`${dateText}T23:59:59+03:00`).toISOString() : null;
}

function limitText(used, limit) {
  return limit == null ? `${used} / unlimited` : `${used} / ${limit}`;
}

function StateBadge({ state }) {
  return <span className={`console-state ${state}`}>{STATE_LABELS[state] || state}</span>;
}

async function callPlatformFunction(body) {
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

function csvCell(value) {
  const textValue = value == null ? '' : String(value);
  return /[",\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

function exportCsv(rows) {
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
function Modal({ title, children, onClose, onSubmit, submitLabel, working, danger, error, wide }) {
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

function Field({ label, hint, children }) {
  return (
    <label className="classification-reason">
      <span>{label}{hint ? <span className="muted"> {hint}</span> : null}</span>
      {children}
    </label>
  );
}

function CredentialsModal({ credentials, onClose }) {
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

function OnboardModal({ onClose, onDone }) {
  const [form, setForm] = useState({
    organization_name: '', plan: 'basic', trial_days: '14', shop_name: '', shop_location: '', shop_phone: '',
    admin_name: '', admin_email: '', admin_phone: '',
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    setWorking(true);
    setError('');
    try {
      const result = await callPlatformFunction({
        action: 'onboard',
        ...form,
        shop_name: form.shop_name.trim() || form.organization_name.trim(),
        trial_days: Number(form.trial_days),
      });
      onDone({ ...result, title: `${form.organization_name.trim()} is ready` });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal title="Onboard a pharmacy" onClose={onClose} onSubmit={submit} submitLabel="Create pharmacy" working={working} error={error} wide>
      <div className="console-form-grid">
        <Field label="Pharmacy name"><input required value={form.organization_name} onChange={(event) => update('organization_name', event.target.value)} placeholder="e.g. Afya Bora Chemist" /></Field>
        <Field label="Plan">
          <select value={form.plan} onChange={(event) => update('plan', event.target.value)}>
            <option value="basic">Basic (1 shop, 5 staff)</option>
            <option value="pro">Pro (5 shops, 25 staff)</option>
            <option value="enterprise">Enterprise (unlimited)</option>
          </select>
        </Field>
        <Field label="Free trial" hint="(days, 0 for none)"><input type="number" min="0" max="90" required value={form.trial_days} onChange={(event) => update('trial_days', event.target.value)} /></Field>
        <Field label="First shop name" hint="(optional)"><input value={form.shop_name} onChange={(event) => update('shop_name', event.target.value)} placeholder="Same as pharmacy name" /></Field>
        <Field label="Shop location"><input value={form.shop_location} onChange={(event) => update('shop_location', event.target.value)} placeholder="e.g. Nakuru town" /></Field>
        <Field label="Shop phone"><input value={form.shop_phone} onChange={(event) => update('shop_phone', event.target.value)} /></Field>
      </div>
      <h4 className="console-subhead">Owner&apos;s administrator login</h4>
      <div className="console-form-grid">
        <Field label="Full name"><input required value={form.admin_name} onChange={(event) => update('admin_name', event.target.value)} /></Field>
        <Field label="Email"><input type="email" required value={form.admin_email} onChange={(event) => update('admin_email', event.target.value)} /></Field>
        <Field label="Phone"><input value={form.admin_phone} onChange={(event) => update('admin_phone', event.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function PaymentModal({ org, onClose, onDone }) {
  const [form, setForm] = useState({ amount: '', method: 'mpesa', reference: '', paid_at: dateInputValue(new Date()), months: '1', note: '' });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const start = new Date(Math.max(Date.now(), org.paid_until ? new Date(org.paid_until).getTime() : 0));
  const preview = new Date(start);
  preview.setMonth(preview.getMonth() + Number(form.months || 0));

  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_record_payment', {
      p_org: org.id,
      p_amount: Number(form.amount),
      p_method: form.method,
      p_reference: form.reference.trim() || null,
      p_paid_at: new Date(`${form.paid_at}T12:00:00+03:00`).toISOString(),
      p_months: Number(form.months),
      p_note: form.note.trim() || null,
    });
    setWorking(false);
    if (rpcError) setError(rpcError.message);
    else onDone(`Payment recorded. ${org.name} is paid until ${formatDate(preview)}.`);
  }

  return (
    <Modal title={`Record payment: ${org.name}`} onClose={onClose} onSubmit={submit} submitLabel="Record payment" working={working} error={error}>
      <div className="console-form-grid two">
        <Field label="Amount (KSh)"><input type="number" min="1" step="1" required value={form.amount} onChange={(event) => update('amount', event.target.value)} /></Field>
        <Field label="Months paid for">
          <select value={form.months} onChange={(event) => update('months', event.target.value)}>
            {[1, 2, 3, 6, 12, 24].map((months) => <option key={months} value={months}>{months} month{months === 1 ? '' : 's'}</option>)}
          </select>
        </Field>
        <Field label="Paid by">
          <select value={form.method} onChange={(event) => update('method', event.target.value)}>
            {Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={form.method === 'mpesa' ? 'M-Pesa code' : 'Reference'} hint={form.method === 'mpesa' || form.method === 'bank' ? '' : '(optional)'}>
          <input value={form.reference} onChange={(event) => update('reference', event.target.value.toUpperCase())} required={form.method === 'mpesa' || form.method === 'bank'} placeholder={form.method === 'mpesa' ? 'e.g. SKL4X7P2QR' : ''} />
        </Field>
        <Field label="Date paid"><input type="date" required value={form.paid_at} max={dateInputValue(new Date())} onChange={(event) => update('paid_at', event.target.value)} /></Field>
      </div>
      <Field label="Note" hint="(optional)"><input value={form.note} onChange={(event) => update('note', event.target.value)} /></Field>
      <p className="muted small">Access will run until <strong>{formatDate(preview)}</strong>. Paying before the current end date adds to it; paying after it starts from today.</p>
    </Modal>
  );
}

function PlanModal({ org, onClose, onDone }) {
  const [plan, setPlan] = useState(org.plan);
  const [custom, setCustom] = useState(false);
  const [maxShops, setMaxShops] = useState('');
  const [maxStaff, setMaxStaff] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const defaults = PLAN_DEFAULTS[plan];

  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_set_plan', {
      p_org: org.id,
      p_plan: plan,
      p_max_shops: custom && maxShops ? Number(maxShops) : null,
      p_max_staff: custom && maxStaff ? Number(maxStaff) : null,
    });
    setWorking(false);
    if (rpcError) setError(rpcError.message);
    else onDone(`${org.name} is now on ${PLAN_LABELS[plan]}.`);
  }

  return (
    <Modal title={`Change plan: ${org.name}`} onClose={onClose} onSubmit={submit} submitLabel="Save plan" working={working} error={error}>
      <Field label="Plan">
        <select value={plan} onChange={(event) => setPlan(event.target.value)}>
          {Object.entries(PLAN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <p className="muted small">
        Default limits: {defaults.shops == null ? 'unlimited shops and staff' : `${defaults.shops} shop${defaults.shops === 1 ? '' : 's'}, ${defaults.staff} active staff`}.
        They use {org.shops} shop{org.shops === 1 ? '' : 's'} and {org.active_staff} active staff now. Lowering a limit never removes anything; it only stops them adding more.
      </p>
      <label className="console-check"><input type="checkbox" checked={custom} onChange={(event) => setCustom(event.target.checked)} /> Custom limits for this pharmacy</label>
      {custom ? (
        <div className="console-form-grid two">
          <Field label="Max shops" hint="(blank = plan default)"><input type="number" min="1" value={maxShops} onChange={(event) => setMaxShops(event.target.value)} /></Field>
          <Field label="Max active staff" hint="(blank = plan default)"><input type="number" min="1" value={maxStaff} onChange={(event) => setMaxStaff(event.target.value)} /></Field>
        </div>
      ) : null}
    </Modal>
  );
}

function DatesModal({ org, onClose, onDone }) {
  const [trialEnds, setTrialEnds] = useState(dateInputValue(org.trial_ends_at));
  const [paidUntil, setPaidUntil] = useState(dateInputValue(org.paid_until));
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_set_dates', {
      p_org: org.id, p_trial_ends_at: endOfNairobiDay(trialEnds), p_paid_until: endOfNairobiDay(paidUntil), p_reason: reason,
    });
    setWorking(false);
    if (rpcError) setError(rpcError.message);
    else onDone(`Dates updated for ${org.name}.`);
  }

  return (
    <Modal title={`Trial and paid-until dates: ${org.name}`} onClose={onClose} onSubmit={submit} submitLabel="Save dates" working={working} error={error}>
      <p className="muted small">Use this to extend a trial or correct a date. Payments extend the paid-until date automatically. Leave both blank for a complimentary account that never expires.</p>
      <div className="console-form-grid two">
        <Field label="Trial ends"><input type="date" value={trialEnds} onChange={(event) => setTrialEnds(event.target.value)} /></Field>
        <Field label="Paid until"><input type="date" value={paidUntil} onChange={(event) => setPaidUntil(event.target.value)} /></Field>
      </div>
      <div className="console-quick">
        {[7, 14, 30].map((days) => (
          <button key={days} type="button" className="table-action" onClick={() => setTrialEnds(dateInputValue(new Date(Math.max(Date.now(), org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : 0) + days * DAY_MS)))}>
            Trial +{days} days
          </button>
        ))}
      </div>
      <Field label="Reason"><input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Trial extended while they set up stock" /></Field>
    </Modal>
  );
}

function SuspendModal({ org, onClose, onDone }) {
  const suspending = org.state !== 'suspended';
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_set_suspended', { p_org: org.id, p_suspended: suspending, p_reason: reason || null });
    setWorking(false);
    if (rpcError) setError(rpcError.message);
    else onDone(suspending ? `${org.name} is suspended.` : `${org.name} is reactivated.`);
  }

  return (
    <Modal title={`${suspending ? 'Suspend' : 'Reactivate'} ${org.name}?`} onClose={onClose} onSubmit={submit}
      submitLabel={suspending ? 'Suspend pharmacy' : 'Reactivate'} working={working} error={error} danger={suspending}>
      <p className="muted small">
        {suspending
          ? 'Every shop stops recording sales and stock straight away, and staff see a suspended notice with the reason below. Their data stays intact. Offline sales made meanwhile are kept for review.'
          : 'They can record sales and stock again immediately (subject to their subscription dates).'}
      </p>
      {suspending ? <Field label="Reason (shown to the pharmacy)"><input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Invoice for October is overdue" /></Field> : null}
    </Modal>
  );
}

function VoidPaymentModal({ payment, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_void_payment', { p_payment_id: payment.id, p_reason: reason });
    setWorking(false);
    if (rpcError) setError(rpcError.message);
    else onDone('Payment voided.');
  }
  return (
    <Modal title={`Void payment of ${money.format(payment.amount)}?`} onClose={onClose} onSubmit={submit} submitLabel="Void payment" working={working} error={error} danger>
      <p className="muted small">It stops counting as revenue. If it was the latest payment, the paid-until date goes back to what it was before; otherwise correct the date under Edit dates.</p>
      <Field label="Reason"><input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Recorded twice by mistake" /></Field>
    </Modal>
  );
}

function PasswordModal({ onClose }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function submit() {
    if (password.length < 12) { setError('Use at least 12 characters for the console account.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setWorking(true);
    setError('');
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setWorking(false);
    if (updateError) setError(updateError.message);
    else setDone(true);
  }
  if (done) return <Modal title="Password changed" onClose={onClose}><p className="muted small">Use the new password next time you sign in.</p></Modal>;
  return (
    <Modal title="Change your password" onClose={onClose} onSubmit={submit} submitLabel="Change password" working={working} error={error}>
      <Field label="New password" hint="(at least 12 characters)"><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <Field label="Repeat it"><input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pharmacy detail
// ---------------------------------------------------------------------------
function NotesForm({ orgId, notes, onSaved }) {
  const [form, setForm] = useState({
    contact_name: notes?.contact_name || '', contact_phone: notes?.contact_phone || '',
    contact_email: notes?.contact_email || '', notes: notes?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setStatus(''); };

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    const { error } = await supabase.rpc('platform_save_notes', {
      p_org: orgId, p_contact_name: form.contact_name, p_contact_phone: form.contact_phone, p_contact_email: form.contact_email, p_notes: form.notes,
    });
    setSaving(false);
    setStatus(error ? error.message : 'Saved');
    if (!error) onSaved?.();
  }

  return (
    <form className="console-card console-notes" onSubmit={save}>
      <div className="console-card-head"><h3>Billing contact and notes</h3><span className="muted small">Only Enora Labs sees this</span></div>
      <div className="console-form-grid">
        <Field label="Contact name"><input value={form.contact_name} onChange={(event) => update('contact_name', event.target.value)} /></Field>
        <Field label="Phone"><input value={form.contact_phone} onChange={(event) => update('contact_phone', event.target.value)} /></Field>
        <Field label="Email"><input type="email" value={form.contact_email} onChange={(event) => update('contact_email', event.target.value)} /></Field>
      </div>
      <Field label="Notes"><textarea rows={4} value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Agreed price, payment day, support history…" /></Field>
      <div className="console-notes-actions">
        {status ? <span className={status === 'Saved' ? 'success small' : 'error small'}>{status}</span> : null}
        <button type="submit" className="save-button" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function PharmacyDetail({ org, onBack, onChanged, openModal }) {
  const [tab, setTab] = useState('overview');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  const loadDetail = useCallback(async () => {
    setError('');
    const { data, error: rpcError } = await supabase.rpc('platform_organization_detail', { p_org: org.id });
    if (rpcError) setError(rpcError.message);
    else setDetail(data);
  }, [org.id]);

  useEffect(() => { loadDetail(); }, [loadDetail, org]);

  const afterChange = (message) => { onChanged(message); loadDetail(); };

  return (
    <section className="console-detail" aria-label={org.name}>
      <button type="button" className="console-back" onClick={onBack}><IconArrowLeft size={16} /> All pharmacies</button>
      <header className="console-detail-head">
        <div>
          <h2>{org.name}</h2>
          <p className="muted small">{PLAN_LABELS[org.plan]} plan · joined {formatDate(org.created_at)}</p>
        </div>
        <StateBadge state={org.state} />
      </header>

      <div className="console-actions">
        <button type="button" className="save-button" onClick={() => openModal({ type: 'payment', org, onDone: afterChange })}>Record payment</button>
        <button type="button" className="secondary-button" onClick={() => openModal({ type: 'plan', org, onDone: afterChange })}>Change plan</button>
        <button type="button" className="secondary-button" onClick={() => openModal({ type: 'dates', org, onDone: afterChange })}>Edit dates</button>
        <button type="button" className={org.state === 'suspended' ? 'secondary-button' : 'secondary-button console-danger'} onClick={() => openModal({ type: 'suspend', org, onDone: afterChange })}>
          {org.state === 'suspended' ? 'Reactivate' : 'Suspend'}
        </button>
      </div>

      {org.state === 'suspended' && org.suspended_reason ? <p className="console-banner danger">Suspended: {org.suspended_reason}</p> : null}
      {org.state === 'grace' ? <p className="console-banner warning">Expired {relativeDays(org.expires_at)}. Becomes read-only {relativeDays(new Date(new Date(org.expires_at).getTime() + 7 * DAY_MS))}.</p> : null}
      {org.state === 'read_only' ? <p className="console-banner danger">Read-only since {formatDate(new Date(new Date(org.expires_at).getTime() + 7 * DAY_MS))}. Record a payment to restore it.</p> : null}

      <div className="review-tabs console-tabs" role="tablist">
        {[['overview', 'Overview'], ['shops', 'Shops & staff'], ['payments', 'Payments'], ['activity', 'Activity']].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!detail && !error ? <p className="muted">Loading…</p> : null}

      {detail && tab === 'overview' ? (
        <div className="console-overview-grid">
          <div className="console-card">
            <div className="console-card-head"><h3>Subscription</h3></div>
            <dl className="console-facts">
              <dt>Status</dt><dd><StateBadge state={org.state} /></dd>
              <dt>Access until</dt><dd>{org.expires_at ? `${formatDate(org.expires_at)} (${relativeDays(org.expires_at)})` : 'No end date'}</dd>
              <dt>Trial ends</dt><dd>{formatDate(org.trial_ends_at)}</dd>
              <dt>Paid until</dt><dd>{formatDate(org.paid_until)}</dd>
              <dt>Shops</dt><dd>{limitText(org.shops, org.shop_limit)}</dd>
              <dt>Active staff</dt><dd>{limitText(org.active_staff, org.staff_limit)}</dd>
              <dt>Total paid</dt><dd>{money.format(Number(org.total_paid || 0))}</dd>
            </dl>
          </div>
          <div className="console-card">
            <div className="console-card-head"><h3>Usage</h3></div>
            <dl className="console-facts">
              <dt>Sales, last 30 days</dt><dd>{org.sales_30d} ({money.format(Number(org.sales_total_30d || 0))})</dd>
              <dt>Last sale</dt><dd>{formatDateTime(org.last_sale_at)}</dd>
              <dt>Last sign-in</dt><dd>{formatDateTime(org.last_sign_in_at)}</dd>
              <dt>Held sales waiting</dt><dd>{org.held_sales}</dd>
              <dt>Administrator</dt><dd>{org.admin_name || '—'}{org.admin_email ? <div className="muted small">{org.admin_email}{org.admin_phone ? ` · ${org.admin_phone}` : ''}</div> : null}</dd>
            </dl>
          </div>
          <NotesForm key={org.id} orgId={org.id} notes={detail.notes} onSaved={() => onChanged('')} />
        </div>
      ) : null}

      {detail && tab === 'shops' ? (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Shop</th><th>Location</th><th>Phone</th><th>Sales (30 days)</th><th>Last sale</th></tr></thead>
              <tbody>
                {detail.shops.map((shop) => (
                  <tr key={shop.id}><td><strong>{shop.name}</strong></td><td>{shop.location || '—'}</td><td>{shop.phone || '—'}</td>
                    <td>{shop.sales_30d} · {money.format(Number(shop.sales_total_30d || 0))}</td><td>{formatDateTime(shop.last_sale_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap console-gap">
            <table>
              <thead><tr><th>Staff</th><th>Role</th><th>Shop</th><th>Last sign-in</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {detail.staff.map((member) => (
                  <tr key={member.id} className={member.is_active ? '' : 'staff-row-inactive'}>
                    <td><strong>{member.name}</strong><div className="muted small">{member.email || '—'}{member.phone ? ` · ${member.phone}` : ''}</div></td>
                    <td>{member.role}</td><td>{member.shop}</td><td>{formatDateTime(member.last_sign_in_at)}</td>
                    <td>{member.is_active ? 'Active' : 'Deactivated'}</td>
                    <td>{member.is_active && member.role === 'admin'
                      ? <button type="button" className="table-action" onClick={() => openModal({ type: 'reset', member, org, onDone: afterChange })}>Reset password</button>
                      : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">The pharmacy manages its own staff. From here you can only reset an administrator&apos;s password, for when the owner is locked out.</p>
        </>
      ) : null}

      {detail && tab === 'payments' ? (
        detail.payments.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Paid</th><th>Amount</th><th>Method</th><th>Months</th><th>Access until</th><th>Note</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {detail.payments.map((payment) => (
                  <tr key={payment.id} className={payment.voided_at ? 'console-voided' : ''}>
                    <td>{formatDate(payment.paid_at)}</td>
                    <td>{money.format(Number(payment.amount))}</td>
                    <td>{METHOD_LABELS[payment.method]}{payment.reference ? <div className="muted small">{payment.reference}</div> : null}</td>
                    <td>{payment.months}</td>
                    <td>{formatDate(payment.paid_until_after)}</td>
                    <td>{payment.voided_at ? <span className="error small">Voided: {payment.void_reason}</span> : (payment.note || '—')}</td>
                    <td>{payment.voided_at ? null : <button type="button" className="table-action danger" onClick={() => openModal({ type: 'void', payment, onDone: afterChange })}>Void</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="review-empty">No payments recorded yet.</p>
      ) : null}

      {detail && tab === 'activity' ? (
        detail.audit.length ? (
          <ol className="console-audit">
            {detail.audit.map((entry, index) => (
              <li key={index}>
                <strong>{ACTION_LABELS[entry.action] || entry.action}</strong>
                <span className="muted small"> · {formatDateTime(entry.created_at)}{entry.actor_email ? ` · ${entry.actor_email}` : ''}</span>
                {entry.details && Object.keys(entry.details).length ? <code className="console-audit-details">{JSON.stringify(entry.details)}</code> : null}
              </li>
            ))}
          </ol>
        ) : <p className="review-empty">No console activity yet.</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------
export default function PlatformConsole({ email, onOpenPos }) {
  const [overview, setOverview] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [overviewResult, orgsResult] = await Promise.all([
      supabase.rpc('platform_overview'),
      supabase.rpc('platform_organizations'),
    ]);
    const failure = overviewResult.error || orgsResult.error;
    if (failure) setError(failure.message);
    else {
      setOverview(overviewResult.data);
      setOrgs(orgsResult.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orgs.filter((org) => {
      if (stateFilter === 'attention' && !['grace', 'read_only', 'suspended'].includes(org.state)) return false;
      if (stateFilter === 'expiring' && !(['active', 'trial'].includes(org.state) && org.expires_at && new Date(org.expires_at) - Date.now() <= 14 * DAY_MS)) return false;
      if (!['all', 'attention', 'expiring'].includes(stateFilter) && org.state !== stateFilter) return false;
      if (!term) return true;
      return [org.name, org.admin_name, org.admin_email, org.contact_name, org.contact_phone, org.contact_email]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
  }, [orgs, search, stateFilter]);

  const selected = orgs.find((org) => org.id === selectedId) || null;

  function openModal(next) { setMessage(''); setModal(next); }
  function closeModal() { setModal(null); }
  function changed(text) {
    setModal(null);
    if (text) setMessage(text);
    load();
  }

  return (
    <div className="console-shell">
      <header className="console-topbar">
        <div className="console-brand"><strong>Enora Labs</strong><span>Pharmacy POS console</span></div>
        <div className="console-topbar-actions">
          {onOpenPos ? <button type="button" className="secondary-button" onClick={onOpenPos}>Open POS</button> : null}
          <span className="muted small console-email">{email}</span>
          <button type="button" className="secondary-button" onClick={() => openModal({ type: 'password' })}>Change password</button>
          <button type="button" className="secondary-button" onClick={() => supabase.auth.signOut()}><IconLogout2 size={16} /> Sign out</button>
        </div>
      </header>

      <main className="console-main">
        {message ? <p className="console-banner success" role="status">{message}</p> : null}
        {error ? <p className="console-banner danger">{error}</p> : null}

        {selected ? (
          <PharmacyDetail org={selected} onBack={() => setSelectedId(null)} onChanged={changed} openModal={openModal} />
        ) : (
          <>
            <div className="section-header">
              <div>
                <h2>Pharmacies</h2>
                <p className="muted">Subscriptions, plans and usage. Business figures only: no customer or prescription data is shown here.</p>
              </div>
              <button type="button" className="save-button" onClick={() => openModal({ type: 'onboard' })}><IconPlus size={16} /> Onboard pharmacy</button>
            </div>

            {overview ? (
              <div className="console-stats">
                <button type="button" className="console-stat" onClick={() => setStateFilter('all')}><span>Pharmacies</span><strong>{overview.pharmacies}</strong><small>{overview.shops} shops · {overview.active_staff} staff</small></button>
                <button type="button" className="console-stat" onClick={() => setStateFilter('active')}><span>Paying</span><strong>{overview.active}</strong><small>{overview.trial} on trial · {overview.complimentary} complimentary</small></button>
                <button type="button" className={`console-stat${overview.expiring_14_days ? ' warn' : ''}`} onClick={() => setStateFilter('expiring')}><span>Expiring in 14 days</span><strong>{overview.expiring_14_days}</strong><small>Chase renewals</small></button>
                <button type="button" className={`console-stat${overview.grace + overview.read_only + overview.suspended ? ' danger' : ''}`} onClick={() => setStateFilter('attention')}><span>Need attention</span><strong>{overview.grace + overview.read_only + overview.suspended}</strong><small>{overview.grace} grace · {overview.read_only} read-only · {overview.suspended} suspended</small></button>
                <div className="console-stat"><span>Revenue this month</span><strong>{money.format(Number(overview.revenue_this_month || 0))}</strong><small>{money.format(Number(overview.revenue_last_12_months || 0))} in 12 months</small></div>
                <div className="console-stat"><span>Sales today</span><strong>{overview.sales_today}</strong><small>Across all pharmacies</small></div>
              </div>
            ) : null}

            <div className="console-toolbar">
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, owner, phone or email" aria-label="Search pharmacies" />
              <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label="Filter by status">
                <option value="all">All statuses</option>
                <option value="attention">Needs attention</option>
                <option value="expiring">Expiring in 14 days</option>
                {Object.entries(STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" className="secondary-button" onClick={load} disabled={loading}><IconRefresh size={16} /> {loading ? 'Loading…' : 'Refresh'}</button>
              <button type="button" className="secondary-button" onClick={() => exportCsv(filtered)} disabled={!filtered.length}><IconDownload size={16} /> Export CSV</button>
            </div>

            {!loading && !filtered.length ? <p className="review-empty">{orgs.length ? 'No pharmacies match.' : 'No pharmacies yet. Onboard your first one.'}</p> : null}
            {filtered.length ? (
              <div className="table-wrap">
                <table className="console-table">
                  <thead>
                    <tr><th>Pharmacy</th><th>Plan</th><th>Status</th><th>Access until</th><th>Shops · staff</th><th>Sales (30 days)</th><th>Last sign-in</th><th aria-label="Open" /></tr>
                  </thead>
                  <tbody>
                    {filtered.map((org) => (
                      <tr key={org.id} onClick={() => setSelectedId(org.id)} className="console-row">
                        <td><strong>{org.name}</strong><div className="muted small">{org.admin_name || org.contact_name || '—'}{org.admin_phone || org.contact_phone ? ` · ${org.admin_phone || org.contact_phone}` : ''}</div></td>
                        <td>{PLAN_LABELS[org.plan]}</td>
                        <td><StateBadge state={org.state} />{org.held_sales ? <div className="muted small">{org.held_sales} held sale{org.held_sales === 1 ? '' : 's'}</div> : null}</td>
                        <td>{org.expires_at ? <>{formatDate(org.expires_at)}<div className="muted small">{relativeDays(org.expires_at)}</div></> : <span className="muted">No end date</span>}</td>
                        <td>{limitText(org.shops, org.shop_limit)}<div className="muted small">{limitText(org.active_staff, org.staff_limit)} staff</div></td>
                        <td>{org.sales_30d}<div className="muted small">{money.format(Number(org.sales_total_30d || 0))}</div></td>
                        <td>{org.last_sign_in_at ? <>{formatDate(org.last_sign_in_at)}<div className="muted small">{relativeDays(org.last_sign_in_at)}</div></> : <span className="muted">Never</span>}</td>
                        <td><button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); setSelectedId(org.id); }}>Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </main>

      {modal?.type === 'onboard' ? <OnboardModal onClose={closeModal} onDone={(credentials) => { load(); setModal({ type: 'credentials', credentials }); }} /> : null}
      {modal?.type === 'credentials' ? <CredentialsModal credentials={modal.credentials} onClose={closeModal} /> : null}
      {modal?.type === 'payment' ? <PaymentModal org={modal.org} onClose={closeModal} onDone={modal.onDone} /> : null}
      {modal?.type === 'plan' ? <PlanModal org={modal.org} onClose={closeModal} onDone={modal.onDone} /> : null}
      {modal?.type === 'dates' ? <DatesModal org={modal.org} onClose={closeModal} onDone={modal.onDone} /> : null}
      {modal?.type === 'suspend' ? <SuspendModal org={modal.org} onClose={closeModal} onDone={modal.onDone} /> : null}
      {modal?.type === 'void' ? <VoidPaymentModal payment={modal.payment} onClose={closeModal} onDone={modal.onDone} /> : null}
      {modal?.type === 'password' ? <PasswordModal onClose={closeModal} /> : null}
      {modal?.type === 'reset' ? (
        <ResetAdminModal member={modal.member} onClose={closeModal} onDone={(credentials) => { modal.onDone(''); setModal({ type: 'credentials', credentials }); }} />
      ) : null}
    </div>
  );
}

function ResetAdminModal({ member, onClose, onDone }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setWorking(true);
    setError('');
    try {
      const result = await callPlatformFunction({ action: 'reset_admin_password', staff_id: member.id });
      onDone({ ...result, title: `New password for ${member.name}` });
    } catch (resetError) {
      setError(resetError.message);
      setWorking(false);
    }
  }
  return (
    <Modal title={`Reset ${member.name}'s password?`} onClose={onClose} onSubmit={submit} submitLabel="Reset password" working={working} error={error}>
      <p className="muted small">Their current password stops working. You get a temporary one to give them, and they must choose their own when they sign in. Confirm it is really them first, by phone.</p>
    </Modal>
  );
}