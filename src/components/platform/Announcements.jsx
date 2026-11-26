import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { Field, formatDateTime, Modal } from './consoleShared';

const LEVELS = { info: 'Information', warning: 'Warning', critical: 'Critical' };

// yyyy-mm-ddThh:mm in Nairobi, for <input type="datetime-local">.
function localInput(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

function fromLocalInput(value) {
  return value ? new Date(`${value}:00+03:00`).toISOString() : null;
}

function AnnouncementModal({ announcement, orgs, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: announcement?.title || '',
    body: announcement?.body || '',
    level: announcement?.level || 'info',
    audience: announcement?.audience || 'all',
    organization_id: announcement?.organization_id || '',
    starts_at: localInput(announcement?.starts_at),
    ends_at: localInput(announcement?.ends_at),
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    setWorking(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('platform_save_announcement', {
      p_id: announcement?.id || null,
      p_title: form.title,
      p_body: form.body,
      p_level: form.level,
      p_audience: form.audience,
      p_org: form.organization_id || null,
      p_starts_at: fromLocalInput(form.starts_at),
      p_ends_at: fromLocalInput(form.ends_at),
    });
    setWorking(false);
    if (rpcError) setError(/check constraint/.test(rpcError.message) ? 'The title needs 3–120 characters and the message 3–1000.' : rpcError.message);
    else onSaved(announcement ? 'Announcement updated.' : 'Announcement published.');
  }

  return (
    <Modal title={announcement ? 'Edit announcement' : 'New announcement'} onClose={onClose} onSubmit={submit} submitLabel={announcement ? 'Save' : 'Publish'} working={working} error={error} wide>
      <Field label="Title"><input required maxLength={120} value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="e.g. Maintenance on Sunday night" /></Field>
      <Field label="Message"><textarea required maxLength={1000} rows={3} value={form.body} onChange={(event) => update('body', event.target.value)} placeholder="Keep it short; it appears across the top of the app." /></Field>
      <div className="console-form-grid">
        <Field label="Type">
          <select value={form.level} onChange={(event) => update('level', event.target.value)}>
            <option value="info">Information (can be dismissed)</option>
            <option value="warning">Warning (can be dismissed)</option>
            <option value="critical">Critical (stays until it ends)</option>
          </select>
        </Field>
        <Field label="Who sees it">
          <select value={form.audience} onChange={(event) => update('audience', event.target.value)}>
            <option value="all">All staff</option>
            <option value="admins">Pharmacy administrators only</option>
          </select>
        </Field>
        <Field label="Pharmacies">
          <select value={form.organization_id} onChange={(event) => update('organization_id', event.target.value)}>
            <option value="">Every pharmacy</option>
            {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select>
        </Field>
        <Field label="Starts" hint="(blank = now)"><input type="datetime-local" value={form.starts_at} onChange={(event) => update('starts_at', event.target.value)} /></Field>
        <Field label="Ends" hint="(blank = until you end it)"><input type="datetime-local" value={form.ends_at} onChange={(event) => update('ends_at', event.target.value)} /></Field>
      </div>
      <p className="muted small">Times are Nairobi time.</p>
    </Modal>
  );
}

export default function Announcements({ isOwner, orgs, onChanged }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | announcement

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('platform_announcements_list');
    if (rpcError) setError(rpcError.message);
    else { setItems(data || []); setError(''); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function end(item) {
    const { error: rpcError } = await supabase.rpc('platform_end_announcement', { p_id: item.id });
    if (rpcError) setError(rpcError.message);
    else { onChanged?.(item.status === 'scheduled' ? 'Announcement cancelled.' : 'Announcement ended.'); load(); }
  }

  return (
    <section aria-label="Announcements">
      <div className="section-header">
        <div>
          <h2>Announcements</h2>
          <p className="muted">Messages shown across the top of pharmacies&apos; apps: maintenance, new features, policy changes.</p>
        </div>
        {isOwner ? <button type="button" className="save-button" onClick={() => setEditing('new')}>New announcement</button> : null}
      </div>
      {error ? <p className="console-banner danger">{error}</p> : null}
      {!items.length ? <p className="review-empty">No announcements yet.</p> : (
        <div className="console-announcements">
          {items.map((item) => (
            <article key={item.id} className={`console-announcement ${item.level}`}>
              <header>
                <strong>{item.title}</strong>
                <span className={`console-ann-status ${item.status}`}>{item.status === 'live' ? 'Live' : item.status === 'scheduled' ? 'Scheduled' : 'Ended'}</span>
              </header>
              <p>{item.body}</p>
              <p className="muted small">
                {LEVELS[item.level]} · {item.audience === 'admins' ? 'Administrators' : 'All staff'} · {item.organization || 'Every pharmacy'}
                {' · '}{formatDateTime(item.starts_at)}{item.ends_at ? ` to ${formatDateTime(item.ends_at)}` : ', no end'}
              </p>
              {isOwner && item.status !== 'ended' ? (
                <div className="table-actions">
                  <button type="button" className="table-action" onClick={() => setEditing(item)}>Edit</button>
                  <button type="button" className="table-action danger" onClick={() => end(item)}>{item.status === 'scheduled' ? 'Cancel' : 'End now'}</button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {editing ? (
        <AnnouncementModal
          announcement={editing === 'new' ? null : editing}
          orgs={orgs}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); onChanged?.(message); load(); }}
        />
      ) : null}
    </section>
  );
}