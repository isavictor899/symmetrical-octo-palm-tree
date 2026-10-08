import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { canManageStockedDrugs, isAdminRole } from '../lib/roles';

function formatCurrency(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    minimumFractionDigits: 2,
  }).format(amount);
}

function classificationLabel(value) {
  if (value === null || value === undefined || value === '') return 'Unclassified';
  return Number(value) === 1 ? 'POM' : 'OTC';
}

function classificationClass(value) {
  if (value === null || value === undefined || value === '') return 'classification-badge unclassified';
  return Number(value) === 1 ? 'classification-badge pom' : 'classification-badge otc';
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function isExpiredBatch(batch) {
  return Boolean(batch?.expiry_date && batch.expiry_date < todayString());
}

function batchOptionLabel(batch) {
  return `${batch.batch_number || 'No batch number'} - exp ${batch.expiry_date} - ${batch.quantity_remaining} units`;
}

function priceSummary(batches) {
  const prices = [...new Set((batches || []).map((batch) => Number(batch.selling_price || 0)).filter((price) => price > 0))].sort((a, b) => a - b);
  if (!prices.length) return formatCurrency(0);
  if (prices.length === 1) return formatCurrency(prices[0]);
  return `${formatCurrency(prices[0])} - ${formatCurrency(prices[prices.length - 1])}`;
}

async function attachSupplierNames(batches) {
  const supplierIds = [...new Set((batches || []).map((batch) => batch.supplier_id).filter(Boolean))];
  if (!supplierIds.length) return batches || [];

  try {
    const { data, error } = await supabase.from('suppliers').select('id, name').in('id', supplierIds);
    if (error) return batches || [];
    const names = Object.fromEntries((data || []).map((supplier) => [supplier.id, supplier.name]));
    return (batches || []).map((batch) => ({ ...batch, supplier_name: names[batch.supplier_id] || '' }));
  } catch {
    return batches || [];
  }
}

export default function StockedDrugs({ activeShopId, organizationShops = [], onActiveShopChange, dataVersion = 0 }) {
  const [staff, setStaff] = useState(null);
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [stockRows, setStockRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingStock, setLoadingStock] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editingDrug, setEditingDrug] = useState(null);
  const [classificationValue, setClassificationValue] = useState('');
  const [classificationReason, setClassificationReason] = useState('');
  const [savingClassification, setSavingClassification] = useState(false);
  const [transferDrug, setTransferDrug] = useState(null);
  const [transferBatchId, setTransferBatchId] = useState('');
  const [transferToShopId, setTransferToShopId] = useState('');
  const [transferQuantity, setTransferQuantity] = useState('');
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [writeOffDrug, setWriteOffDrug] = useState(null);
  const [writeOffBatchId, setWriteOffBatchId] = useState('');
  const [writeOffReason, setWriteOffReason] = useState('');
  const [savingWriteOff, setSavingWriteOff] = useState(false);
  const [expandedBatchDrugId, setExpandedBatchDrugId] = useState(null);

  const selectedShop = allShops.find((shop) => shop.id === selectedShopId);
  const destinationShops = useMemo(
    () => allShops.filter((shop) => shop.id !== selectedShopId),
    [allShops, selectedShopId]
  );
  const transferableBatches = transferDrug?.batches?.filter((batch) => !isExpiredBatch(batch)) || [];
  const expiredWriteOffBatches = writeOffDrug?.batches?.filter(isExpiredBatch) || [];
  const selectedTransferBatch = transferableBatches.find((batch) => batch.id === transferBatchId);
  const selectedWriteOffBatch = expiredWriteOffBatches.find((batch) => batch.id === writeOffBatchId);

  useEffect(() => {
    let cancelled = false;

    async function loadStaffAndShops() {
      try {
        setLoading(true);
        setError('');

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) throw new Error('Please sign in to manage stocked drugs.');

        const { data: staffRow, error: staffError } = await supabase
          .from('staff')
          .select('shop_id, role, shops(organization_id)')
          .eq('auth_user_id', user.id)
          .maybeSingle();
        if (staffError) throw staffError;
        if (!staffRow?.shop_id) throw new Error('No shop is linked to this account.');
        if (!canManageStockedDrugs(staffRow.role)) {
          throw new Error('Only a pharmacist or administrator can manage stocked drug classifications.');
        }

        const admin = isAdminRole(staffRow.role);
        const organizationId = staffRow.shops?.organization_id;
        const shopsQuery = admin && organizationId
          ? supabase.from('shops').select('id, name, theme_color').eq('organization_id', organizationId).order('name')
          : supabase.from('shops').select('id, name, theme_color').eq('id', staffRow.shop_id).order('name');
        const { data: shopsData, error: shopsError } = await shopsQuery;
        if (shopsError) throw shopsError;

        if (!cancelled) {
          setStaff({
            shopId: staffRow.shop_id,
            role: staffRow.role,
            isAdmin: admin,
            organizationId,
          });
          setAllShops(shopsData || []);
          setSelectedShopId(staffRow.shop_id);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Unable to load stocked drugs.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStaffAndShops();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!organizationShops.length) return;
    setAllShops(organizationShops);
    if (activeShopId) setSelectedShopId(activeShopId);
  }, [activeShopId, organizationShops]);

  useEffect(() => {
    if (!selectedShopId) return undefined;
    let cancelled = false;

    async function loadStock() {
      try {
        setLoadingStock(true);
        setError('');

        const [shopDrugsResult, batchesResult] = await Promise.all([
          supabase.from('shop_drugs')
            .select('drug_id, requires_prescription, drugs(name, generic_name, form, strength)')
            .eq('shop_id', selectedShopId)
            .order('drug_id'),
          supabase.from('batches')
            .select('id, drug_id, supplier_id, batch_number, expiry_date, cost_price, selling_price, quantity_remaining')
            .eq('shop_id', selectedShopId)
            .gt('quantity_remaining', 0)
            .order('expiry_date', { ascending: true }),
        ]);

        if (shopDrugsResult.error) throw shopDrugsResult.error;
        if (batchesResult.error) throw batchesResult.error;

        const batchesWithSuppliers = await attachSupplierNames(batchesResult.data || []);

        const batchesByDrug = {};
        for (const batch of batchesWithSuppliers) {
          if (!batchesByDrug[batch.drug_id]) batchesByDrug[batch.drug_id] = [];
          batchesByDrug[batch.drug_id].push(batch);
        }

        const rows = (shopDrugsResult.data || []).map((row) => {
          const batches = batchesByDrug[row.drug_id] || [];
          const unitsInStock = batches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0);
          const expiredBatches = batches.filter(isExpiredBatch);
          const availableBatches = batches.filter((batch) => !isExpiredBatch(batch));
          const expiredUnits = expiredBatches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0);
          const availableUnits = availableBatches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0);
          return {
            drug_id: row.drug_id,
            name: row.drugs?.name || 'Unknown drug',
            generic_name: row.drugs?.generic_name || '',
            form: row.drugs?.form || '',
            strength: row.drugs?.strength || '',
            requires_prescription: row.requires_prescription,
            units_in_stock: unitsInStock,
            available_units: availableUnits,
            expired_units: expiredUnits,
            soonest_expiry: availableBatches[0]?.expiry_date || expiredBatches[0]?.expiry_date || null,
            latest_price: availableBatches.reduce((price, batch) => Number(batch.selling_price || 0) || price, 0),
            batches,
          };
        });

        if (!cancelled) setStockRows(rows);
      } catch (stockError) {
        if (!cancelled) setError(stockError.message || 'Unable to load this shop stock.');
      } finally {
        if (!cancelled) setLoadingStock(false);
      }
    }

    loadStock();
    return () => { cancelled = true; };
  }, [selectedShopId, dataVersion]);

  function openClassificationEditor(item) {
    setEditingDrug(item);
    setClassificationValue(
      item.requires_prescription === null || item.requires_prescription === undefined || item.requires_prescription === ''
        ? ''
        : Number(item.requires_prescription) === 1
          ? 'pom'
          : 'otc'
    );
    setClassificationReason('');
    setError('');
    setMessage('');
  }

  function closeClassificationEditor(force = false) {
    if (savingClassification && !force) return;
    setEditingDrug(null);
    setClassificationValue('');
    setClassificationReason('');
  }

  async function saveClassification(event) {
    event.preventDefault();
    if (!selectedShopId || !editingDrug || savingClassification) return;
    if (!classificationValue) {
      setError('Choose POM or OTC before saving this classification.');
      return;
    }

    setSavingClassification(true);
    setError('');
    setMessage('');

    try {
      const nextRequiresPrescription = classificationValue === 'pom';
      const { error: rpcError } = await supabase.rpc('set_shop_drug_prescription_status', {
        p_shop_id: selectedShopId,
        p_drug_id: editingDrug.drug_id,
        p_requires_prescription: nextRequiresPrescription,
        p_reason: classificationReason.trim() || null,
      });

      if (rpcError) throw rpcError;

      setStockRows((previous) => previous.map((row) =>
        row.drug_id === editingDrug.drug_id
          ? { ...row, requires_prescription: nextRequiresPrescription }
          : row
      ));
      setMessage(`${editingDrug.name} classification updated to ${nextRequiresPrescription ? 'POM' : 'OTC'}.`);
      closeClassificationEditor(true);
    } catch (saveError) {
      setError(saveError.message || 'Unable to update the classification.');
    } finally {
      setSavingClassification(false);
    }
  }

  function openTransferDialog(item) {
    const firstTransferableBatch = item.batches?.find((batch) => !isExpiredBatch(batch));
    setTransferDrug(item);
    setTransferBatchId(firstTransferableBatch?.id || '');
    setTransferToShopId(destinationShops[0]?.id || '');
    setTransferQuantity('');
    setError('');
    setMessage('');
  }

  function closeTransferDialog(force = false) {
    if (savingTransfer && !force) return;
    setTransferDrug(null);
    setTransferBatchId('');
    setTransferToShopId('');
    setTransferQuantity('');
  }

  function openWriteOffDialog(item) {
    const expiredBatch = item.batches?.find(isExpiredBatch);
    setWriteOffDrug(item);
    setWriteOffBatchId(expiredBatch?.id || '');
    setWriteOffReason('Expired stock write-off');
    setError('');
    setMessage('');
  }

  function closeWriteOffDialog(force = false) {
    if (savingWriteOff && !force) return;
    setWriteOffDrug(null);
    setWriteOffBatchId('');
    setWriteOffReason('');
  }

  async function refreshCurrentStock() {
    const { data: refreshedBatches, error: refreshError } = await supabase
      .from('batches')
      .select('id, drug_id, supplier_id, batch_number, expiry_date, cost_price, selling_price, quantity_remaining')
      .eq('shop_id', selectedShopId)
      .gt('quantity_remaining', 0)
      .order('expiry_date', { ascending: true });
    if (refreshError) throw refreshError;

    const refreshedWithSuppliers = await attachSupplierNames(refreshedBatches || []);

    const batchesByDrug = {};
    for (const batch of refreshedWithSuppliers) {
      if (!batchesByDrug[batch.drug_id]) batchesByDrug[batch.drug_id] = [];
      batchesByDrug[batch.drug_id].push(batch);
    }

    setStockRows((previous) => previous.map((row) => {
      const batches = batchesByDrug[row.drug_id] || [];
      const expiredBatches = batches.filter(isExpiredBatch);
      const availableBatches = batches.filter((batch) => !isExpiredBatch(batch));
      return {
        ...row,
        batches,
        units_in_stock: batches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0),
        available_units: availableBatches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0),
        expired_units: expiredBatches.reduce((total, batch) => total + Number(batch.quantity_remaining || 0), 0),
        soonest_expiry: availableBatches[0]?.expiry_date || expiredBatches[0]?.expiry_date || null,
        latest_price: availableBatches.reduce((price, batch) => Number(batch.selling_price || 0) || price, 0),
      };
    }));
  }

  async function saveWriteOff(event) {
    event.preventDefault();
    if (!selectedShopId || !writeOffDrug || !selectedWriteOffBatch || savingWriteOff) return;

    setSavingWriteOff(true);
    setError('');
    setMessage('');

    try {
      const { error: writeOffError } = await supabase.rpc('write_off_expired_stock', {
        p_shop_id: selectedShopId,
        p_batch_id: writeOffBatchId,
        p_quantity: Number(selectedWriteOffBatch.quantity_remaining || 0),
        p_reason: writeOffReason.trim() || 'Expired stock write-off',
      });
      if (writeOffError) throw writeOffError;

      setMessage(`${selectedWriteOffBatch.quantity_remaining} unit${Number(selectedWriteOffBatch.quantity_remaining) === 1 ? '' : 's'} of ${writeOffDrug.name} written off as expired.`);
      closeWriteOffDialog(true);
      await refreshCurrentStock();
    } catch (saveError) {
      setError(saveError.message || 'Unable to write off expired stock.');
    } finally {
      setSavingWriteOff(false);
    }
  }

  async function saveTransfer(event) {
    event.preventDefault();
    if (!selectedShopId || !transferDrug || savingTransfer) return;

    const quantity = Number(transferQuantity);
    if (!transferBatchId || !transferToShopId || !Number.isInteger(quantity) || quantity <= 0) {
      setError('Choose a destination shop, batch, and whole-unit quantity before transferring.');
      return;
    }
    if (selectedTransferBatch && quantity > Number(selectedTransferBatch.quantity_remaining || 0)) {
      setError('Transfer quantity cannot be more than the selected batch has in stock.');
      return;
    }

    setSavingTransfer(true);
    setError('');
    setMessage('');

    try {
      const { error: transferError } = await supabase.rpc('transfer_stock_between_shops', {
        p_from_shop_id: selectedShopId,
        p_to_shop_id: transferToShopId,
        p_batch_id: transferBatchId,
        p_quantity: quantity,
      });
      if (transferError) throw transferError;

      setMessage(`${quantity} unit${quantity === 1 ? '' : 's'} of ${transferDrug.name} transferred to ${allShops.find((shop) => shop.id === transferToShopId)?.name || 'the selected shop'}.`);
      closeTransferDialog(true);
      await refreshCurrentStock();
    } catch (saveError) {
      setError(saveError.message || 'Unable to transfer stock.');
    } finally {
      setSavingTransfer(false);
    }
  }

  if (loading) {
    return <div className="page-panel"><p className="muted">Loading stocked drugs...</p></div>;
  }

  if (error && !staff) {
    return <div className="page-panel"><p className="muted">{error}</p></div>;
  }

  return (
    <div className="page-panel">
      <div className="section-header">
        <div>
          <h2>Stocked drugs</h2>
          <p className="muted">{selectedShop ? `Viewing stock for ${selectedShop.name}.` : 'Overview of stocked drugs.'}</p>
        </div>
      </div>

      {staff?.isAdmin && allShops.length > 1 ? (
        <nav className="shop-switcher" aria-label="Switch shop">
          {allShops.map((shop) => (
            <button
              key={shop.id}
              type="button"
              className={shop.id === selectedShopId ? 'active' : ''}
              onClick={() => {
                setSelectedShopId(shop.id);
                onActiveShopChange?.(shop.id);
              }}
            >
              {shop.name}
            </button>
          ))}
        </nav>
      ) : null}

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {loadingStock ? <p className="muted">Loading this shop stock...</p> : null}

      {!loadingStock && stockRows.length === 0 ? (
        <p className="muted">No stocked drugs have been recorded for this shop.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Drug</th>
                <th>Form / strength</th>
                <th>Classification</th>
                <th>Units</th>
                <th>Next expiry</th>
                <th>Batch prices</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {stockRows.map((item) => (
                <>
                  <tr key={item.drug_id}>
                    <td>
                      <strong>{item.name}</strong>
                      {item.generic_name ? <div className="muted small">{item.generic_name}</div> : null}
                    </td>
                    <td>{[item.strength, item.form].filter(Boolean).join(' / ') || '-'}</td>
                    <td><span className={classificationClass(item.requires_prescription)}>{classificationLabel(item.requires_prescription)}</span></td>
                    <td>
                      <strong>{Number(item.available_units ?? item.units_in_stock ?? 0)}</strong>
                      {item.expired_units > 0 ? <div className="muted small critical">Expired: {item.expired_units}</div> : null}
                    </td>
                    <td>
                      {item.soonest_expiry ? new Date(item.soonest_expiry).toLocaleDateString('en-KE') : '-'}
                      {item.expired_units > 0 ? <div className="muted small critical">Expired stock present</div> : null}
                    </td>
                    <td>{priceSummary(item.batches)}</td>
                    <td>
                      <div className="table-actions">
                        <button
                          type="button"
                          className="table-action"
                          onClick={() => setExpandedBatchDrugId((current) => current === item.drug_id ? null : item.drug_id)}
                          disabled={item.batches.length === 0}
                        >
                          {expandedBatchDrugId === item.drug_id ? 'Hide batches' : 'Show batches'}
                        </button>
                        <button type="button" className="table-action" onClick={() => openClassificationEditor(item)}>
                          Edit classification
                        </button>
                        <button
                          type="button"
                          className="table-action"
                          onClick={() => openTransferDialog(item)}
                          disabled={!staff?.isAdmin || item.batches.filter((batch) => !isExpiredBatch(batch)).length === 0 || destinationShops.length === 0}
                        >
                          Transfer
                        </button>
                        <button
                          type="button"
                          className="table-action danger"
                          onClick={() => openWriteOffDialog(item)}
                          disabled={!staff?.isAdmin || Number(item.expired_units || 0) <= 0}
                        >
                          Write off expired
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedBatchDrugId === item.drug_id ? (
                    <tr className="batch-detail-row">
                      <td colSpan="7">
                        <div className="batch-stack">
                          {item.batches.map((batch) => (
                            <div key={batch.id} className={isExpiredBatch(batch) ? 'batch-chip expired' : 'batch-chip'}>
                              <span>Batch {batch.batch_number || 'N/A'}</span>
                              <span>{batch.supplier_name || 'Supplier not recorded'}</span>
                              <span>Exp {batch.expiry_date}</span>
                              <span>{Number(batch.quantity_remaining || 0)} units</span>
                              <strong>{formatCurrency(batch.selling_price)}</strong>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingDrug ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal" onSubmit={saveClassification}>
            <div>
              <h3>Edit classification</h3>
              <p className="muted">
                {editingDrug.name}
                {editingDrug.generic_name ? ` - ${editingDrug.generic_name}` : ''}
              </p>
              <p className="muted small">Current classification: {classificationLabel(editingDrug.requires_prescription)}</p>
            </div>

            <label className="classification-choice">
              <input
                type="radio"
                name="stocked-drug-classification"
                value="pom"
                checked={classificationValue === 'pom'}
                onChange={(event) => setClassificationValue(event.target.value)}
              />
              POM / Prescription Only
            </label>
            <label className="classification-choice">
              <input
                type="radio"
                name="stocked-drug-classification"
                value="otc"
                checked={classificationValue === 'otc'}
                onChange={(event) => setClassificationValue(event.target.value)}
              />
              OTC
            </label>

            <label className="classification-reason">
              Reason
              <textarea
                value={classificationReason}
                onChange={(event) => setClassificationReason(event.target.value)}
                placeholder="e.g. Incorrect classification during receiving"
              />
            </label>

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeClassificationEditor} disabled={savingClassification}>Cancel</button>
              <button type="submit" disabled={savingClassification}>{savingClassification ? 'Saving...' : 'Save classification'}</button>
            </div>
          </form>
        </div>
      ) : null}

      {writeOffDrug ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal" onSubmit={saveWriteOff}>
            <div>
              <h3>Write off expired stock</h3>
              <p className="muted">
                {writeOffDrug.name}
                {writeOffDrug.generic_name ? ` - ${writeOffDrug.generic_name}` : ''}
              </p>
              <p className="muted small">This removes expired units from available inventory and records a write-off movement.</p>
            </div>

            <label className="classification-reason">
              Expired batch
              <select value={writeOffBatchId} onChange={(event) => setWriteOffBatchId(event.target.value)}>
                <option value="">Select expired batch</option>
                {expiredWriteOffBatches.map((batch) => <option key={batch.id} value={batch.id}>{batchOptionLabel(batch)}</option>)}
              </select>
            </label>

            <label className="classification-reason">
              Reason
              <textarea
                value={writeOffReason}
                onChange={(event) => setWriteOffReason(event.target.value)}
                placeholder="e.g. Expired stock removed from shelf"
              />
            </label>

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeWriteOffDialog} disabled={savingWriteOff}>Cancel</button>
              <button type="submit" disabled={savingWriteOff || !writeOffBatchId}>{savingWriteOff ? 'Writing off...' : 'Write off stock'}</button>
            </div>
          </form>
        </div>
      ) : null}

      {transferDrug ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal" onSubmit={saveTransfer}>
            <div>
              <h3>Transfer stock</h3>
              <p className="muted">
                {transferDrug.name}
                {transferDrug.generic_name ? ` - ${transferDrug.generic_name}` : ''}
              </p>
              <p className="muted small">From {selectedShop?.name || 'selected shop'}</p>
            </div>

            <label className="classification-reason">
              Destination shop
              <select value={transferToShopId} onChange={(event) => setTransferToShopId(event.target.value)}>
                <option value="">Select destination</option>
                {destinationShops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
              </select>
            </label>

            <label className="classification-reason">
              Batch
              <select value={transferBatchId} onChange={(event) => setTransferBatchId(event.target.value)}>
                <option value="">Select batch</option>
                {transferableBatches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batchOptionLabel(batch)}
                  </option>
                ))}
              </select>
            </label>

            <label className="classification-reason">
              Quantity to transfer
              <input
                type="number"
                min="1"
                max={selectedTransferBatch?.quantity_remaining || undefined}
                step="1"
                value={transferQuantity}
                onChange={(event) => setTransferQuantity(event.target.value)}
                placeholder={selectedTransferBatch ? `Max ${selectedTransferBatch.quantity_remaining}` : 'Quantity'}
              />
            </label>

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeTransferDialog} disabled={savingTransfer}>Cancel</button>
              <button type="submit" disabled={savingTransfer}>{savingTransfer ? 'Transferring...' : 'Transfer stock'}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}



