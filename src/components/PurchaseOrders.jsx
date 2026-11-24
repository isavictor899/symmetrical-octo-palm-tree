import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@powersync/react';
import { supabase } from '../lib/supabaseClient';
import { canReceiveStock } from '../lib/roles';
import { useStaff } from '../lib/useStaff';
import './PurchaseOrders.css';

const kes = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', minimumFractionDigits: 2 });

function printGrn(receipt) {
  // `noopener` makes window.open return null in major browsers, so the old
  // handler exited before putting any GRN content in the print window.
  const popup = window.open('', '_blank', 'width=720,height=800');
  if (!popup) return false;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  popup.document.write(`<!doctype html><html><head><title>GRN ${escapeHtml(receipt.number)}</title><style>body{font:14px Arial,sans-serif;color:#18211d;margin:32px}h1{margin:0 0 4px;font-size:22px}p{margin:4px 0;color:#53605a}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{padding:10px 4px;border-bottom:1px solid #dfe4df;text-align:left}th:last-child,td:last-child{text-align:right}.total{margin-top:20px;font-weight:700}@media print{body{margin:18px}}</style></head><body><h1>Goods Received Note</h1><p>${escapeHtml(receipt.number)} · ${escapeHtml(receipt.date)}</p><p><b>Receiving shop:</b> ${escapeHtml(receipt.shop)}</p><p><b>Supplier:</b> ${escapeHtml(receipt.supplier)}</p><table><thead><tr><th>Drug</th><th>Batch</th><th>Expiry</th><th>Quantity</th><th>Unit cost</th></tr></thead><tbody><tr><td>${escapeHtml(receipt.drug)}</td><td>${escapeHtml(receipt.batch || '—')}</td><td>${escapeHtml(receipt.expiry)}</td><td>${Number(receipt.quantity)}</td><td>${kes.format(Number(receipt.cost))}</td></tr></tbody></table><p class="total">Received value: ${kes.format(Number(receipt.quantity) * Number(receipt.cost))}</p></body></html>`);
  popup.document.close();
  popup.focus();
  let didPrint = false;
  const printOnce = () => { if (!didPrint && !popup.closed) { didPrint = true; popup.print(); } };
  popup.onload = printOnce;
  window.setTimeout(printOnce, 250);
  return true;
}

