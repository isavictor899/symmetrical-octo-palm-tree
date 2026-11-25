import { Fragment, useEffect, useMemo, useState, useRef } from 'react';
import { usePowerSync } from '@powersync/react';
import { useRefreshGate } from '../lib/useRefreshGate';
import { supabase } from '../lib/supabaseClient';
import { canManageStockedDrugs, isAdminRole } from '../lib/roles';
import { todayNairobi } from '../lib/dates';
import { normalizeBarcode } from '../lib/barcode';

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
  return todayNairobi();
}

function isExpiredBatch(batch) {
  return Boolean(batch?.expiry_date && batch.expiry_date < todayString());
}

function batchOptionLabel(batch) {
  return `${batch.batch_number || 'No batch number'} - exp ${batch.expiry_date} - ${batch.quantity_remaining} units`;
}

function formatCountDate(value) {
  if (!value) return 'Never counted';
  return `Counted ${new Date(value).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}`;
}

function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function buildLastCountMap(rows = []) {
  return Object.fromEntries((rows || []).map((row) => [
    row.batch_id,
    { countedAt: row.last_counted_at, variance: row.last_variance },
  ]));
}

function signedUnits(value) {
  return `${value > 0 ? '+' : ''}${value}`;
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

function buildPendingStockMaps(pendingSalesRows = [], pendingReceiptRows = []) {
  const pendingSalesQtyByBatch = {};
  for (const row of pendingSalesRows || []) {
    try {
      const items = JSON.parse(row.items_json || '[]');
      for (const item of items) {
        pendingSalesQtyByBatch[item.batch_id] = (pendingSalesQtyByBatch[item.batch_id] || 0) + Number(item.quantity || 0);
      }
    } catch {
      // Ignore malformed queue rows; do not crash the stock page.
    }
  }

  const pendingReceiptQtyByDrug = {};
  for (const row of pendingReceiptRows || []) {
    if (!row?.drug_id) continue;
    pendingReceiptQtyByDrug[row.drug_id] = (pendingReceiptQtyByDrug[row.drug_id] || 0) + Number(row.quantity || 0);
  }

  return { pendingSalesQtyByBatch, pendingReceiptQtyByDrug };
}

export default function StockedDrugs({ activeShopId, organizationShops = [], onActiveShopChange, dataVersion = 0, isActive = true }) {
  const db = usePowerSync();
  const gate = useRefreshGate(isActive, dataVersion);
  const showingShopRef = useRef(null);
  const [staff, setStaff] = useState(null);
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [stockRows, setStockRows] = useState([]);
  const [equipmentRows, setEquipmentRows] = useState([]);
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
  const [countDrug, setCountDrug] = useState(null);
  const [countEntries, setCountEntries] = useState({});
  const [countError, setCountError] = useState('');
  const [savingCount, setSavingCount] = useState(false);
  const [pendingSalesByBatch, setPendingSalesByBatch] = useState({});
  const [lastCountByBatch, setLastCountByBatch] = useState({});
  const [barcodesByDrug, setBarcodesByDrug] = useState({});
  const [barcodeInput, setBarcodeInput] = useState('');
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [barcodeMessage, setBarcodeMessage] = useState(null); // { ok, text }

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
    if (!selectedShopId || !gate) return undefined;
    let cancelled = false;

    async function loadStock() {
      try {
        if (showingShopRef.current !== selectedShopId) setLoadingStock(true);
        setError('');

        const [shopDrugsResult, batchesResult, equipmentResult, pendingSalesRows, pendingReceiptRows, countsResult] = await Promise.all([
          supabase.from('shop_drugs')
            .select('drug_id, requires_prescription, drugs(name, generic_name, form, strength)')
            .eq('shop_id', selectedShopId)
            .order('drug_id'),
          supabase.from('batches')
            .select('id, drug_id, supplier_id, batch_number, expiry_date, cost_price, selling_price, quantity_remaining')
            .eq('shop_id', selectedShopId)
            .gt('quantity_remaining', 0)
            .order('expiry_date', { ascending: true }),
          supabase.from('shop_equipment_stock')
            .select('equipment_supply_id, quantity_on_hand, average_cost, selling_price, equipment_supplies(name, category, unit)')
            .eq('shop_id', selectedShopId)
            .order('equipment_supply_id'),
          db.getAll('SELECT id, items_json FROM pending_sales WHERE status IS NULL OR status = ?', ['pending']),
          db.getAll('SELECT drug_id, quantity FROM pending_receipts WHERE status IS NULL OR status = ?', ['pending']),
          supabase.from('stock_reconciliation')
            .select('batch_id, last_counted_at, last_variance')
            .eq('shop_id', selectedShopId),
        ]);

        if (shopDrugsResult.error) throw shopDrugsResult.error;
        if (batchesResult.error) throw batchesResult.error;
        if (equipmentResult.error) throw equipmentResult.error;
        showingShopRef.current = selectedShopId;

        const { pendingSalesQtyByBatch, pendingReceiptQtyByDrug } = buildPendingStockMaps(pendingSalesRows, pendingReceiptRows);
        const batchesWithSuppliers = await attachSupplierNames(batchesResult.data || []);

        const batchesByDrug = {};
        for (const batch of batchesWithSuppliers) {
          if (!batchesByDrug[batch.drug_id]) batchesByDrug[batch.drug_id] = [];
          batchesByDrug[batch.drug_id].push(batch);
        }

        const rows = (shopDrugsResult.data || []).map((row) => {
          const batches = batchesByDrug[row.drug_id] || [];
          const pendingReceiptAdjustment = Number(pendingReceiptQtyByDrug[row.drug_id] || 0);
          const baseUnitsInStock = batches.reduce((total, batch) => {
            const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
            return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
          }, 0);
          const expiredBatches = batches.filter(isExpiredBatch);
          const availableBatches = batches.filter((batch) => !isExpiredBatch(batch));
          const expiredUnits = expiredBatches.reduce((total, batch) => {
            const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
            return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
          }, 0);
          const availableUnits = availableBatches.reduce((total, batch) => {
            const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
            return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
          }, 0) + pendingReceiptAdjustment;
          const unitsInStock = baseUnitsInStock + pendingReceiptAdjustment;
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

        if (!cancelled) {
          setStockRows(rows);
          setPendingSalesByBatch(pendingSalesQtyByBatch);
          // Last-count dates are helpful but not essential; never block the page on them.
          setLastCountByBatch(countsResult.error ? {} : buildLastCountMap(countsResult.data));
          setEquipmentRows((equipmentResult.data || []).map((row) => ({
            id: row.equipment_supply_id,
            name: row.equipment_supplies?.name || 'Unknown equipment',
            category: row.equipment_supplies?.category || '',
            unit: row.equipment_supplies?.unit || 'unit',
            quantity: Number(row.quantity_on_hand || 0),
            average_cost: Number(row.average_cost || 0),
            selling_price: Number(row.selling_price || 0),
          })));
        }
      } catch (stockError) {
        if (!cancelled) setError(stockError.message || 'Unable to load this shop stock.');
      } finally {
        if (!cancelled) setLoadingStock(false);
      }
    }

    loadStock();
    return () => { cancelled = true; };
  }, [selectedShopId, gate]);

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
    const pendingSalesRows = await db.getAll('SELECT id, items_json FROM pending_sales WHERE status IS NULL OR status = ?', ['pending']);
    const pendingReceiptRows = await db.getAll('SELECT drug_id, quantity FROM pending_receipts WHERE status IS NULL OR status = ?', ['pending']);
    const { pendingSalesQtyByBatch, pendingReceiptQtyByDrug } = buildPendingStockMaps(pendingSalesRows, pendingReceiptRows);
    setPendingSalesByBatch(pendingSalesQtyByBatch);

    const { data: countRows, error: countRowsError } = await supabase
      .from('stock_reconciliation')
      .select('batch_id, last_counted_at, last_variance')
      .eq('shop_id', selectedShopId);
    if (!countRowsError) setLastCountByBatch(buildLastCountMap(countRows));

    const batchesByDrug = {};
    for (const batch of refreshedWithSuppliers) {
      if (!batchesByDrug[batch.drug_id]) batchesByDrug[batch.drug_id] = [];
      batchesByDrug[batch.drug_id].push(batch);
    }

    setStockRows((previous) => previous.map((row) => {
      const batches = batchesByDrug[row.drug_id] || [];
      const pendingReceiptAdjustment = Number(pendingReceiptQtyByDrug[row.drug_id] || 0);
      const expiredBatches = batches.filter(isExpiredBatch);
      const availableBatches = batches.filter((batch) => !isExpiredBatch(batch));
      return {
        ...row,
        batches,
        units_in_stock: batches.reduce((total, batch) => {
          const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
          return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
        }, 0) + pendingReceiptAdjustment,
        available_units: availableBatches.reduce((total, batch) => {
          const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
          return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
        }, 0) + pendingReceiptAdjustment,
        expired_units: expiredBatches.reduce((total, batch) => {
          const reserved = Number(pendingSalesQtyByBatch[batch.id] || 0);
          return total + Math.max(0, Number(batch.quantity_remaining || 0) - reserved);
        }, 0),
        soonest_expiry: availableBatches[0]?.expiry_date || expiredBatches[0]?.expiry_date || null,
        latest_price: availableBatches.reduce((price, batch) => Number(batch.selling_price || 0) || price, 0),
      };
    }));
  }

  // Barcodes are per organization; RLS returns only this organization's.
  async function loadBarcodes() {
    const { data, error: barcodeError } = await supabase.from('drug_barcodes').select('barcode, drug_id').order('barcode');
    if (barcodeError) return;
    const map = {};
    for (const row of data || []) {
      if (!map[row.drug_id]) map[row.drug_id] = [];
      map[row.drug_id].push(row.barcode);
    }
    setBarcodesByDrug(map);
  }

  useEffect(() => {
    if (gate) loadBarcodes();
  }, [gate]);

  function toggleBatches(drugId) {
    setExpandedBatchDrugId((current) => (current === drugId ? null : drugId));
    setBarcodeInput('');
    setBarcodeMessage(null);
  }

  async function linkBarcode(event, item) {
    event.preventDefault();
    if (barcodeBusy) return;
    const code = normalizeBarcode(barcodeInput);
    if (!code) {
      setBarcodeMessage({ ok: false, text: 'That barcode did not read correctly. Scan it again.' });
      return;
    }
    setBarcodeBusy(true);
    setBarcodeMessage(null);
    const { error: linkError } = await supabase.rpc('link_drug_barcode', { p_barcode: code, p_drug_id: item.drug_id });
    setBarcodeBusy(false);
    if (linkError) {
      setBarcodeMessage({ ok: false, text: linkError.message || 'Could not link the barcode.' });
      return;
    }
    setBarcodeInput('');
    setBarcodeMessage({ ok: true, text: `Barcode ${code} linked to ${item.name}.` });
    await loadBarcodes();
  }

  async function unlinkBarcode(code, item) {
    if (barcodeBusy) return;
    setBarcodeBusy(true);
    setBarcodeMessage(null);
    const { error: unlinkError } = await supabase.rpc('unlink_drug_barcode', { p_barcode: code });
    setBarcodeBusy(false);
    if (unlinkError) {
      setBarcodeMessage({ ok: false, text: unlinkError.message || 'Could not remove the barcode.' });
      return;
    }
    setBarcodeMessage({ ok: true, text: `Barcode ${code} removed from ${item.name}.` });
    await loadBarcodes();
  }

  function openCountDialog(item) {
    // One client ID per batch per dialog: a retry after a network drop is recorded once, not twice.
    const entries = {};
    for (const batch of item.batches || []) {
      entries[batch.id] = { counted: '', reason: '', clientId: newClientId() };
    }
    setCountDrug(item);
    setCountEntries(entries);
    setCountError('');
    setError('');
    setMessage('');
  }

  function closeCountDialog(force = false) {
    if (savingCount && !force) return;
    setCountDrug(null);
    setCountEntries({});
    setCountError('');
  }

  function updateCountEntry(batchId, field, value) {
    setCountEntries((previous) => ({
      ...previous,
      [batchId]: { ...previous[batchId], [field]: value },
    }));
  }

  async function saveStockCount(event) {
    event.preventDefault();
    if (!selectedShopId || !countDrug || savingCount) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setCountError('Stock counts need an internet connection so they are checked against the latest stock. Reconnect and try again.');
      return;
    }

    const toSave = [];
    for (const batch of countDrug.batches || []) {
      const entry = countEntries[batch.id];
      if (!entry || String(entry.counted).trim() === '') continue;

      const label = batch.batch_number || 'with no batch number';
      const counted = Number(entry.counted);
      if (!Number.isInteger(counted) || counted < 0) {
        setCountError(`Enter a whole number of zero or more for batch ${label}.`);
        return;
      }
      if (Number(pendingSalesByBatch[batch.id] || 0) > 0) {
        setCountError(`Batch ${label} has sales waiting to sync. Let them sync before counting it, or the count will be wrong.`);
        return;
      }
      const variance = counted - Number(batch.quantity_remaining || 0);
      if (variance !== 0 && entry.reason.trim().length < 3) {
        setCountError(`Batch ${label} is ${signedUnits(variance)} units off. Give a reason (for example damaged, theft, miscount).`);
        return;
      }
      toSave.push({ batch, counted, variance, entry });
    }

    if (!toSave.length) {
      setCountError('Enter the counted quantity for at least one batch.');
      return;
    }

    setSavingCount(true);
    setCountError('');
    setError('');
    setMessage('');

    let saved = 0;
    let adjusted = 0;
    try {
      for (const { batch, counted, variance, entry } of toSave) {
        const { error: countRpcError } = await supabase.rpc('record_stock_count', {
          p_shop_id: selectedShopId,
          p_batch_id: batch.id,
          p_counted_quantity: counted,
          p_reason: entry.reason.trim() || null,
          p_client_count_id: entry.clientId,
        });
        if (countRpcError) {
          throw new Error(`Batch ${batch.batch_number || 'with no batch number'}: ${countRpcError.message}`);
        }
        saved += 1;
        if (variance !== 0) adjusted += 1;
      }

      const matched = saved - adjusted;
      setMessage(
        `${countDrug.name}: ${saved} batch${saved === 1 ? '' : 'es'} counted. `
        + (adjusted
          ? `${adjusted} adjusted, ${matched} matched the system.`
          : 'Everything matched the system.')
      );
      closeCountDialog(true);
      await refreshCurrentStock();
    } catch (saveError) {
      // Batches saved before the failure keep their client IDs, so pressing Save again will not double-record them.
      setCountError(
        (saveError.message || 'Unable to save the stock count.')
        + (saved ? ` The ${saved} batch${saved === 1 ? '' : 'es'} before it were saved; pressing Save again will not record them twice.` : '')
      );
    } finally {
      setSavingCount(false);
    }
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
                <Fragment key={item.drug_id}>
                  <tr>
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
                          onClick={() => toggleBatches(item.drug_id)}
                        >
                          {expandedBatchDrugId === item.drug_id ? 'Hide details' : 'Batches & barcodes'}
                        </button>
                        <button
                          type="button"
                          className="table-action"
                          onClick={() => openCountDialog(item)}
                          disabled={item.batches.length === 0}
                        >
                          Count stock
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
                          {item.batches.length === 0 ? <span className="muted small">No stock on hand.</span> : null}
                          {item.batches.map((batch) => (
                            <div key={batch.id} className={isExpiredBatch(batch) ? 'batch-chip expired' : 'batch-chip'}>
                              <span>Batch {batch.batch_number || 'N/A'}</span>
                              <span>{batch.supplier_name || 'Supplier not recorded'}</span>
                              <span>Exp {batch.expiry_date}</span>
                              <span>{Number(batch.quantity_remaining || 0)} units</span>
                              <strong>{formatCurrency(batch.selling_price)}</strong>
                              <span className="muted small">
                                {formatCountDate(lastCountByBatch[batch.id]?.countedAt)}
                                {lastCountByBatch[batch.id]?.variance
                                  ? ` (${signedUnits(lastCountByBatch[batch.id].variance)})`
                                  : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="barcode-panel">
                          <div className="barcode-panel-list">
                            <strong>Barcodes</strong>
                            {(barcodesByDrug[item.drug_id] || []).length === 0 ? (
                              <span className="muted small">None yet. Scan a pack to link it.</span>
                            ) : (barcodesByDrug[item.drug_id] || []).map((code) => (
                              <span key={code} className="barcode-chip">
                                <span className="tnum">{code}</span>
                                <button type="button" onClick={() => unlinkBarcode(code, item)} disabled={barcodeBusy} aria-label={`Remove barcode ${code}`}>×</button>
                              </span>
                            ))}
                          </div>
                          <form className="barcode-panel-form" onSubmit={(event) => linkBarcode(event, item)}>
                            <input
                              value={barcodeInput}
                              onChange={(event) => setBarcodeInput(event.target.value)}
                              placeholder="Scan or type a barcode"
                              aria-label={`Barcode to link to ${item.name}`}
                              inputMode="numeric"
                              autoComplete="off"
                            />
                            <button type="submit" className="table-action" disabled={barcodeBusy || !barcodeInput.trim()}>
                              {barcodeBusy ? 'Saving…' : 'Link barcode'}
                            </button>
                          </form>
                          {barcodeMessage ? (
                            <div className={barcodeMessage.ok ? 'muted small' : 'muted small critical'} role="status">{barcodeMessage.text}</div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="equipment-stock-section" aria-labelledby="equipment-stock-title">
        <h3 id="equipment-stock-title">Medical equipment and supplies</h3>
        {!loadingStock && equipmentRows.length === 0 ? (
          <p className="muted">No equipment stock has been recorded for this shop.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Equipment / supply</th><th>Category</th><th>On hand</th><th>Unit</th><th>Average cost</th><th>Selling price</th></tr></thead>
              <tbody>{equipmentRows.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.name}</strong></td>
                  <td>{item.category || '—'}</td>
                  <td><strong>{item.quantity}</strong></td>
                  <td>{item.unit}</td>
                  <td>{formatCurrency(item.average_cost)}</td>
                  <td>{formatCurrency(item.selling_price)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

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
              <button type="button" className="secondary-button" onClick={() => closeClassificationEditor()} disabled={savingClassification}>Cancel</button>
              <button type="submit" disabled={savingClassification}>{savingClassification ? 'Saving...' : 'Save classification'}</button>
            </div>
          </form>
        </div>
      ) : null}

      {countDrug ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal stock-count-modal" onSubmit={saveStockCount}>
            <div>
              <h3>Count stock</h3>
              <p className="muted">
                {countDrug.name}
                {countDrug.generic_name ? ` - ${countDrug.generic_name}` : ''}
              </p>
              <p className="muted small">
                Count what is physically on the shelf for each batch. Leave a batch blank to skip it.
                Any difference needs a reason and is recorded with your name.
              </p>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>System</th>
                    <th>Counted</th>
                    <th>Difference</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(countDrug.batches || []).map((batch) => {
                    const entry = countEntries[batch.id] || { counted: '', reason: '' };
                    const systemQuantity = Number(batch.quantity_remaining || 0);
                    const hasCount = String(entry.counted).trim() !== '';
                    const counted = Number(entry.counted);
                    const variance = hasCount && Number.isInteger(counted) ? counted - systemQuantity : null;
                    const pendingSales = Number(pendingSalesByBatch[batch.id] || 0);

                    return (
                      <tr key={batch.id}>
                        <td>
                          <strong>{batch.batch_number || 'N/A'}</strong>
                          <div className="muted small">Exp {batch.expiry_date}{isExpiredBatch(batch) ? ' (expired)' : ''}</div>
                          {pendingSales > 0 ? (
                            <div className="muted small critical">{pendingSales} unit(s) in unsynced sales</div>
                          ) : null}
                        </td>
                        <td>{systemQuantity}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            value={entry.counted}
                            onChange={(event) => updateCountEntry(batch.id, 'counted', event.target.value)}
                            disabled={savingCount || pendingSales > 0}
                            aria-label={`Counted quantity for batch ${batch.batch_number || 'N/A'}`}
                          />
                        </td>
                        <td>
                          {variance === null
                            ? '-'
                            : variance === 0
                              ? 'Matches'
                              : <strong className="critical">{signedUnits(variance)}</strong>}
                        </td>
                        <td>
                          <input
                            type="text"
                            value={entry.reason}
                            onChange={(event) => updateCountEntry(batch.id, 'reason', event.target.value)}
                            disabled={savingCount || !variance}
                            placeholder={variance ? 'e.g. damaged, miscount' : ''}
                            aria-label={`Reason for difference on batch ${batch.batch_number || 'N/A'}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {countError ? <p className="error">{countError}</p> : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => closeCountDialog()} disabled={savingCount}>Cancel</button>
              <button type="submit" disabled={savingCount}>{savingCount ? 'Saving count...' : 'Save count'}</button>
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
              <button type="button" className="secondary-button" onClick={() => closeWriteOffDialog()} disabled={savingWriteOff}>Cancel</button>
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
              <button type="button" className="secondary-button" onClick={() => closeTransferDialog()} disabled={savingTransfer}>Cancel</button>
              <button type="submit" disabled={savingTransfer}>{savingTransfer ? 'Transferring...' : 'Transfer stock'}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}