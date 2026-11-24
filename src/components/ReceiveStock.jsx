import { useEffect, useState } from 'react';
import { usePowerSync, useQuery, useStatus } from '@powersync/react';
import { supabase } from '../lib/supabaseClient';
import { flushAll } from '../lib/powersync/flush';
import { canReceiveStock } from '../lib/roles';
import { useStaff } from '../lib/useStaff';
import { todayNairobi } from '../lib/dates';
import './ReceiveStock.css';

const initialForm = {
  drugId: '', supplierId: '', newSupplierName: '', batchNumber: '', expiryDate: '',
  costPrice: '', sellingPrice: '', quantity: '', initialRequiresPrescription: '', paidNow: false,
};

export default function ReceiveStock({ activeShopId, activeShopName, isActive = true }) {
  const db = usePowerSync();
  const syncStatus = useStatus();
  const minExpiryDate = todayNairobi();

  const { staff: resolvedStaff, error: staffLookupError } = useStaff();
  // Only pharmacists and admins may receive stock.
  const staff = resolvedStaff && canReceiveStock(resolvedStaff.role) ? resolvedStaff : null;
  let staffError = '';
  if (staffLookupError?.code === 'not_signed_in') {
    staffError = 'Not signed in.';
  } else if (staffLookupError) {
    staffError = `No staff record found for this account yet (${staffLookupError.message}). Confirm this user is added to staff, then refresh.`;
  } else if (resolvedStaff && !staff) {
    staffError = 'Only a pharmacist or administrator can receive stock.';
  }
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [receiptType, setReceiptType] = useState('drug');
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [newItemType, setNewItemType] = useState('');
  const [newDrug, setNewDrug] = useState({ name: '', generic_name: '', category: '', form: '', strength: '', unit_of_sale: '' });
  const [newEquipment, setNewEquipment] = useState({ name: '', category: '', unit: 'piece', description: '' });
  const [equipmentSupplies, setEquipmentSupplies] = useState([]);
  const [equipmentShopId, setEquipmentShopId] = useState(null);
  const [equipmentForm, setEquipmentForm] = useState({ equipmentSupplyId: '', supplierName: '', quantity: '', unitCost: '', sellingPrice: '', note: '' });
  const effectiveShopId = activeShopId || staff?.shopId || null;
  const shopEquipmentSupplies = equipmentShopId === effectiveShopId ? equipmentSupplies : [];

  async function loadEquipmentSupplies() {
    const { data: stock, error: stockError } = await supabase
      .from('shop_equipment_stock')
      .select('equipment_supply_id, quantity_on_hand, average_cost, selling_price, equipment_supplies(id, name, category, unit, description)')
      .eq('shop_id', effectiveShopId)
      .order('equipment_supply_id');
    if (stockError) throw stockError;
    setEquipmentSupplies((stock || []).map((row) => ({
      ...row.equipment_supplies,
      ...row,
      id: row.equipment_supply_id,
    })).filter((item) => item.name));
    setEquipmentShopId(effectiveShopId);
  }

  useEffect(() => {
    setEquipmentShopId(null);
    setEquipmentSupplies([]);
    if (!effectiveShopId || !isActive) return;
    loadEquipmentSupplies().catch((loadError) => setError(loadError.message || 'Could not load equipment supplies.'));
  }, [effectiveShopId, isActive]);

  useEffect(() => {
    setForm(initialForm);
    setSelectedDrug(null);
    setEquipmentForm((current) => ({ ...current, equipmentSupplyId: '' }));
    setError('');
    setMessage('');
  }, [effectiveShopId]);

  // Reactive local reads — work offline once synced at least once.
  // Defaults to what THIS shop actually carries (a short list). Searching
  // the full drug catalog is opt-in, for a drug the shop has never stocked.
  // A harmless placeholder query is used until staff resolves, so the hook
  // is never called with null (that can break hook ordering).
  const { data: myDrugs } = useQuery(
    effectiveShopId && isActive
      ? `SELECT drugs.id, drugs.name, drugs.generic_name, shop_drugs.requires_prescription
         FROM shop_drugs
         JOIN drugs ON drugs.id = shop_drugs.drug_id
         WHERE shop_drugs.shop_id = ?
         ORDER BY drugs.name`
      : 'SELECT 1 WHERE 0',
    effectiveShopId && isActive ? [effectiveShopId] : []
  );

  const [searchFullCatalog, setSearchFullCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [selectedDrug, setSelectedDrug] = useState(null);
  const catalogTerm = catalogSearch.trim();
  const { data: catalogResults } = useQuery(
    isActive && searchFullCatalog && catalogTerm
      ? `SELECT id, name, generic_name FROM drugs
         WHERE name LIKE ? OR generic_name LIKE ?
         ORDER BY name LIMIT 50`
      : 'SELECT 1 WHERE 0',
    isActive && searchFullCatalog && catalogTerm ? [`%${catalogTerm}%`, `%${catalogTerm}%`] : []
  );

  const myDrugOptions = selectedDrug && !(myDrugs || []).some((d) => d.id === selectedDrug.id)
    ? [selectedDrug, ...(myDrugs || [])]
    : (myDrugs || []);

  function chooseDrug(drug) {
    setForm((current) => ({ ...current, drugId: drug.id, initialRequiresPrescription: '' }));
    setSelectedDrug(drug);
  }

  const { data: suppliers } = useQuery(isActive ? 'SELECT id, name FROM suppliers ORDER BY name' : 'SELECT 1 WHERE 0');
  const { data: pendingRows } = useQuery(
    isActive
      ? 'SELECT id, shop_id, drug_id, initial_requires_prescription, status, last_error FROM pending_receipts'
      : 'SELECT 1 WHERE 0'
  );
  const { data: selectedShopDrugRows } = useQuery(
    effectiveShopId && form.drugId && isActive
      ? 'SELECT requires_prescription FROM shop_drugs WHERE shop_id = ? AND drug_id = ? LIMIT 1'
      : 'SELECT 1 WHERE 0',
    effectiveShopId && form.drugId && isActive ? [effectiveShopId, form.drugId] : []
  );
  const waitingReceipts = (pendingRows || []).filter((row) => !row.status || row.status === 'pending');
  const failedReceipts = (pendingRows || []).filter((row) => row.status === 'failed');
  const pendingCount = waitingReceipts.length;
  const existingShopDrug = selectedShopDrugRows?.[0] || null;
  const queuedClassification = waitingReceipts.find((row) =>
    row.shop_id === effectiveShopId
    && row.drug_id === form.drugId
    && row.initial_requires_prescription !== null
    && row.initial_requires_prescription !== undefined
    && row.initial_requires_prescription !== ''
  );
  const existingClassificationMissing = existingShopDrug
    && (existingShopDrug.requires_prescription === null || existingShopDrug.requires_prescription === undefined || existingShopDrug.requires_prescription === '');
  const needsInitialClassification = Boolean(form.drugId) && (!existingShopDrug || existingClassificationMissing) && !queuedClassification;

  function classificationLabel(value) {
    if (value === null || value === undefined || value === '') return 'Not yet classified';
    if (Number(value) === 1) return 'POM / Prescription Only';
    if (Number(value) === 0) return 'OTC';
    return 'Not yet classified';
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  // Writes the receipt into the LOCAL pending_receipts queue instead of
  // calling receive_stock directly — works offline. The connector picks
  // it up and calls receive_stock automatically once there's connectivity.
  async function submit(event) {
    event.preventDefault();
    if (!staff || !effectiveShopId || saving) return;
    if (receiptType === 'equipment') {
      await submitEquipment();
      return;
    }
    if (!form.drugId) {
      setError('Choose a drug before receiving stock.');
      return;
    }
    if (needsInitialClassification && !form.initialRequiresPrescription) {
      setError('Classify this drug as POM or OTC before receiving stock.');
      return;
    }
    setSaving(true); setError(''); setMessage('');
    try {
      const localId = crypto.randomUUID();
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) throw new Error('Your sign-in session is unavailable. Sign in again before receiving stock.');
      await db.execute(
        `INSERT INTO pending_receipts
           (id, created_by_user_id, shop_id, drug_id, supplier_id, supplier_name, batch_number, expiry_date, cost_price, selling_price, quantity, paid_now, initial_requires_prescription, created_at, status, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localId,
          session.user.id,
          effectiveShopId,
          form.drugId,
          form.supplierId || '',
          form.newSupplierName || '',
          form.batchNumber || '',
          form.expiryDate,
          Number(form.costPrice),
          Number(form.sellingPrice),
          Number(form.quantity),
          form.paidNow ? 1 : 0,
          needsInitialClassification
            ? (form.initialRequiresPrescription === 'pom' ? 1 : 0)
            : queuedClassification?.initial_requires_prescription ?? null,
          new Date().toISOString(),
          'pending',
          null,
        ]
      );
      await flushAll(db);
      const remaining = await db.getAll('SELECT status FROM pending_receipts WHERE id = ?', [localId]);
      if (!remaining.length) {
        window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', {
          detail: { type: 'receipt', shopId: effectiveShopId },
        }));
      }
      setMessage(remaining[0]?.status === 'failed'
        ? 'Receipt saved on this device but rejected by the server. See the details above.'
        : remaining.length
          ? 'Recorded on this device — queued to sync when online.'
          : 'Stock receipt synced successfully.');
      setForm(initialForm);
      setSelectedDrug(null);
    } catch (receiveError) {
      setError(receiveError.message || 'Could not receive stock.');
    } finally {
      setSaving(false);
    }
  }

  async function createDrug(event) {
    event.preventDefault();
    setSaving(true); setError(''); setMessage('');
    try {
      if (!effectiveShopId) throw new Error('No shop is selected for this drug.');
      // Creates a drug private to this shop. It is never written to the shared catalogue.
      const { data: created, error: rpcError } = await supabase.rpc('create_shop_drug', {
        p_shop_id: effectiveShopId,
        p_name: newDrug.name.trim(),
        p_generic_name: newDrug.generic_name.trim() || null,
        p_category: newDrug.category.trim() || null,
        p_form: newDrug.form.trim() || null,
        p_strength: newDrug.strength.trim() || null,
        p_unit_of_sale: newDrug.unit_of_sale.trim() || null,
      });
      if (rpcError) throw rpcError;
      const row = Array.isArray(created) ? created[0] : created;
      const data = { id: row.drug_id, name: row.drug_name, generic_name: row.drug_generic_name };
      chooseDrug(data);
      setReceiptType('drug');
      setSearchFullCatalog(true);
      setNewItemType('');
      setNewDrug({ name: '', generic_name: '', category: '', form: '', strength: '', unit_of_sale: '' });
      setMessage(`${data.name} was added to the drug catalog. Complete the receipt details below.`);
    } catch (createError) {
      setError(createError.message || 'Could not add the drug to the catalog.');
    } finally {
      setSaving(false);
    }
  }

  async function createEquipment(event) {
    event.preventDefault();
    setSaving(true); setError(''); setMessage('');
    try {
      const { data, error: createError } = await supabase.rpc('create_equipment_supply', {
        p_name: newEquipment.name.trim(),
        p_category: newEquipment.category.trim(),
        p_unit: newEquipment.unit,
        p_description: newEquipment.description.trim() || null,
      });
      if (createError) throw createError;
      const item = Array.isArray(data) ? data[0] : data;
      setEquipmentSupplies((current) => {
        const createdForThisShop = {
          id: item.id,
          name: item.name,
          category: item.category,
          unit: item.unit,
          description: item.description || '',
          quantity_on_hand: 0,
          average_cost: 0,
          selling_price: 0,
        };
        return [createdForThisShop, ...current.filter((existing) => existing.id !== item.id)];
      });
      setEquipmentShopId(effectiveShopId);
      setEquipmentForm((current) => ({ ...current, equipmentSupplyId: item.id }));
      setReceiptType('equipment');
      setNewItemType('');
      setNewEquipment({ name: '', category: '', unit: 'piece', description: '' });
      setMessage(`${item.name} was added to the equipment catalog. Complete the receipt details below.`);
    } catch (createError) {
      setError(createError.message || 'Could not add the equipment supply. Apply the equipment database migration and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function submitEquipment(event) {
    if (event) event.preventDefault();
    if (!staff || !effectiveShopId || saving) return;
    if (!navigator.onLine) {
      setError('Receiving medical equipment requires an internet connection. Reconnect and try again.');
      return;
    }
    setSaving(true); setError(''); setMessage('');
    try {
      const { error: receiptError } = await supabase.rpc('receive_equipment_supply', {
        p_shop_id: effectiveShopId,
        p_equipment_supply_id: equipmentForm.equipmentSupplyId,
        p_quantity: Number(equipmentForm.quantity),
        p_unit_cost: Number(equipmentForm.unitCost),
        p_selling_price: Number(equipmentForm.sellingPrice),
        p_supplier_name: equipmentForm.supplierName.trim() || null,
        p_note: equipmentForm.note.trim() || null,
      });
      if (receiptError) throw receiptError;
      setMessage('Medical equipment stock received successfully.');
      setEquipmentForm((current) => ({ ...current, quantity: '', unitCost: '', sellingPrice: '', note: '' }));
      await loadEquipmentSupplies();
    } catch (receiptError) {
      setError(receiptError.message || 'Could not receive medical equipment stock.');
    } finally {
      setSaving(false);
    }
  }

  async function saveEquipmentPrice() {
    if (!effectiveShopId || !equipmentForm.equipmentSupplyId || Number(equipmentForm.sellingPrice) <= 0 || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const { error: priceError } = await supabase.rpc('set_equipment_supply_selling_price', {
        p_shop_id: effectiveShopId,
        p_equipment_supply_id: equipmentForm.equipmentSupplyId,
        p_selling_price: Number(equipmentForm.sellingPrice),
      });
      if (priceError) throw priceError;
      setMessage('Equipment selling price updated.');
      await loadEquipmentSupplies();
    } catch (priceError) {
      setError(priceError.message || 'Could not update the equipment selling price.');
    } finally {
      setSaving(false);
    }
  }

  if (staffError) return <main className="receive-stock"><p className="error">{staffError}</p></main>;
  if (!staff) return <main className="receive-stock"><p>Loading receiving form…</p></main>;

  return <main className="receive-stock">
    <header>
      <p className="pos-status-row">
        <span
          className={`status-dot ${syncStatus.connected ? 'online' : 'offline'}`}
          title={syncStatus.connected ? 'Online — syncing' : 'Offline — receipts will queue locally'}
        />
        {syncStatus.connected ? 'Online' : 'Offline'}
        {pendingCount > 0 && <span className="status-warning"> · {pendingCount} receipt{pendingCount === 1 ? '' : 's'} waiting to sync</span>}
        {failedReceipts.length > 0 && <span className="status-critical"> · {failedReceipts.length} need attention</span>}
      </p>
      <div className="receive-heading">
        <h1>Receive stock</h1>
        <div className="new-item-menu-wrap">
          <button type="button" className="new-item-button" onClick={() => setShowNewMenu((visible) => !visible)}>＋ New</button>
          {showNewMenu && <div className="new-item-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setNewItemType('drug'); setShowNewMenu(false); }}>＋ New drug</button>
            <button type="button" role="menuitem" onClick={() => { setNewItemType('equipment'); setShowNewMenu(false); }}>＋ Medical equipment</button>
          </div>}
        </div>
      </div>
      {activeShopName && <p className="muted">Receiving into {activeShopName}</p>}
    </header>
    {failedReceipts.length > 0 && <section aria-label="Receipts needing attention" className="notice danger">
      <strong>{failedReceipts.length} receipt{failedReceipts.length === 1 ? '' : 's'} need attention</strong>
      {failedReceipts.map((row) => <div key={row.id} className="notice-row">
        <span>{row.last_error || 'The server rejected this receipt.'}</span>
        <button type="button" onClick={async () => { await db.execute("UPDATE pending_receipts SET status = 'pending', last_error = NULL WHERE id = ?", [row.id]); flushAll(db); }}>Retry</button>
      </div>)}
    </section>}
    <div className="receipt-type-switch" role="group" aria-label="Stock type">
      <button type="button" className={receiptType === 'drug' ? 'active' : ''} onClick={() => { setReceiptType('drug'); setError(''); setMessage(''); }}>Drugs</button>
      <button type="button" className={receiptType === 'equipment' ? 'active' : ''} onClick={() => { setReceiptType('equipment'); setError(''); setMessage(''); }}>Medical equipment</button>
    </div>
    {receiptType === 'drug' ? <form onSubmit={submit}>
      <label className="drug-field">
        Drug
        {!searchFullCatalog && (
          <>
            <select required value={form.drugId} onChange={(event) => {
              const drug = myDrugOptions.find((d) => d.id === event.target.value);
              if (drug) chooseDrug(drug);
              else setForm((current) => ({ ...current, drugId: '', initialRequiresPrescription: '' }));
            }}>
              <option value="">Select from what you stock</option>
              {myDrugOptions.map((drug) => (
                <option value={drug.id} key={drug.id}>{drug.name}{drug.generic_name ? ` — ${drug.generic_name}` : ''}</option>
              ))}
            </select>
            {(myDrugs || []).length === 0 && <small className="hint">Nothing stocked at this shop yet — search the full catalog to add the first drug.</small>}
            <button type="button" className="link-button" onClick={() => setSearchFullCatalog(true)}>
              Don't see it? Search the full drug catalog
            </button>
          </>
        )}
        {searchFullCatalog && (
          <>
            {selectedDrug ? (
              <div className="selected-drug">
                <span>{selectedDrug.name}{selectedDrug.generic_name ? ` — ${selectedDrug.generic_name}` : ''}</span>
                <button type="button" className="link-button" onClick={() => { setSelectedDrug(null); update('drugId', ''); }}>Change</button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  autoFocus
                  placeholder="Search full catalog by name or generic…"
                  value={catalogSearch}
                  onChange={(event) => setCatalogSearch(event.target.value)}
                />
                {catalogTerm && (
                  <div className="catalog-results">
                    {(catalogResults || []).length === 0 ? (
                      <div className="hint">No matches for "{catalogTerm}".</div>
                    ) : (
                      catalogResults.map((drug) => (
                        <button
                          type="button"
                          key={drug.id}
                          className="catalog-result"
                          onClick={() => { chooseDrug(drug); setCatalogSearch(''); }}
                        >
                          {drug.name}{drug.generic_name ? ` — ${drug.generic_name}` : ''}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
            <button type="button" className="link-button" onClick={() => { setSearchFullCatalog(false); setCatalogSearch(''); setSelectedDrug(null); update('drugId', ''); }}>
              Back to what I stock
            </button>
          </>
        )}
      </label>
      {form.drugId && (
        <section className="classification-field" aria-label="Prescription classification">
          <strong>Prescription classification</strong>
          {existingShopDrug && !existingClassificationMissing ? (
            <p>This shop already classifies this drug as <b>{classificationLabel(existingShopDrug.requires_prescription)}</b>. Change it from Stocked drugs if needed.</p>
          ) : queuedClassification ? (
            <p><b>{classificationLabel(queuedClassification.initial_requires_prescription)}</b> is queued as this shop’s first classification for this drug.</p>
          ) : (
            <>
              <p>{existingClassificationMissing
                ? 'This stocked drug is not yet classified. Choose POM or OTC before receiving another batch.'
                : 'This is the first time this shop is stocking the drug. Choose its classification.'}</p>
              <div className="classification-options">
                <label><input type="radio" name="initial-prescription-classification" value="pom" checked={form.initialRequiresPrescription === 'pom'} onChange={(event) => update('initialRequiresPrescription', event.target.value)} /> POM / Prescription Only</label>
                <label><input type="radio" name="initial-prescription-classification" value="otc" checked={form.initialRequiresPrescription === 'otc'} onChange={(event) => update('initialRequiresPrescription', event.target.value)} /> OTC</label>
              </div>
            </>
          )}
        </section>
      )}
      <label>Supplier<select value={form.supplierId} onChange={(event) => update('supplierId', event.target.value)}><option value="">Add a new supplier below</option>{(suppliers || []).map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}</select></label>
      {!form.supplierId && <label>New supplier name<input required value={form.newSupplierName} onChange={(event) => update('newSupplierName', event.target.value)} placeholder="e.g. MedSupply Kenya" /></label>}
      <label>Batch number<input value={form.batchNumber} onChange={(event) => update('batchNumber', event.target.value)} placeholder="e.g. AMX-2409" /></label>
      <label>
        Expiry date
        <input
          required
          type="date"
          lang="en-GB"
          min={minExpiryDate}
          value={form.expiryDate}
          onChange={(event) => update('expiryDate', event.target.value)}
          onClick={(event) => {
            // Android browsers can render the date field like plain text and
            // fail to open the native picker unless it is explicitly invoked.
            if (typeof event.currentTarget.showPicker === 'function') {
              try {
                event.currentTarget.showPicker();
              } catch {
                // Keep the native input usable in browsers that open it on focus.
              }
            }
          }}
        />
      </label>
      <label>Cost price (KES)<input required min="0" step="0.01" type="number" value={form.costPrice} onChange={(event) => update('costPrice', event.target.value)} /></label>
      <label>Selling price (KES)<input required min="0" step="0.01" type="number" value={form.sellingPrice} onChange={(event) => update('sellingPrice', event.target.value)} /></label>
      <label>Quantity received<input required min="1" step="1" type="number" value={form.quantity} onChange={(event) => update('quantity', event.target.value)} /></label>
      <label className="receipt-payment-choice"><input type="checkbox" checked={form.paidNow} onChange={(event) => update('paidNow', event.target.checked)} /> Supplier was paid now <small>{form.paidNow ? 'Records the cost as a stock-purchase expense after this receipt syncs.' : 'Unpaid receipts appear under Supplier debts, where you can record payment later.'}</small></label>
      <button disabled={saving}>{saving ? 'Recording stock…' : 'Receive stock'}</button>
      {error && <p className="error">{error}</p>}{message && <p className="success">{message}</p>}
    </form> : <form onSubmit={submitEquipment}>
      <label className="drug-field">Medical equipment / supply
        <select required value={equipmentForm.equipmentSupplyId} onChange={(event) => {
          const selected = shopEquipmentSupplies.find((item) => item.id === event.target.value);
          setEquipmentForm((current) => ({ ...current, equipmentSupplyId: event.target.value, sellingPrice: selected?.selling_price ? String(selected.selling_price) : current.sellingPrice }));
        }}>
          <option value="">Select equipment or supply</option>
          {shopEquipmentSupplies.map((item) => <option value={item.id} key={item.id}>{item.name} — {item.category} ({item.unit}) · {Number(item.quantity_on_hand || 0)} on hand</option>)}
        </select>
        {shopEquipmentSupplies.length === 0 && <small className="hint">No equipment supplies stocked at this shop yet. Use New to add one for this shop.</small>}
      </label>
      <label>Supplier name<input value={equipmentForm.supplierName} onChange={(event) => setEquipmentForm((current) => ({ ...current, supplierName: event.target.value }))} placeholder="Optional" /></label>
      <label>Quantity received<input required min="1" step="1" type="number" value={equipmentForm.quantity} onChange={(event) => setEquipmentForm((current) => ({ ...current, quantity: event.target.value }))} /></label>
      <label>Unit cost (KES)<input required min="0" step="0.01" type="number" value={equipmentForm.unitCost} onChange={(event) => setEquipmentForm((current) => ({ ...current, unitCost: event.target.value }))} /></label>
      <label>Selling price per unit (KES)<input required min="0.01" step="0.01" type="number" value={equipmentForm.sellingPrice} onChange={(event) => setEquipmentForm((current) => ({ ...current, sellingPrice: event.target.value }))} /></label>
      <button type="button" className="button secondary" disabled={saving || !equipmentForm.equipmentSupplyId || Number(equipmentForm.sellingPrice) <= 0} onClick={saveEquipmentPrice}>Save price without receiving stock</button>
      <label className="drug-field">Note<input value={equipmentForm.note} onChange={(event) => setEquipmentForm((current) => ({ ...current, note: event.target.value }))} placeholder="Optional receipt details" /></label>
      <button disabled={saving || !equipmentForm.equipmentSupplyId}>{saving ? 'Recording stock…' : 'Receive equipment stock'}</button>
      {error && <p className="error">{error}</p>}{message && <p className="success">{message}</p>}
    </form>}
    {newItemType && <div className="new-item-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewItemType(''); }}>
      <section className="new-item-dialog" role="dialog" aria-modal="true" aria-labelledby="new-item-title">
        <button type="button" className="dialog-close" aria-label="Close" onClick={() => setNewItemType('')}>×</button>
        <h2 id="new-item-title">Add {newItemType === 'drug' ? 'new drug' : 'medical equipment / supply'}</h2>
        {newItemType === 'drug' ? <form onSubmit={createDrug}>
          <label>Drug name<input required autoFocus value={newDrug.name} onChange={(event) => setNewDrug((current) => ({ ...current, name: event.target.value }))} /></label>
          <label>Generic name<input value={newDrug.generic_name} onChange={(event) => setNewDrug((current) => ({ ...current, generic_name: event.target.value }))} /></label>
          <label>Category<input value={newDrug.category} onChange={(event) => setNewDrug((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Antibiotic" /></label>
          <label>Form<input value={newDrug.form} onChange={(event) => setNewDrug((current) => ({ ...current, form: event.target.value }))} placeholder="e.g. Tablet, syrup, cream" /></label>
          <label>Strength<input value={newDrug.strength} onChange={(event) => setNewDrug((current) => ({ ...current, strength: event.target.value }))} placeholder="e.g. 500 mg" /></label>
          <label>Unit of sale<input value={newDrug.unit_of_sale} onChange={(event) => setNewDrug((current) => ({ ...current, unit_of_sale: event.target.value }))} placeholder="e.g. tablet, bottle, pack" /></label>
          <button disabled={saving}>{saving ? 'Adding drug…' : 'Add drug to catalog'}</button>
        </form> : <form onSubmit={createEquipment}>
          <label>Name<input required autoFocus value={newEquipment.name} onChange={(event) => setNewEquipment((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Examination gloves" /></label>
          <label>Category<input required value={newEquipment.category} onChange={(event) => setNewEquipment((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Protective equipment" /></label>
          <label>Unit<select value={newEquipment.unit} onChange={(event) => setNewEquipment((current) => ({ ...current, unit: event.target.value }))}><option>piece</option><option>box</option><option>pack</option><option>set</option><option>pair</option><option>roll</option><option>bottle</option></select></label>
          <label>Description<input value={newEquipment.description} onChange={(event) => setNewEquipment((current) => ({ ...current, description: event.target.value }))} placeholder="Optional details" /></label>
          <button disabled={saving}>{saving ? 'Adding supply…' : 'Add to equipment catalog'}</button>
        </form>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </div>}
  </main>;
}
