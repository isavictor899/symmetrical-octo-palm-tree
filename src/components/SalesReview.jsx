import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import './SalesReview.css';

const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 2 });

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatGap(fromValue, toValue) {
  const minutes = Math.round((new Date(toValue) - new Date(fromValue)) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function paymentLabel(value) {
  const labels = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', insurance: 'Insurance' };
  return labels[value] || value || '—';
}

// Approval can fail for a reason only a person can fix; say what to do.
function approvalHint(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('stock')) return 'The system shows too little stock for this sale. If the medicine really left the shop, do a stock count for that batch in Stocked drugs, then approve again. Otherwise, void it.';
  if (text.includes('prescription')) return 'The prescription details are missing. If the sale was genuine, record it again from the till with the prescription details, then void this one.';
  if (text.includes('expired')) return 'This batch has expired, so it cannot be sold. Void the sale and handle the expired stock under Expiry report.';
  return '';
}

export default function SalesReview({ staffRole, onNavigatePage }) {
  const isAdmin = isAdminRole(staffRole);
  const [tab, setTab] = useState('held');
  const [held, setHeld] = useState([]);
  const [resolved, setResolved] = useState([]);
  const [toCheck, setToCheck] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [action, setAction] = useState(null); // { type: 'approve'|'void', sale }
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [pendingResult, historyResult, checkResult] = await Promise.all([
      supabase.rpc('held_sales_list', { p_status: 'pending' }),
      supabase.rpc('held_sales_list', { p_status: null }),
      supabase.rpc('sales_to_check', { p_days: 30 }),
    ]);
    const failure = pendingResult.error || historyResult.error || checkResult.error;
    if (failure) {
      setError(failure.message || 'Could not load sales to review.');
    } else {
      setHeld(pendingResult.data || []);
      setResolved((historyResult.data || []).filter((row) => row.status !== 'pending'));
      setToCheck(checkResult.data || []);
      setSelected(new Set());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return <div className="page-panel"><p className="muted">Only an administrator can review sales.</p></div>;
  }

  function openAction(type, sale) {
    setAction({ type, sale });
    setNote('');
    setActionError('');
    setMessage('');
  }

  function closeAction() {
    if (working) return;
    setAction(null);
  }

  async function runAction(event) {
    event.preventDefault();
    if (!action) return;
    if (action.type === 'void' && note.trim().length < 5) {
      setActionError('Give a reason of at least 5 characters.');
      return;
    }
    setWorking(true);
    setActionError('');
    const { error: rpcError } = action.type === 'approve'
      ? await supabase.rpc('approve_held_sale', { p_held_id: action.sale.id, p_note: note.trim() || null })
      : await supabase.rpc('void_held_sale', { p_held_id: action.sale.id, p_reason: note.trim() });
    setWorking(false);
    if (rpcError) {
      setActionError(rpcError.message || 'That did not work. Try again.');
      return;
    }
    setMessage(action.type === 'approve'
      ? `Sale ${action.sale.receipt_no} approved and recorded. Stock has been updated.`
      : `Sale ${action.sale.receipt_no} voided.`);
    setAction(null);
    window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', { detail: { type: 'sales-review' } }));
    load();
  }

  function toggleSelected(id) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function markChecked(ids) {
    if (!ids.length) return;
    setWorking(true);
    setError('');
    setMessage('');
    const { data, error: rpcError } = await supabase.rpc('mark_sales_checked', { p_sale_ids: ids });
    setWorking(false);
    if (rpcError) {
      setError(rpcError.message || 'Could not mark the sales as checked.');
      return;
    }
    setMessage(`${data} sale${data === 1 ? '' : 's'} marked as checked.`);
    window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', { detail: { type: 'sales-review' } }));
    load();
  }

  const allSelected = toCheck.length > 0 && selected.size === toCheck.length;
  const hint = actionError && action?.type === 'approve' ? approvalHint(actionError) : '';

  return (
    <div className="page-panel sales-review">
      <div className="section-header">
        <div>
          <h2>Sales review</h2>
          <p className="muted">Sales the server could not record automatically, and sales worth a second look.</p>
        </div>
        <button type="button" className="secondary-button" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      <div className="review-tabs" role="tablist" aria-label="Sales review">
        <button type="button" role="tab" aria-selected={tab === 'held'} className={tab === 'held' ? 'active' : ''} onClick={() => setTab('held')}>
          Held sales {held.length ? <span className="review-count">{held.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'check'} className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          Sales to check {toCheck.length ? <span className="review-count">{toCheck.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'resolved'} className={tab === 'resolved' ? 'active' : ''} onClick={() => setTab('resolved')}>
          Resolved
        </button>
      </div>

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {tab === 'held' ? (
        <section aria-label="Held sales">
          <p className="muted small review-explainer">
            A till sold these offline, but the server rejected them when they synced, for example because they were more than 7 days old or the stock records ran out.
            The medicine has usually already left the shop. <strong>Approve</strong> records the sale and updates stock. <strong>Void</strong> drops it, with a reason, if it should not count.
          </p>
          {loading && !held.length ? <p className="muted">Loading…</p> : null}
          {!loading && !held.length ? <p className="review-empty">No held sales. Every sale from the tills has been recorded.</p> : null}
          <div className="held-list">
            {held.map((sale) => (
              <article key={sale.id} className="held-card">
                <header>
                  <div>
                    <strong>{money.format(Number(sale.total_amount || 0))}</strong>
                    <span className="muted"> · {paymentLabel(sale.payment_method)} · Receipt {sale.receipt_no}</span>
                  </div>
                  <span className="muted small">{sale.shop_name}</span>
                </header>
                <dl className="held-facts">
                  <dt>Sold</dt><dd>{formatDateTime(sale.claimed_sold_at)}{sale.claimed_by_name ? ` by ${sale.claimed_by_name}` : ''}</dd>
                  <dt>Sent</dt><dd>{formatDateTime(sale.held_at)}{sale.held_by_name ? ` from ${sale.held_by_name}'s login` : ''}{sale.attempts > 1 ? ` · ${sale.attempts} tries` : ''}</dd>
                  <dt>Rejected because</dt><dd className="held-reason">{sale.error_message}</dd>
                  {sale.prescription_reference ? <><dt>Prescription</dt><dd>{sale.prescription_reference}</dd></> : null}
                </dl>
                <ul className="held-items">
                  {(sale.items || []).map((item, index) => (
                    <li key={index}><span>{item.quantity} × {item.name}</span><span>{money.format(Number(item.quantity || 0) * Number(item.unit_price || 0))}</span></li>
                  ))}
                </ul>
                <div className="table-actions">
                  <button type="button" className="table-action" onClick={() => openAction('approve', sale)}>Approve</button>
                  <button type="button" className="table-action danger" onClick={() => openAction('void', sale)}>Void</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tab === 'check' ? (
        <section aria-label="Sales to check">
          <p className="muted small review-explainer">
            These sales were recorded and counted. They are listed because they reached the server more than 15 minutes after their sale time, or were uploaded from a different login than the cashier credited.
            Both are normal when a till works offline or staff share a device. Check them against the cash or M-Pesa records, then mark them checked.
          </p>
          {loading && !toCheck.length ? <p className="muted">Loading…</p> : null}
          {!loading && !toCheck.length ? <p className="review-empty">Nothing to check in the last 30 days.</p> : null}
          {toCheck.length ? (
            <>
              <div className="review-bulk">
                <button type="button" className="secondary-button" disabled={working || !selected.size} onClick={() => markChecked([...selected])}>
                  Mark {selected.size || ''} selected as checked
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(toCheck.map((row) => row.id)))} /></th>
                      <th>Sale</th>
                      <th>Shop</th>
                      <th>Amount</th>
                      <th>Why it is listed</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {toCheck.map((row) => (
                      <tr key={row.id}>
                        <td><input type="checkbox" aria-label={`Select sale ${row.receipt_no}`} checked={selected.has(row.id)} onChange={() => toggleSelected(row.id)} /></td>
                        <td>
                          <strong>{row.receipt_no}</strong>
                          <div className="muted small">Sold {formatDateTime(row.sold_at)}{row.credited_name ? ` · ${row.credited_name}` : ''}</div>
                        </td>
                        <td>{row.shop_name}</td>
                        <td>{money.format(Number(row.total_amount || 0))}<div className="muted small">{paymentLabel(row.payment_method)}</div></td>
                        <td>
                          <div className="review-flags">
                            {row.is_late ? <span className="review-flag">Recorded {formatGap(row.sold_at, row.recorded_at)} after the sale</span> : null}
                            {row.is_reassigned ? <span className="review-flag">Uploaded by {row.uploaded_by_name || 'another login'}</span> : null}
                          </div>
                        </td>
                        <td><button type="button" className="table-action" disabled={working} onClick={() => markChecked([row.id])}>Checked</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {tab === 'resolved' ? (
        <section aria-label="Resolved held sales">
          {!loading && !resolved.length ? <p className="review-empty">No held sales have been resolved yet.</p> : null}
          {resolved.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Sale</th><th>Shop</th><th>Amount</th><th>Outcome</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {resolved.map((row) => (
                    <tr key={row.id}>
                      <td><strong>{row.receipt_no}</strong><div className="muted small">Sold {formatDateTime(row.claimed_sold_at)}</div></td>
                      <td>{row.shop_name}</td>
                      <td>{money.format(Number(row.total_amount || 0))}</td>
                      <td>
                        <span className={`review-outcome ${row.status}`}>{row.status === 'approved' ? 'Approved' : 'Voided'}</span>
                        <div className="muted small">{row.resolved_by_name || '—'} · {formatDateTime(row.resolved_at)}</div>
                      </td>
                      <td>{row.resolution_note || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {action ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal" role="dialog" aria-modal="true" aria-labelledby="review-action-title" onSubmit={runAction}>
            <div>
              <h3 id="review-action-title">
                {action.type === 'approve' ? 'Approve' : 'Void'} sale {action.sale.receipt_no} ({money.format(Number(action.sale.total_amount || 0))})?
              </h3>
              <p className="muted small">
                {action.type === 'approve'
                  ? `It will be recorded as sold on ${formatDateTime(action.sale.claimed_sold_at)}${action.sale.claimed_by_name ? ` by ${action.sale.claimed_by_name}` : ''}, and the stock will be reduced. Your name is kept as the approver.`
                  : 'It will not be recorded as a sale and stock will not change. Use this when the sale did not really happen, or it has been recorded another way.'}
              </p>
            </div>
            <label className="classification-reason">
              {action.type === 'approve' ? <>Note <span className="muted">(optional)</span></> : 'Reason'}
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                maxLength={500}
                placeholder={action.type === 'approve' ? 'e.g. Till was offline over the weekend' : 'e.g. Customer returned it the same day'}
                required={action.type === 'void'}
              />
            </label>
            {actionError ? <p className="error">{actionError}</p> : null}
            {hint ? (
              <p className="muted small review-hint">
                {hint}
                {hint.includes('Stocked drugs') && onNavigatePage ? <> <button type="button" className="link-button" onClick={() => onNavigatePage('stockedDrugs')}>Open Stocked drugs</button></> : null}
              </p>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeAction} disabled={working}>Cancel</button>
              <button type="submit" className={action.type === 'void' ? 'danger-button' : undefined} disabled={working}>
                {working ? 'Working…' : action.type === 'approve' ? 'Approve sale' : 'Void sale'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}