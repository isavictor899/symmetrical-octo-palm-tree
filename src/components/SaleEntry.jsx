import React, { useState, useEffect, useMemo } from 'react';
import { usePowerSync, useQuery, useStatus } from '@powersync/react';
import { supabase } from '../lib/supabaseClient';
import { flushAll } from '../lib/powersync/flush';
import { useStaff } from '../lib/useStaff';
import './SaleEntry.css';

function formatKes(n) {
  return `KES ${n.toFixed(2)}`;
}

// First-Expiry-First-Out: among in-stock, non-expired batches, pick the
// one expiring soonest. This is a UX convenience only â€” sell_stock enforces
// the real expiry check server-side regardless of what this picks.
function pickFefoBatch(drug) {
  const today = new Date().toISOString().slice(0, 10);
  const sellable = drug.batches.filter((b) => b.available > 0 && b.expiry_date >= today);
  if (sellable.length === 0) return null;
  return [...sellable].sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date))[0];
}

export default function SaleEntry({ activeShopId, activeShopName, isActive = true }) {
  const db = usePowerSync();
  const syncStatus = useStatus(); // { connected, ... } ” lets us show online/offline

  // Local-first staff lookup, shared with ReceiveStock. keepTrying: keep
  // fetching from the server in the background until the row arrives.
  const { staff: staffInfo, retrying, syncedNotice, retry: retryFetchStaff } = useStaff({ keepTrying: true });
  const effectiveShopId = activeShopId || staffInfo?.shopId || null;

  useEffect(() => {
    setQuery('');
    setCart([]);
    setCheckoutError(null);
    setLastReceipt(null);
  }, [effectiveShopId]);

  // Reactive local query: joins batches + drugs from the local SQLite
  // database, scoped to this shop. Automatically re-runs whenever the
  // underlying local data changes (a sync pulling in fresh stock, etc.) â€”
  // no manual refetching needed.
  // When staffInfo is not yet resolved, pass a harmless placeholder query
  // instead of null â€” some versions of the PowerSync hook expect a valid
  // query-like value and calling it with `null` can change the internal
  // hook ordering and cause React hook order errors.
  const { data: batchRows } = useQuery(
    effectiveShopId && isActive
      ? `SELECT batches.id, batches.drug_id, batches.batch_number, batches.expiry_date,
                batches.selling_price, batches.quantity_remaining,
                drugs.name, drugs.generic_name,
                shop_drugs.requires_prescription AS shop_requires_prescription
         FROM batches
         JOIN drugs ON drugs.id = batches.drug_id
         LEFT JOIN shop_drugs
           ON shop_drugs.shop_id = batches.shop_id
          AND shop_drugs.drug_id = batches.drug_id
         WHERE batches.shop_id = ? AND batches.quantity_remaining > 0
         ORDER BY batches.expiry_date ASC`
      : 'SELECT 1 WHERE 0',
    effectiveShopId && isActive ? [effectiveShopId] : []
  );

  // Every sale still sitting in the local queue, unsynced â€” used for two
  // things: the "waiting to sync" count, and (below) figuring out how much
  // of each batch's synced stock is already spoken for by a sale that
  // hasn't reached the server yet. Without this, a second offline sale of
  // the same batch has no way to know the first one already happened.
  const { data: pendingItemsRows } = useQuery(isActive ? 'SELECT id, items_json, status, last_error FROM pending_sales' : 'SELECT 1 WHERE 0');
  const waitingSales = (pendingItemsRows || []).filter((row) => !row.status || row.status === 'pending');
  const failedSales = (pendingItemsRows || []).filter((row) => row.status === 'failed');
  const pendingCount = waitingSales.length;

  const [recentSoldQtyByBatch, setRecentSoldQtyByBatch] = useState({});

  const pendingQtyByBatch = useMemo(() => {
    const map = {};
    for (const row of waitingSales) {
      try {
        const items = JSON.parse(row.items_json);
        for (const item of items) {
          map[item.batch_id] = (map[item.batch_id] || 0) + Number(item.quantity);
        }
      } catch {
        // A malformed row shouldn't take down the whole search screen.
      }
    }
    return map;
  }, [waitingSales]);

  const drugs = useMemo(() => {
    const byDrug = {};
    for (const b of batchRows || []) {
      const recentSale = recentSoldQtyByBatch[b.id];
      const recentSold = recentSale && Number(b.quantity_remaining || 0) >= Number(recentSale.originalQuantity || 0)
        ? Number(recentSale.quantity || 0)
        : 0;
      const available = b.quantity_remaining - (pendingQtyByBatch[b.id] || 0) - recentSold;
      if (!byDrug[b.drug_id]) {
        byDrug[b.drug_id] = {
          id: b.drug_id,
          name: b.name,
          generic_name: b.generic_name,
          requiresPrescription: b.shop_requires_prescription === null || b.shop_requires_prescription === undefined
            ? null
            : Number(b.shop_requires_prescription) === 1,
          batches: [],
        };
      }
      byDrug[b.drug_id].batches.push({ ...b, available });
    }
    return Object.values(byDrug);
  }, [batchRows, pendingQtyByBatch, recentSoldQtyByBatch]);

  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState([]);
  const [remoteSearchLoading, setRemoteSearchLoading] = useState(false);
  const [cart, setCart] = useState([]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [prescriptionReference, setPrescriptionReference] = useState('');
  const [prescriberName, setPrescriberName] = useState('');
  const [prescriptionDate, setPrescriptionDate] = useState('');
  const [status, setStatus] = useState('idle'); // idle | submitting | done
  const [checkoutError, setCheckoutError] = useState(null);
  const [lastReceipt, setLastReceipt] = useState(null);
  const cartNeedsPrescription = cart.some((line) => line.requiresPrescription === true);
  const cartHasUnclassifiedDrug = cart.some((line) => line.requiresPrescription === null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    return drugs
      .filter((d) => d.name.toLowerCase().includes(q) || (d.generic_name || '').toLowerCase().includes(q))
      .flatMap((drug) => drug.batches
        .map((batch) => ({ drug, batch, expired: batch.expiry_date < today }))
        .sort((a, b) => new Date(a.batch.expiry_date) - new Date(b.batch.expiry_date))
      );
  }, [query, drugs]);

  const localStockCount = (batchRows || []).length;

  useEffect(() => {
    const term = query.trim();
    const localStockHasLoaded = localStockCount > 0;
    if (!isActive || !term || !effectiveShopId || results.length > 0 || localStockHasLoaded || !syncStatus.connected) {
      setRemoteResults([]);
      setRemoteSearchLoading(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setRemoteSearchLoading(true);
        const like = `%${term}%`;
        const { data: matchingDrugs, error: drugsError } = await supabase
          .from('drugs')
          .select('id, name, generic_name')
          .or(`name.ilike.${like},generic_name.ilike.${like}`)
          .limit(50);
        if (drugsError) throw drugsError;

        const drugIds = (matchingDrugs || []).map((drug) => drug.id);
        if (!drugIds.length) {
          if (!cancelled) setRemoteResults([]);
          return;
        }

        const [batchesResult, shopDrugsResult] = await Promise.all([
          supabase.from('batches')
            .select('id, drug_id, batch_number, expiry_date, selling_price, quantity_remaining')
            .eq('shop_id', effectiveShopId)
            .gt('quantity_remaining', 0)
            .in('drug_id', drugIds)
            .order('expiry_date', { ascending: true }),
          supabase.from('shop_drugs')
            .select('drug_id, requires_prescription')
            .eq('shop_id', effectiveShopId)
            .in('drug_id', drugIds),
        ]);
        if (batchesResult.error) throw batchesResult.error;
        if (shopDrugsResult.error) throw shopDrugsResult.error;

        const drugsById = Object.fromEntries((matchingDrugs || []).map((drug) => [drug.id, drug]));
        const classificationByDrug = Object.fromEntries((shopDrugsResult.data || []).map((row) => [row.drug_id, row.requires_prescription]));
        const today = new Date().toISOString().slice(0, 10);
        const remoteRows = (batchesResult.data || []).map((batch) => {
          const matchedDrug = drugsById[batch.drug_id] || {};
          const requiresPrescription = classificationByDrug[batch.drug_id];
          const pendingQty = pendingQtyByBatch[batch.id] || 0;
          const available = Number(batch.quantity_remaining || 0) - pendingQty;
          return {
            drug: {
              id: batch.drug_id,
              name: matchedDrug.name || 'Unknown drug',
              generic_name: matchedDrug.generic_name || '',
              requiresPrescription: requiresPrescription === null || requiresPrescription === undefined
                ? null
                : Number(requiresPrescription) === 1,
            },
            batch: { ...batch, available },
            expired: batch.expiry_date < today,
          };
        }).filter((row) => row.batch.available > 0 || row.expired);

        if (!cancelled) setRemoteResults(remoteRows);
      } catch (searchError) {
        console.warn('[SaleEntry] Live search fallback failed:', searchError);
        if (!cancelled) setRemoteResults([]);
      } finally {
        if (!cancelled) setRemoteSearchLoading(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, effectiveShopId, results.length, syncStatus.connected, pendingQtyByBatch, localStockCount, isActive]);

  const visibleResults = results.length ? results : remoteResults;

  function addToCart(drug, batch) {
    if (!batch || batch.available <= 0 || batch.expiry_date < new Date().toISOString().slice(0, 10)) return;
    setCart((prev) => {
      const existing = prev.find((line) => line.batch.id === batch.id);
      if (existing) {
        if (existing.qty >= batch.available) return prev;
        return prev.map((line) =>
          line.batch.id === batch.id ? { ...line, qty: line.qty + 1 } : line
        );
      }
      return [...prev, {
        drugId: drug.id,
        drugName: drug.name,
        batch,
        qty: 1,
        requiresPrescription: drug.requiresPrescription,
      }];
    });
    setQuery('');
  }

  function updateQty(batchId, delta) {
    setCart((prev) =>
      prev.map((line) =>
        line.batch.id === batchId
          ? { ...line, qty: Math.max(1, Math.min(line.qty + delta, line.batch.available)) }
          : line
      )
    );
  }

  function removeLine(batchId) {
    setCart((prev) => prev.filter((line) => line.batch.id !== batchId));
  }

  const total = cart.reduce((sum, line) => sum + line.qty * line.batch.selling_price, 0);

  // Writes the sale into the LOCAL pending_sales queue â€” works offline.
  // The connector picks it up and calls sell_stock automatically once
  // there's connectivity; nothing here calls Supabase directly.
  async function checkout() {
    if (cart.length === 0 || !staffInfo || !effectiveShopId) return;
    if (cartHasUnclassifiedDrug) {
      setCheckoutError('One or more drugs in this sale have not been classified as POM or OTC. Update them in Stocked drugs first.');
      return;
    }
    if (cartNeedsPrescription && (!prescriptionReference.trim() || !prescriberName.trim() || !prescriptionDate)) {
      setCheckoutError('Enter the prescription reference, prescriber name, and prescription date before completing this sale.');
      return;
    }
    setStatus('submitting');
    setCheckoutError(null);

    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) throw new Error('Your sign-in session is unavailable. Sign in again before recording this sale.');
      const localId = crypto.randomUUID();
      const items = cart.map((line) => ({
        drug_id: line.drugId,
        batch_id: line.batch.id,
        quantity: line.qty,
        unit_price: line.batch.selling_price,
      }));

      await db.execute(
        `INSERT INTO pending_sales
           (id, created_by_user_id, shop_id, payment_method, items_json, total_amount, prescription_reference, prescriber_name, prescription_date, created_at, status, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localId, session.user.id, effectiveShopId, paymentMethod, JSON.stringify(items), total,
          cartNeedsPrescription ? prescriptionReference.trim() : '',
          cartNeedsPrescription ? prescriberName.trim() : '',
          cartNeedsPrescription ? prescriptionDate : '',
          new Date().toISOString(), 'pending', null,
        ]
      );
      await flushAll(db);
      const remaining = await db.getAll('SELECT status, last_error FROM pending_sales WHERE id = ?', [localId]);
      const queueRow = remaining[0] || null;

      if (!queueRow) {
        const soldByBatch = items.reduce((acc, item) => {
          const cartLine = cart.find((line) => line.batch.id === item.batch_id);
          const existing = acc[item.batch_id] || { quantity: 0, originalQuantity: Number(cartLine?.batch?.quantity_remaining || 0) };
          existing.quantity += Number(item.quantity || 0);
          acc[item.batch_id] = existing;
          return acc;
        }, {});
        setRecentSoldQtyByBatch((previous) => {
          const next = { ...previous };
          for (const [batchId, sale] of Object.entries(soldByBatch)) {
            const previousSale = next[batchId];
            next[batchId] = {
              quantity: Number(previousSale?.quantity || 0) + Number(sale.quantity || 0),
              originalQuantity: previousSale?.originalQuantity ?? sale.originalQuantity,
            };
          }
          return next;
        });
        window.setTimeout(() => {
          setRecentSoldQtyByBatch((previous) => {
            const next = { ...previous };
            for (const [batchId, sale] of Object.entries(soldByBatch)) {
              const previousSale = next[batchId];
              const remainingQuantity = Number(previousSale?.quantity || 0) - Number(sale.quantity || 0);
              if (remainingQuantity > 0) next[batchId] = { ...previousSale, quantity: remainingQuantity };
              else delete next[batchId];
            }
            return next;
          });
        }, 15000);
        window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', {
          detail: { type: 'sale', shopId: effectiveShopId },
        }));
      }

      setLastReceipt({ items: cart, total, paymentMethod, time: new Date(), queueRow });
      setCart([]);
      setPrescriptionReference('');
      setPrescriberName('');
      setPrescriptionDate('');
      setStatus('done');
    } catch (err) {
      setCheckoutError(err.message);
      setStatus('idle');
    }
  }

  if (!staffInfo) {
    return <div className="pos-loading">Loading sale screen...</div>;
  }

  return (
    <div className="pos-sale">
      <header className="pos-header">
        <div>
          <div className="pos-status-row">
            <span className={`status-dot ${syncStatus.connected ? 'online' : 'offline'}`} title={syncStatus.connected ? 'Online - syncing' : 'Offline - sales will queue locally'} />
            {syncStatus.connected ? 'Online' : 'Offline'}
            {pendingCount > 0 && <span className="status-warning">{pendingCount} sale{pendingCount === 1 ? '' : 's'} waiting</span>}
            {failedSales.length > 0 && <span className="status-critical">{failedSales.length} need attention</span>}
          </div>
          <h1>New sale</h1>
          {activeShopName && <p>Selling from {activeShopName}</p>}
        </div>
        <div className="pos-header-actions">
          <button type="button" className="button secondary" onClick={() => retryFetchStaff()}>
            {retrying ? 'Retryingâ€¦' : 'Retry staff sync'}
          </button>
          <button type="button" className="button ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {syncedNotice && <div className="notice success">Staff record synced locally</div>}
      {failedSales.length > 0 && <section aria-label="Sales needing attention" className="notice danger">
        <strong>{failedSales.length} sale{failedSales.length === 1 ? '' : 's'} need attention</strong>
        {failedSales.map((row) => <div key={row.id} className="notice-row">
          <span>{row.last_error || 'The server rejected this sale.'}</span>
          <button type="button" onClick={async () => { await db.execute("UPDATE pending_sales SET status = 'pending', last_error = NULL WHERE id = ?", [row.id]); flushAll(db); }}>Retry</button>
        </div>)}
      </section>}

      <div className="pos-sale-grid">
        <section className="product-pane" aria-label="Product search">
          <input
            className="search-input"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search drug by name or genericâ€¦"
          />

          {query.trim() && results.length === 0 && remoteSearchLoading && (
            <div className="empty-state">Searching stock while the local catalogue syncs…</div>
          )}

          {query.trim() && visibleResults.length === 0 && !remoteSearchLoading && (
            <div className="empty-state">No stocked batch matches "{query}" for this shop yet.</div>
          )}

          {visibleResults.map(({ drug, batch, expired }) => {
            const lowStock = !expired && batch.available <= 25;
            return (
              <button
                key={batch.id}
                onClick={() => addToCart(drug, batch)}
                disabled={expired || batch.available <= 0}
                className="product-row"
              >
                <div>
                  <div className="product-title">
                    {drug.name}
                    {drug.requiresPrescription === true && <span className="mini-badge pom">POM</span>}
                    {drug.requiresPrescription === null && <span className="mini-badge danger">Unclassified</span>}
                    <span className="mini-badge price-tier">{formatKes(Number(batch.selling_price || 0))}</span>
                  </div>
                  <div className="product-meta">
                    {drug.generic_name || 'No generic name'}
                    {' · '}batch {batch.batch_number || 'N/A'} · exp {batch.expiry_date}
                    {' · '}{batch.available} available
                    {lowStock && <span className="status-warning"> · low stock</span>}
                    {expired && <span className="status-warning"> · expired, needs write-off</span>}
                  </div>
                </div>
                <div className="product-price tnum">
                  {formatKes(Number(batch.selling_price || 0))}
                  <small>Batch line</small>
                </div>
              </button>
            );
          })}

          {!query.trim() && (
            <div className="empty-state">
              Start typing to find a drug. Each batch and price appears separately so you can choose the exact stock line.
            </div>
          )}
        </section>

        <aside className="checkout-pane" aria-label="Checkout">
          <div className="cart-heading">Cart ({cart.length})</div>

          <div className="cart-list">
            {cart.length === 0 && <div className="empty-state">No items yet.</div>}
            {cart.map((line) => (
              <div key={line.batch.id} className="cart-line">
                <div>
                  <div className="cart-drug">{line.drugName}</div>
                  <div className="cart-meta">Batch {line.batch.batch_number || 'N/A'} Â· exp {line.batch.expiry_date}</div>
                  <div className="cart-meta">{formatKes(line.batch.selling_price)} each</div>
                </div>
                <div className="cart-controls">
                  <button type="button" onClick={() => updateQty(line.batch.id, -1)}>âˆ’</button>
                  <span className="tnum">{line.qty}</span>
                  <button type="button" onClick={() => updateQty(line.batch.id, 1)}>+</button>
                  <strong className="tnum">{formatKes(line.qty * line.batch.selling_price)}</strong>
                  <button type="button" className="remove-line" onClick={() => removeLine(line.batch.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>

          <div className="checkout-footer">
            <div className="total-row">
              <span>Total</span>
              <span className="tnum">{formatKes(total)}</span>
            </div>

            <div className="payment-options">
              {['cash', 'mpesa', 'card', 'insurance', 'sha'].map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setPaymentMethod(m)}
                  className={paymentMethod === m ? 'active' : ''}
                >
                  {m}
                </button>
              ))}
            </div>

            {cartNeedsPrescription && (
              <fieldset className="rx-fieldset">
                <legend>Prescription details</legend>
                <p>This sale includes a prescription-only drug.</p>
                <input required value={prescriptionReference} onChange={(event) => setPrescriptionReference(event.target.value)} placeholder="Prescription reference" />
                <input required value={prescriberName} onChange={(event) => setPrescriberName(event.target.value)} placeholder="Prescriber name" />
                <input required type="date" value={prescriptionDate} onChange={(event) => setPrescriptionDate(event.target.value)} aria-label="Prescription date" />
              </fieldset>
            )}

            {cartHasUnclassifiedDrug && (
              <div className="inline-error">This sale contains an unclassified stocked drug. Set it to POM or OTC in Stocked drugs before completing the sale.</div>
            )}

            <button
              className="complete-sale"
              onClick={checkout}
              disabled={cart.length === 0 || status === 'submitting' || cartHasUnclassifiedDrug}
            >
              {status === 'submitting' ? 'Recording saleâ€¦' : 'Complete sale'}
            </button>

            {checkoutError && <div className="inline-error">{checkoutError}</div>}

            {status === 'done' && lastReceipt && (
              <div className="inline-success">
                {lastReceipt.queueRow?.status === 'failed'
                  ? 'Sale saved on this device but needs attention. See the rejection details above.'
                  : lastReceipt.queueRow
                    ? 'Sale saved on this device and queued to sync.'
                    : 'Sale synced successfully.'}
                {' '}{lastReceipt.items.length} item(s), {formatKes(lastReceipt.total)} via {lastReceipt.paymentMethod}.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}