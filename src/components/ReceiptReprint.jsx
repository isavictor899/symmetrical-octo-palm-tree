import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { paymentLabel, printReceipt, recentReceipts } from '../lib/receipt';

function formatTime(value) {
  return new Date(value).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatKes(value) {
  return `KES ${Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function receiptFromServer(row) {
  return {
    receiptNo: row.receipt_no,
    time: row.sold_at,
    paymentMethod: row.payment_method,
    servedBy: row.served_by || '',
    total: Number(row.total_amount || 0),
    items: (row.items || []).map((item) => ({
      name: item.name,
      qty: Number(item.qty || 0),
      unitPrice: Number(item.unitPrice || 0),
      originalUnitPrice: Number(item.originalUnitPrice ?? item.unitPrice ?? 0),
    })),
    prescription: row.prescription_reference
      ? { reference: row.prescription_reference, prescriber: row.prescriber_name || '', date: row.prescription_date || '' }
      : null,
    pendingSync: false,
  };
}

function normaliseSearch(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export default function ReceiptReprint({ shopId, shop, online, onClose }) {
  const [search, setSearch] = useState('');
  const [serverReceipts, setServerReceipts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const deviceReceipts = useMemo(() => recentReceipts(shopId), [shopId]);

  useEffect(() => {
    if (!shopId || !online) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      const { data, error: rpcError } = await supabase.rpc('sale_receipts', {
        p_shop_id: shopId,
        p_search: normaliseSearch(search) || null,
        p_limit: 40,
      });
      if (cancelled) return;
      if (rpcError) setError(rpcError.message || 'Could not load past sales.');
      else setServerReceipts((data || []).map(receiptFromServer));
      setLoading(false);
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [shopId, online, search]);

  // Server records win (they are the final, synced version); receipts that
  // exist only on this device are sales still waiting to sync.
  const receipts = useMemo(() => {
    const term = normaliseSearch(search);
    const byNumber = new Map();
    for (const receipt of serverReceipts) byNumber.set(receipt.receiptNo, receipt);
    for (const receipt of deviceReceipts) {
      if (!byNumber.has(receipt.receiptNo)) byNumber.set(receipt.receiptNo, { ...receipt, onlyOnDevice: true });
    }
    return [...byNumber.values()]
      .filter((receipt) => !term || receipt.receiptNo.startsWith(term))
      .sort((a, b) => new Date(b.time) - new Date(a.time));
  }, [serverReceipts, deviceReceipts, search]);

  function reprint(receipt) {
    setNotice('');
    const ok = printReceipt({ ...receipt, reprint: true, pendingSync: Boolean(receipt.onlyOnDevice) }, shop);
    if (!ok) setNotice('Your browser blocked the receipt window. Allow pop-ups for this site, then try again.');
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="classification-modal reprint-modal" role="dialog" aria-modal="true" aria-labelledby="reprint-title">
        <div>
          <h3 id="reprint-title">Reprint a receipt</h3>
          <p className="muted small">
            {online
              ? 'Recent sales for this shop. Search by the receipt number printed on the receipt.'
              : 'You are offline, so only receipts printed on this device are shown.'}
          </p>
        </div>

        <input
          className="search-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Receipt number, e.g. FDA671C6"
          aria-label="Search by receipt number"
          autoFocus
        />

        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="error">{notice}</p> : null}
        {loading && receipts.length === 0 ? <p className="muted">Loading recent sales…</p> : null}
        {!loading && receipts.length === 0 ? <p className="muted">No receipts found.</p> : null}

        <div className="reprint-list">
          {receipts.map((receipt) => (
            <div key={receipt.receiptNo} className="reprint-row">
              <div>
                <strong className="tnum">{receipt.receiptNo}</strong>
                {receipt.onlyOnDevice ? <span className="mini-badge">Waiting to sync</span> : null}
                <div className="muted small">
                  {formatTime(receipt.time)} · {paymentLabel(receipt.paymentMethod)} · {receipt.items.length} item{receipt.items.length === 1 ? '' : 's'}
                  {receipt.servedBy ? ` · ${receipt.servedBy}` : ''}
                </div>
              </div>
              <div className="reprint-row-actions">
                <strong className="tnum">{formatKes(receipt.total)}</strong>
                <button type="button" className="table-action" onClick={() => reprint(receipt)}>Print</button>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}