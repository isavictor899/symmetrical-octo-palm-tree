import { useEffect, useState } from 'react';
import { usePowerSync, useQuery, useStatus } from '@powersync/react';
import { supabase } from '../lib/supabaseClient';
import { flushAll } from '../lib/powersync/flush';
import { canReceiveStock } from '../lib/roles';
import { useStaff } from '../lib/useStaff';
import './ReceiveStock.css';

const initialForm = {
  drugId: '', supplierId: '', newSupplierName: '', batchNumber: '', expiryDate: '',
  costPrice: '', sellingPrice: '', quantity: '', initialRequiresPrescription: '',
};

export default function ReceiveStock({ activeShopId, activeShopName }) {
  const db = usePowerSync();
  const syncStatus = useStatus();
  const minExpiryDate = new Date().toISOString().slice(0, 10);

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
  const effectiveShopId = activeShopId || staff?.shopId || null;

  useEffect(() => {
    setForm(initialForm);
    setSelectedDrug(null);
    setError('');
    setMessage('');
  }, [effectiveShopId]);

  // Reactive local reads — work offline once synced at least once.
  // Defaults to what THIS shop actually carries (a short list). Searching
  // the full drug catalog is opt-in, for a drug the shop has never stocked.
  // A harmless placeholder query is used until staff resolves, so the hook
  // is never called with null (that can break hook ordering).
  const { data: myDrugs } = useQuery(
    effectiveShopId
      ? `SELECT drugs.id, drugs.name, drugs.generic_name, shop_drugs.requires_prescription
         FROM shop_drugs
         JOIN drugs ON drugs.id = shop_drugs.drug_id
         WHERE shop_drugs.shop_id = ?
         ORDER BY drugs.name`
      : 'SELECT 1 WHERE 0',
    effectiveShopId ? [effectiveShopId] : []
  );

  const [searchFullCatalog, setSearchFullCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [selectedDrug, setSelectedDrug] = useState(null);
  const catalogTerm = catalogSearch.trim();
  const { data: catalogResults } = useQuery(
    searchFullCatalog && catalogTerm
      ? `SELECT id, name, generic_name FROM drugs
         WHERE name LIKE ? OR generic_name LIKE ?
         ORDER BY name LIMIT 50`
      : 'SELECT 1 WHERE 0',
    searchFullCatalog && catalogTerm ? [`%${catalogTerm}%`, `%${catalogTerm}%`] : []
  );

  const myDrugOptions = selectedDrug && !(myDrugs || []).some((d) => d.id === selectedDrug.id)
    ? [selectedDrug, ...(myDrugs || [])]
    : (myDrugs || []);

  function chooseDrug(drug) {
    setForm((current) => ({ ...current, drugId: drug.id, initialRequiresPrescription: '' }));
    setSelectedDrug(drug);
  }

  const { data: suppliers } = useQuery('SELECT id, name FROM suppliers ORDER BY name');
  const { data: pendingRows } = useQuery(
    'SELECT id, shop_id, drug_id, initial_requires_prescription, status, last_error FROM pending_receipts'
  );
  const { data: selectedShopDrugRows } = useQuery(
    effectiveShopId && form.drugId
      ? 'SELECT requires_prescription FROM shop_drugs WHERE shop_id = ? AND drug_id = ? LIMIT 1'
      : 'SELECT 1 WHERE 0',
    effectiveShopId && form.drugId ? [effectiveShopId, form.drugId] : []
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
           (id, created_by_user_id, shop_id, drug_id, supplier_id, supplier_name, batch_number, expiry_date, cost_price, selling_price, quantity, initial_requires_prescription, created_at, status, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      <h1>Receive stock</h1>
      {activeShopName && <p className="muted">Receiving into {activeShopName}</p>}
    </header>
    {failedReceipts.length > 0 && <section aria-label="Receipts needing attention" className="notice danger">
      <strong>{failedReceipts.length} receipt{failedReceipts.length === 1 ? '' : 's'} need attention</strong>
      {failedReceipts.map((row) => <div key={row.id} className="notice-row">
        <span>{row.last_error || 'The server rejected this receipt.'}</span>
        <button type="button" onClick={async () => { await db.execute("UPDATE pending_receipts SET status = 'pending', last_error = NULL WHERE id = ?", [row.id]); flushAll(db); }}>Retry</button>
      </div>)}
    </section>}
    <form onSubmit={submit}>
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
      <button disabled={saving}>{saving ? 'Recording stock…' : 'Receive stock'}</button>
      {error && <p className="error">{error}</p>}{message && <p className="success">{message}</p>}
    </form>
  </main>;
}