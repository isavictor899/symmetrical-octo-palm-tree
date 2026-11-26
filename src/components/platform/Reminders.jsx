import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatDate, formatDateTime } from './consoleShared';

const KIND_LABELS = {
  expires_in_7: 'Ends within 7 days',
  expires_in_1: 'Ends tomorrow',
  expired: 'Ended (grace period)',
  read_only_soon: 'Read-only in 2 days',
  read_only: 'Now read-only',
};
const CHANNEL_LABELS = { sms: 'SMS', email: 'Email', whatsapp_manual: 'WhatsApp (by hand)' };

function whatsappNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return '';
}

async function callReminders(body) {
  const { data, error } = await supabase.functions.invoke('subscription-reminders', { body });
  if (error) {
    let message = error.message;
    try { const payload = await error.context?.json?.(); if (payload?.error) message = payload.error; } catch { /* keep */ }
    throw new Error(message);
  }
  return data;
}

export default function Reminders({ isOwner, onChanged }) {
  const [data, setData] = useState({ due: [], recent: [] });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');

  const load = useCallback(async () => {
    const { data: result, error: rpcError } = await supabase.rpc('platform_reminders');
    if (rpcError) setError(rpcError.message);
    else { setData(result || { due: [], recent: [] }); setError(''); }
  }, []);

  useEffect(() => {
    load();
    if (isOwner) callReminders({ action: 'status' }).then(setStatus).catch(() => setStatus(null));
  }, [load, isOwner]);

  async function markSent(reminder) {
    setWorking(reminder.organization_id + reminder.kind);
    const { error: rpcError } = await supabase.rpc('platform_mark_reminder_sent', {
      p_org: reminder.organization_id, p_kind: reminder.kind, p_expires_at: reminder.expires_at, p_recipient: reminder.phone || reminder.email || null,
    });
    setWorking('');
    if (rpcError) setError(rpcError.message);
    else load();
  }

  async function sendNow() {
    setWorking('send');
    setError('');
    try {
      const result = await callReminders({ action: 'run' });
      onChanged?.(result.note || `Reminders sent: ${result.sent}, failed: ${result.failed}, no contact details: ${result.skipped}.`);
      load();
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setWorking('');
    }
  }

  const automatic = status && (status.sms || status.email);

  return (
    <section aria-label="Reminders">
      <div className="section-header">
        <div>
          <h2>Subscription reminders</h2>
          <p className="muted">Each pharmacy gets a reminder 7 days and 1 day before it expires, when it expires, 2 days before it turns read-only, and when it does. Each one is sent once.</p>
        </div>
        {isOwner && automatic ? <button type="button" className="save-button" onClick={sendNow} disabled={working === 'send'}>{working === 'send' ? 'Sending…' : 'Send due reminders now'}</button> : null}
      </div>
      {error ? <p className="console-banner danger">{error}</p> : null}

      {status ? (
        <div className="console-card console-reminder-setup">
          <div className="console-card-head"><h3>Automatic sending</h3></div>
          <ul className="console-setup-list">
            <li className={status.schedule ? 'ok' : 'off'}>Daily run at 7:00am: {status.schedule ? 'on' : 'off'}</li>
            <li className={status.sms ? 'ok' : 'off'}>SMS (Africa&apos;s Talking): {status.sms ? 'set up' : 'not set up'}</li>
            <li className={status.email ? 'ok' : 'off'}>Email (Resend): {status.email ? 'set up' : 'not set up'}</li>
          </ul>
          {!automatic ? (
            <p className="muted small">
              Until SMS or email is set up, nothing is sent automatically. Send the reminders below by WhatsApp and mark them sent.
              To switch on SMS, add the function secrets AT_USERNAME and AT_API_KEY (and AT_SENDER_ID if you have one) to the
              subscription-reminders function in Supabase. For email, add RESEND_API_KEY and REMINDER_EMAIL_FROM.
            </p>
          ) : null}
        </div>
      ) : null}

      <h3 className="console-section-title">Due now ({data.due.length})</h3>
      {!data.due.length ? <p className="review-empty">No reminders due.</p> : (
        <div className="table-wrap">
          <table className="console-reminders">
            <thead><tr><th>Pharmacy</th><th>Reminder</th><th>Contact</th><th>Message</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.due.map((reminder) => {
                const number = whatsappNumber(reminder.phone);
                return (
                  <tr key={reminder.organization_id + reminder.kind}>
                    <td><strong>{reminder.name}</strong><div className="muted small">Expiry {formatDate(reminder.expires_at)}</div></td>
                    <td>{KIND_LABELS[reminder.kind]}</td>
                    <td>{reminder.contact_name || '—'}<div className="muted small">{reminder.phone || 'no phone'}{reminder.email ? ` · ${reminder.email}` : ''}</div></td>
                    <td className="console-reminder-message">{reminder.message}</td>
                    <td>
                      <div className="table-actions">
                        {number ? (
                          <a className="table-action" href={`https://wa.me/${number}?text=${encodeURIComponent(reminder.message)}`} target="_blank" rel="noreferrer">WhatsApp</a>
                        ) : <span className="muted small">Add a phone under the pharmacy&apos;s notes</span>}
                        <button type="button" className="table-action" disabled={working === reminder.organization_id + reminder.kind} onClick={() => markSent(reminder)}>Mark sent</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="console-section-title">Recently sent</h3>
      {!data.recent.length ? <p className="review-empty">Nothing sent yet.</p> : (
        <div className="table-wrap">
          <table className="console-reminders">
            <thead><tr><th>When</th><th>Pharmacy</th><th>Reminder</th><th>Channel</th><th>Result</th></tr></thead>
            <tbody>
              {data.recent.map((row, index) => (
                <tr key={index}>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>{row.organization}</td>
                  <td>{KIND_LABELS[row.kind]}</td>
                  <td>{CHANNEL_LABELS[row.channel]}<div className="muted small">{row.recipient || ''}</div></td>
                  <td>{row.status === 'sent' ? <span className="success">Sent</span> : <span className="error">Failed: {row.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}