export default function PurchaseOrders({ activeShopId, activeShopName, isActive = true }) {
  const { staff: resolvedStaff, error: staffError } = useStaff();
  const staff = resolvedStaff && canReceiveStock(resolvedStaff.role) ? resolvedStaff : null;
  const shopId = activeShopId || staff?.shopId || null;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [notes, setNotes] = useState('');
  const [lineDrugId, setLineDrugId] = useState('');
  const [lineQuantity, setLineQuantity] = useState('');
  const [lineCost, setLineCost] = useState('');
  const [lines, setLines] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [receipt, setReceipt] = useState({ quantity: '', batch: '', expiry: '', cost: '', selling: '', paidNow: false });
  const [needsInitialClassification, setNeedsInitialClassification] = useState(false);
  const [initialRequiresPrescription, setInitialRequiresPrescription] = useState('');
  const [existingClassification, setExistingClassification] = useState(null);
  const [saving, setSaving] = useState(false);
  const [lastGrn, setLastGrn] = useState(null);

  // A purchase order can only be raised for drugs this facility already
  // carries. Adding a brand-new drug still happens through Receive stock.
  const { data: drugs } = useQuery(
    shopId && isActive
      ? `SELECT DISTINCT drugs.id, drugs.name, drugs.generic_name
           FROM shop_drugs
           JOIN drugs ON drugs.id = shop_drugs.drug_id
          WHERE shop_drugs.shop_id = ?
          ORDER BY drugs.name`
      : 'SELECT 1 WHERE 0',
    shopId && isActive ? [shopId] : []
  );
  const { data: suppliers } = useQuery(isActive ? 'SELECT id, name FROM suppliers ORDER BY name' : 'SELECT 1 WHERE 0');
  const drugOptions = useMemo(() => drugs || [], [drugs]);

  async function loadOrders() {
    if (!shopId) return;
    setLoading(true);
    try {
      const { data, error: requestError } = await supabase.rpc('purchase_order_list', { p_shop_id: shopId });
      if (requestError) throw requestError;
      setOrders(Array.isArray(data) ? data : []);
    } catch (loadError) {
      setError(loadError.message || 'Could not load purchase orders. Apply the purchase-order database migration and try again.');
    } finally { setLoading(false); }
  }

  useEffect(() => { setOrders([]); setSelectedItem(null); setLastGrn(null); setError(''); if (shopId && isActive) loadOrders(); }, [shopId, isActive]);

  function addLine() {
    const drug = drugOptions.find((item) => item.id === lineDrugId);
    const quantity = Number(lineQuantity);
    if (!drug || !Number.isInteger(quantity) || quantity < 1) { setError('Choose a drug and enter a whole-unit quantity.'); return; }
    if (lines.some((line) => line.drug_id === drug.id)) { setError('This drug is already on the order. Edit the existing line instead.'); return; }
    setLines((current) => [...current, { drug_id: drug.id, drug_name: drug.name, generic_name: drug.generic_name, quantity, unit_cost_estimate: lineCost === '' ? null : Number(lineCost) }]);
    setLineDrugId(''); setLineQuantity(''); setLineCost(''); setError('');
  }

  async function createOrder(event) {
    event.preventDefault();
    if (!shopId || saving) return;
    if (!supplierId && !supplierName.trim()) { setError('Choose a supplier or enter its name.'); return; }
    if (!lines.length) { setError('Add at least one drug to the purchase order.'); return; }
    setSaving(true); setError(''); setMessage('');
    try {
      const { error: createError } = await supabase.rpc('create_purchase_order', { p_shop_id: shopId, p_supplier_id: supplierId || null, p_supplier_name: supplierName.trim() || null, p_notes: notes.trim() || null, p_items: lines });
      if (createError) throw createError;
      setLines([]); setSupplierId(''); setSupplierName(''); setNotes(''); setMessage('Purchase order created. Receive each line as stock arrives.');
      await loadOrders();
    } catch (createError) { setError(createError.message || 'Could not create the purchase order.'); }
    finally { setSaving(false); }
  }

  async function beginReceiving(order, item) {
    const remaining = Number(item.quantity_ordered) - Number(item.quantity_received);
    setError(''); setMessage('');
    try {
      // Read the selected shop's classification from Supabase so this check
      // does not depend on the local sync cache being current.
      const { data: shopDrug, error: classificationError } = await supabase
        .from('shop_drugs')
        .select('requires_prescription')
        .eq('shop_id', shopId)
        .eq('drug_id', item.drug_id)
        .maybeSingle();
      if (classificationError) throw classificationError;
      const hasClassification = shopDrug?.requires_prescription === true || shopDrug?.requires_prescription === false;
      setNeedsInitialClassification(!hasClassification);
      setExistingClassification(hasClassification ? shopDrug.requires_prescription : null);
      setInitialRequiresPrescription('');
    } catch (classificationError) {
      setError(classificationError.message || 'Could not check this shop’s POM/OTC classification.');
      return;
    }
    setSelectedItem({ order, item, remaining });
    setReceipt({ quantity: String(remaining), batch: '', expiry: '', cost: item.unit_cost_estimate ? String(item.unit_cost_estimate) : '', selling: '', paidNow: false });
  }

  async function receiveOrderLine(event) {
    event.preventDefault();
    if (!selectedItem || saving) return;
    const quantity = Number(receipt.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > selectedItem.remaining) { setError(`Receive between 1 and ${selectedItem.remaining} units.`); return; }
    if (needsInitialClassification && !initialRequiresPrescription) { setError('Choose POM or OTC before receiving this drug into the shop.'); return; }
    setSaving(true); setError(''); setMessage('');
    try {
      const { data: receiptId, error: receiveError } = await supabase.rpc('receive_purchase_order_item', {
        p_purchase_order_item_id: selectedItem.item.id, p_quantity: quantity,
        p_batch_number: receipt.batch.trim() || null, p_expiry_date: receipt.expiry,
        p_cost_price: Number(receipt.cost), p_selling_price: Number(receipt.selling),
        p_client_batch_id: crypto.randomUUID(),
        p_initial_requires_prescription: needsInitialClassification ? initialRequiresPrescription === 'pom' : null,
        p_paid_now: receipt.paidNow,
      });
      if (receiveError) throw receiveError;
      const note = { number: `GRN-${String(receiptId).replaceAll('-', '').slice(0, 8).toUpperCase()}`, date: new Date().toLocaleString('en-KE'), shop: activeShopName || 'Selected shop', supplier: selectedItem.order.supplier_name, drug: selectedItem.item.drug_name, batch: receipt.batch.trim(), expiry: receipt.expiry, quantity, cost: Number(receipt.cost) };
      setLastGrn(note); setSelectedItem(null); setMessage('Goods received note recorded. The purchase order has been updated.');
      window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', { detail: { type: 'purchase-receipt', shopId } }));
      await loadOrders();
    } catch (receiveError) { setError(receiveError.message || 'Could not receive this purchase-order line.'); }
    finally { setSaving(false); }
  }

  if (staffError || (resolvedStaff && !staff)) return <main className="purchase-orders"><p className="error">{staffError?.message || 'Only a pharmacist or administrator can manage purchase orders.'}</p></main>;
  if (!staff) return <main className="purchase-orders"><p>Loading purchase orders…</p></main>;

  return <main className="purchase-orders">
    <header><p className="eyebrow">Procurement</p><h1>Purchase orders</h1><p className="muted">Order stock, then receive it in one or more deliveries.{activeShopName ? ` Managing ${activeShopName}.` : ''}</p></header>
    <section className="po-card"><h2>Create purchase order</h2><form onSubmit={createOrder} className="po-form">
      <label>Supplier<select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">Enter supplier name below</option>{(suppliers || []).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
      {!supplierId && <label>Supplier name<input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} placeholder="e.g. MedSupply Kenya" /></label>}
      <label className="po-wide">Order note<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional supplier reference or delivery note" /></label>
      <div className="po-add-line"><label>Drug<select value={lineDrugId} onChange={(event) => setLineDrugId(event.target.value)}><option value="">Choose drug</option>{drugOptions.map((drug) => <option key={drug.id} value={drug.id}>{drug.name}{drug.generic_name ? ` — ${drug.generic_name}` : ''}</option>)}</select></label><label>Quantity<input type="number" min="1" step="1" value={lineQuantity} onChange={(event) => setLineQuantity(event.target.value)} /></label><label>Est. unit cost<input type="number" min="0" step="0.01" value={lineCost} onChange={(event) => setLineCost(event.target.value)} /></label><button type="button" className="button secondary" onClick={addLine}>Add line</button></div>
      {lines.length > 0 && <ul className="po-lines">{lines.map((line) => <li key={line.drug_id}><span><strong>{line.drug_name}</strong><small>{line.generic_name || '—'}</small></span><span>{line.quantity} units {line.unit_cost_estimate !== null ? `· ${kes.format(line.unit_cost_estimate)} est.` : ''}</span><button type="button" onClick={() => setLines((current) => current.filter((item) => item.drug_id !== line.drug_id))}>Remove</button></li>)}</ul>}
      <button className="po-submit" disabled={saving}>{saving ? 'Creating order…' : 'Create purchase order'}</button>
    </form></section>
    {error && <p className="notice danger">{error}</p>}{message && <p className="notice success">{message}</p>}
    {lastGrn && <section className="notice success"><strong>Goods received note ready</strong><span>{lastGrn.drug} · {lastGrn.quantity} units received.</span><button type="button" className="button secondary" onClick={() => printGrn(lastGrn)}>Print GRN</button></section>}
    <section className="po-orders"><div className="po-list-heading"><h2>Orders</h2><button type="button" className="button ghost" onClick={loadOrders} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>{!orders.length && !loading ? <p className="muted">No purchase orders yet.</p> : orders.map((order) => <article className="po-order" key={order.id}><header><div><strong>{order.order_number}</strong><span>{order.supplier_name} · {new Date(order.ordered_at).toLocaleDateString('en-KE')}</span></div><span className={`po-status ${order.status}`}>{order.status}</span></header>{order.notes && <p className="muted small">{order.notes}</p>}<ul>{(order.items || []).map((item) => { const remaining = Number(item.quantity_ordered) - Number(item.quantity_received); return <li key={item.id}><span><strong>{item.drug_name}</strong>{item.generic_name ? <small>{item.generic_name}</small> : null}</span><span>{item.quantity_received} / {item.quantity_ordered} received</span>{remaining > 0 && order.status !== 'cancelled' ? <button type="button" className="button secondary" onClick={() => beginReceiving(order, item)}>Receive {remaining} left</button> : <small>Complete</small>}</li>; })}</ul></article>)}</section>
    {selectedItem && <div className="po-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedItem(null); }}><form className="po-receive-dialog" onSubmit={receiveOrderLine}><button type="button" className="po-close" onClick={() => setSelectedItem(null)} aria-label="Close">×</button><p className="eyebrow">Goods received note</p><h2>Receive {selectedItem.item.drug_name}</h2><p className="muted">{selectedItem.remaining} units remain on {selectedItem.order.order_number}. Receive only what arrived today.</p>{needsInitialClassification ? <fieldset className="po-classification"><legend>Classify this drug for {activeShopName || 'this shop'}</legend><p>Choose the shop’s prescription classification before saving this receipt.</p><label><input type="radio" name="po-prescription-classification" value="pom" checked={initialRequiresPrescription === 'pom'} onChange={(event) => setInitialRequiresPrescription(event.target.value)} /> POM / Prescription Only</label><label><input type="radio" name="po-prescription-classification" value="otc" checked={initialRequiresPrescription === 'otc'} onChange={(event) => setInitialRequiresPrescription(event.target.value)} /> OTC</label></fieldset> : <p className="po-classification-note">This shop already classifies this drug as <strong>{existingClassification ? 'POM / Prescription Only' : 'OTC'}</strong>.</p>}<label>Quantity received<input required type="number" min="1" max={selectedItem.remaining} step="1" value={receipt.quantity} onChange={(event) => setReceipt((current) => ({ ...current, quantity: event.target.value }))} /></label><label>Batch number<input value={receipt.batch} onChange={(event) => setReceipt((current) => ({ ...current, batch: event.target.value }))} /></label><label>Expiry date<input required type="date" value={receipt.expiry} onChange={(event) => setReceipt((current) => ({ ...current, expiry: event.target.value }))} /></label><label>Unit cost (KES)<input required type="number" min="0" step="0.01" value={receipt.cost} onChange={(event) => setReceipt((current) => ({ ...current, cost: event.target.value }))} /></label><label>Selling price (KES)<input required type="number" min="0" step="0.01" value={receipt.selling} onChange={(event) => setReceipt((current) => ({ ...current, selling: event.target.value }))} /></label><label className="po-paid-now"><input type="checkbox" checked={receipt.paidNow} onChange={(event) => setReceipt((current) => ({ ...current, paidNow: event.target.checked }))} /> Supplier was paid now <small>{receipt.paidNow ? 'Records this delivery cost as an expense.' : 'Unpaid receipts appear under Supplier debts for payment tracking.'}</small></label>{error && <p className="po-receive-error" role="alert">{error}</p>}<button disabled={saving}>{saving ? 'Receiving…' : 'Record goods received'}</button></form></div>}
  </main>;
}
