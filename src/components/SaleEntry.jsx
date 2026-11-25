import React, { useState, useEffect, useMemo, useRef } from 'react';
import { usePowerSync, useQuery, useStatus } from '@powersync/react';
import { supabase } from '../lib/supabaseClient';
import { flushAll, sendSaleToReview } from '../lib/powersync/flush';
import { useStaff } from '../lib/useStaff';
import { todayNairobi } from '../lib/dates';
import { printReceipt, receiptNumberFor, rememberReceipt } from '../lib/receipt';
import ReceiptReprint from './ReceiptReprint';
import { looksLikeBarcode, normalizeBarcode, scanBeep, useBarcodeScanner } from '../lib/barcode';
import { canReceiveStock } from '../lib/roles';
import './SaleEntry.css';

function formatKes(n) {
  return `KES ${n.toFixed(2)}`;
}

// First-Expiry-First-Out: among in-stock, non-expired batches, pick the
// one expiring soonest. This is a UX convenience only — sell_stock enforces
// the real expiry check server-side regardless of what this picks.
function pickFefoBatch(drug) {
  const today = todayNairobi();
  const sellable = drug.batches.filter((b) => b.available > 0 && b.expiry_date >= today);
  if (sellable.length === 0) return null;
  return [...sellable].sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date))[0];
}

// For a scan: the soonest-expiring sellable batch that still has stock left
// after what is already in the cart, so repeated scans move on to the next batch.
function pickBatchForScan(drug, cart) {
  const today = todayNairobi();
  const inCart = (batchId) => cart
    .filter((line) => line.kind !== 'equipment' && line.batch.id === batchId)
    .reduce((sum, line) => sum + line.qty, 0);
  return [...drug.batches]
    .filter((batch) => batch.expiry_date >= today && batch.available - inCart(batch.id) > 0)
    .sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date))[0] || null;
}

export default function SaleEntry({ activeShopId, activeShopName, activeShop = null, staffName = '', isActive = true, mode = 'sale', initialSearch = '', subscription = null }) {
  // Expired past the grace period, or suspended by Enora Labs: the server
  // refuses new sales, so the till says so instead of queueing them.
  const salesBlocked = subscription?.state === 'read_only' || subscription?.state === 'suspended';
  const pageMode = mode;
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
    setReturnSearch('');
    setReturnRows([]);
    setSelectedReturnItem(null);
    setReturnRequestId(null);
    setReturnMessage('');
    setReturnError('');
    setUnknownBarcode(null);
    setScanNotice(null);
  }, [effectiveShopId]);

  useEffect(() => () => window.clearTimeout(scanNoticeTimerRef.current), []);

  // Reactive local query: joins batches + drugs from the local SQLite
  // database, scoped to this shop. Automatically re-runs whenever the
  // underlying local data changes (a sync pulling in fresh stock, etc.) —
  // no manual refetching needed.
  // When staffInfo is not yet resolved, pass a harmless placeholder query
  // instead of null — some versions of the PowerSync hook expect a valid
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

  // Every sale still sitting in the local queue, unsynced — used for two
  // things: the "waiting to sync" count, and (below) figuring out how much
  // of each batch's synced stock is already spoken for by a sale that
  // hasn't reached the server yet. Without this, a second offline sale of
  // the same batch has no way to know the first one already happened.
  const { data: pendingItemsRows } = useQuery(isActive ? 'SELECT id, shop_id, items_json, status, last_error FROM pending_sales' : 'SELECT 1 WHERE 0');
  // A device can retain queued sales after an administrator switches shops.
  // Every sale status, error and reserved batch quantity shown here must belong
  // to the shop currently open at the till.
  const shopPendingSales = (pendingItemsRows || []).filter((row) => row.shop_id === effectiveShopId);
  const waitingSales = shopPendingSales.filter((row) => !row.status || row.status === 'pending');
  const failedSales = shopPendingSales.filter((row) => row.status === 'failed');
  const pendingCount = waitingSales.length;

  const [recentSoldQtyByBatch, setRecentSoldQtyByBatch] = useState({});

  const pendingQtyByBatch = useMemo(() => {
    const map = {};
    for (const row of waitingSales) {
      try {
        const items = JSON.parse(row.items_json);
        for (const item of items) {
          if (!item.batch_id) continue;
          map[item.batch_id] = (map[item.batch_id] || 0) + Number(item.quantity);
        }
      } catch {
        // A malformed row shouldn't take down the whole search screen.
      }
    }
    return map;
  }, [waitingSales]);

  const reservedQtyByBatch = useMemo(() => {
    const map = { ...pendingQtyByBatch };
    for (const [batchId, sale] of Object.entries(recentSoldQtyByBatch)) {
      const recentQty = Number(sale?.quantity || 0);
      if (!recentQty) continue;
      const pendingQty = Number(map[batchId] || 0);
      map[batchId] = Math.max(pendingQty, recentQty);
    }
    return map;
  }, [pendingQtyByBatch, recentSoldQtyByBatch]);

  const drugs = useMemo(() => {
    const byDrug = {};
    for (const b of batchRows || []) {
      const recentSale = recentSoldQtyByBatch[b.id];
      const recentSold = recentSale && Number(b.quantity_remaining || 0) >= Number(recentSale.originalQuantity || 0)
        ? Number(recentSale.quantity || 0)
        : 0;
      const reservedQty = Math.max(
        Number(pendingQtyByBatch[b.id] || 0),
        Number(reservedQtyByBatch[b.id] || 0),
        Number(recentSold || 0)
      );
      const available = Math.max(0, Number(b.quantity_remaining || 0) - reservedQty);
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
  }, [batchRows, pendingQtyByBatch, recentSoldQtyByBatch, reservedQtyByBatch]);

  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState([]);
  const [equipmentStock, setEquipmentStock] = useState([]);
  const [remoteSearchLoading, setRemoteSearchLoading] = useState(false);
  const [cart, setCart] = useState([]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [prescriptionReference, setPrescriptionReference] = useState('');
  const [prescriberName, setPrescriberName] = useState('');
  const [prescriptionDate, setPrescriptionDate] = useState('');
  const [status, setStatus] = useState('idle'); // idle | submitting | done
  const [checkoutError, setCheckoutError] = useState(null);
  const [lastReceipt, setLastReceipt] = useState(null);
  const [showReprint, setShowReprint] = useState(false);
  const [printNotice, setPrintNotice] = useState('');
  const [heldNotice, setHeldNotice] = useState('');
  const [sendingToReview, setSendingToReview] = useState(null);

  // Rejected offline sales moved to the admin's Sales review queue.
  useEffect(() => {
    function onHeld(event) {
      const count = Number(event.detail?.count || 0);
      if (count > 0) {
        setHeldNotice(`${count} older sale${count === 1 ? ' was' : 's were'} rejected by the server and sent to an administrator for review. Nothing is lost.`);
      }
    }
    window.addEventListener('pharmacy-pos:sales-held', onHeld);
    return () => window.removeEventListener('pharmacy-pos:sales-held', onHeld);
  }, []);
  const [scanNotice, setScanNotice] = useState(null); // { ok, text }
  const [unknownBarcode, setUnknownBarcode] = useState(null);
  const [linkSearch, setLinkSearch] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  // Barcodes resolved or linked during this session, so a second scan is
  // instant even before the new link has synced to this device.
  const scannedBarcodesRef = useRef(new Map());
  const scanNoticeTimerRef = useRef(null);
  const [returnSearch, setReturnSearch] = useState('');
  const [returnRows, setReturnRows] = useState([]);
  const [selectedReturnItem, setSelectedReturnItem] = useState(null);
  const [returnQty, setReturnQty] = useState(1);
  const [refundMethod, setRefundMethod] = useState('cash');
  const [returnReason, setReturnReason] = useState('Customer return');
  const [returnRequestId, setReturnRequestId] = useState(null);
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnSaving, setReturnSaving] = useState(false);
  const [returnError, setReturnError] = useState('');
  const [returnMessage, setReturnMessage] = useState('');

  useEffect(() => {
    if (pageMode === 'sale') setQuery(initialSearch || '');
  }, [effectiveShopId, initialSearch, pageMode]);
  // Shop details for the receipt header. Falls back to just the name if the
  // full shop record has not loaded yet (e.g. offline at start-up).
  const receiptShop = activeShop || { name: activeShopName };
  const cartNeedsPrescription = cart.some((line) => line.requiresPrescription === true);
  const cartHasUnclassifiedDrug = cart.some((line) => line.requiresPrescription === null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const today = todayNairobi();
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
        const today = todayNairobi();
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

  useEffect(() => {
    if (!isActive || !effectiveShopId || !syncStatus.connected) {
      setEquipmentStock([]);
      return undefined;
    }
    let cancelled = false;
    supabase.from('shop_equipment_stock')
      .select('equipment_supply_id, quantity_on_hand, selling_price, equipment_supplies(name, category, unit)')
      .eq('shop_id', effectiveShopId).gt('quantity_on_hand', 0)
      .then(({ data, error }) => {
        if (error) throw error;
        if (!cancelled) setEquipmentStock((data || []).map((row) => ({
          id: row.equipment_supply_id,
          name: row.equipment_supplies?.name || 'Equipment',
          category: row.equipment_supplies?.category || '',
          unit: row.equipment_supplies?.unit || 'unit',
          available: Number(row.quantity_on_hand || 0),
          selling_price: Number(row.selling_price || 0),
        })));
      }).catch((searchError) => {
        console.warn('[SaleEntry] Equipment stock search failed:', searchError);
        if (!cancelled) setEquipmentStock([]);
      });
    return () => { cancelled = true; };
  }, [effectiveShopId, syncStatus.connected, isActive]);

  const equipmentResults = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return equipmentStock.filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(term) && item.selling_price > 0);
  }, [equipmentStock, query]);

  const lineKey = (line) => line.kind === 'equipment' ? `equipment:${line.item.id}` : `drug:${line.batch.id}`;

  useEffect(() => {
    if (!isActive || pageMode !== 'return' || !effectiveShopId || !syncStatus.connected) return undefined;
    let cancelled = false;
    async function loadReturnItems() {
      setReturnLoading(true);
      setReturnError('');
      try {
        const { data: sales, error: salesError } = await supabase.from('sales')
          .select('id, sold_at, payment_method').eq('shop_id', effectiveShopId)
          .order('sold_at', { ascending: false }).limit(200);
        if (salesError) throw salesError;
        const saleIds = (sales || []).map((sale) => sale.id);
        if (!saleIds.length) { if (!cancelled) setReturnRows([]); return; }
        const { data: items, error: itemsError } = await supabase.from('sale_items')
          .select('id, sale_id, batch_id, quantity, unit_price, drugs(name), batches(batch_number, expiry_date)')
          .in('sale_id', saleIds);
        if (itemsError) throw itemsError;
        const itemIds = (items || []).map((item) => item.id);
        let returnedRows = [];
        if (itemIds.length) {
          const { data, error } = await supabase.from('sales_return_items')
            .select('original_sale_item_id, quantity').in('original_sale_item_id', itemIds);
          if (error) throw error;
          returnedRows = data || [];
        }
        const returnedByItem = {};
        for (const returned of returnedRows) returnedByItem[returned.original_sale_item_id] = (returnedByItem[returned.original_sale_item_id] || 0) + Number(returned.quantity || 0);
        const saleById = Object.fromEntries((sales || []).map((sale) => [sale.id, sale]));
        const mapped = (items || []).map((item) => ({
          ...item,
          sale: saleById[item.sale_id],
          returned: Number(returnedByItem[item.id] || 0),
          returnable: Math.max(0, Number(item.quantity || 0) - Number(returnedByItem[item.id] || 0)),
        })).filter((item) => item.returnable > 0);
        if (!cancelled) setReturnRows(mapped);
      } catch (loadError) {
        if (!cancelled) setReturnError(loadError.message || 'Could not load recent sales for returns.');
      } finally {
        if (!cancelled) setReturnLoading(false);
      }
    }
    loadReturnItems();
    return () => { cancelled = true; };
  }, [effectiveShopId, isActive, pageMode, syncStatus.connected]);

  const matchedReturnItems = useMemo(() => {
    const term = returnSearch.trim().toLowerCase();
    if (term.length < 2) return [];
    return returnRows.filter((item) => (item.drugs?.name || '').toLowerCase().includes(term)
      || item.sale?.id?.toLowerCase().includes(term));
  }, [returnRows, returnSearch]);

  async function processReturn() {
    if (!selectedReturnItem || !syncStatus.connected || returnSaving) return;
    setReturnSaving(true); setReturnError(''); setReturnMessage('');
    try {
      const clientReturnId = returnRequestId || crypto.randomUUID();
      setReturnRequestId(clientReturnId);
      const { data, error } = await supabase.rpc('return_sold_drug', {
        p_sale_item_id: selectedReturnItem.id,
        p_quantity: Number(returnQty),
        p_refund_method: refundMethod,
        p_reason: returnReason.trim() || 'Customer return',
        p_client_return_id: clientReturnId,
      });
      if (error) throw error;
      const returnId = Array.isArray(data) ? data[0] : data;
      const refunded = Number(returnQty) * Number(selectedReturnItem.unit_price || 0);
      setReturnMessage(`Return recorded (${returnId}). ${returnQty} unit(s), ${formatKes(refunded)} refund, returned to stock.`);
      setSelectedReturnItem(null);
      setReturnRequestId(null);
      setReturnQty(1);
      setReturnSearch('');
      window.dispatchEvent(new CustomEvent('pharmacy-pos:data-changed', { detail: { type: 'return', shopId: effectiveShopId } }));
      const { data: returned, error: returnedError } = await supabase.from('sales_return_items')
        .select('original_sale_item_id, quantity').eq('original_sale_item_id', selectedReturnItem.id);
      if (!returnedError) {
        const returnedQty = (returned || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        setReturnRows((rows) => rows.map((row) => row.id === selectedReturnItem.id
          ? { ...row, returned: returnedQty, returnable: Math.max(0, Number(row.quantity) - returnedQty) }
          : row).filter((row) => row.returnable > 0));
      }
    } catch (error) {
      setReturnError(error.message || 'Could not record the return.');
    } finally {
      setReturnSaving(false);
    }
  }

  function addToCart(drug, batch) {
    if (!batch || batch.available <= 0 || batch.expiry_date < todayNairobi()) return;
    setCart((prev) => {
      const existing = prev.find((line) => line.kind !== 'equipment' && line.batch.id === batch.id);
      if (existing) {
        if (existing.qty >= batch.available) return prev;
        return prev.map((line) =>
          line.kind !== 'equipment' && line.batch.id === batch.id ? { ...line, qty: line.qty + 1 } : line
        );
      }
      return [...prev, {
        kind: 'drug',
        drugId: drug.id,
        drugName: drug.name,
        batch,
        qty: 1,
        discountAmount: 0,
        requiresPrescription: drug.requiresPrescription,
      }];
    });
    setQuery('');
  }

  function showScanNotice(ok, text) {
    window.clearTimeout(scanNoticeTimerRef.current);
    setScanNotice({ ok, text });
    scanNoticeTimerRef.current = window.setTimeout(() => setScanNotice(null), ok ? 2500 : 6000);
  }

  // Adds the scanned drug to the cart using the soonest-expiring batch.
  async function addScannedDrug(drugId, verb = 'Added') {
    const drug = drugs.find((item) => item.id === drugId);
    if (!drug) {
      let name = 'This product';
      try {
        const rows = await db.getAll('SELECT name FROM drugs WHERE id = ?', [drugId]);
        if (rows[0]?.name) name = rows[0].name;
      } catch {
        // Name is only for the message.
      }
      showScanNotice(false, `${name} is not in stock at this shop.`);
      scanBeep(false);
      return;
    }
    const batch = pickBatchForScan(drug, cart);
    if (!batch) {
      showScanNotice(false, `${drug.name}: no more sellable stock (sold out or expired).`);
      scanBeep(false);
      return;
    }
    addToCart(drug, batch);
    showScanNotice(true, `${verb} ${drug.name} (exp ${batch.expiry_date})`);
    scanBeep(true);
  }

  async function handleScan(raw) {
    if (pageMode !== 'sale' || status === 'submitting') return;
    const code = normalizeBarcode(raw);
    if (!code) {
      showScanNotice(false, 'That barcode did not read correctly. Scan it again.');
      scanBeep(false);
      return;
    }

    let drugId = scannedBarcodesRef.current.get(code) || null;
    if (!drugId) {
      try {
        const rows = await db.getAll('SELECT drug_id FROM drug_barcodes WHERE barcode = ? LIMIT 1', [code]);
        drugId = rows[0]?.drug_id || null;
      } catch {
        // Local barcode list not available yet; fall back to the server below.
      }
    }
    if (!drugId && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      const { data } = await supabase.from('drug_barcodes').select('drug_id').eq('barcode', code).maybeSingle();
      drugId = data?.drug_id || null;
    }

    if (!drugId) {
      setUnknownBarcode(code);
      setLinkSearch('');
      setLinkError('');
      scanBeep(false);
      return;
    }
    scannedBarcodesRef.current.set(code, drugId);
    setUnknownBarcode(null);
    await addScannedDrug(drugId);
  }

  async function linkUnknownBarcode(drug) {
    if (!unknownBarcode || linking) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setLinkError('Linking a barcode needs an internet connection. You can still add the drug by searching for it.');
      return;
    }
    setLinking(true);
    setLinkError('');
    const { error } = await supabase.rpc('link_drug_barcode', { p_barcode: unknownBarcode, p_drug_id: drug.id });
    setLinking(false);
    if (error) {
      setLinkError(error.message || 'Could not link this barcode.');
      return;
    }
    scannedBarcodesRef.current.set(unknownBarcode, drug.id);
    setUnknownBarcode(null);
    await addScannedDrug(drug.id, 'Barcode linked. Added');
  }

  useBarcodeScanner({ enabled: isActive && pageMode === 'sale', onScan: handleScan });

  const canLinkBarcodes = canReceiveStock(staffInfo?.role);
  const linkCandidates = useMemo(() => {
    const term = linkSearch.trim().toLowerCase();
    if (!unknownBarcode) return [];
    return drugs
      .filter((drug) => !term
        || drug.name?.toLowerCase().includes(term)
        || drug.generic_name?.toLowerCase().includes(term))
      .slice(0, 8);
  }, [drugs, linkSearch, unknownBarcode]);

  function addEquipmentToCart(item) {
    if (!syncStatus.connected || item.available <= 0 || item.selling_price <= 0) return;
    setCart((prev) => {
      const existing = prev.find((line) => line.kind === 'equipment' && line.item.id === item.id);
      if (existing) {
        if (existing.qty >= item.available) return prev;
        return prev.map((line) => line.kind === 'equipment' && line.item.id === item.id ? { ...line, qty: line.qty + 1 } : line);
      }
      return [...prev, { kind: 'equipment', item, drugName: item.name, qty: 1, requiresPrescription: false }];
    });
    setQuery('');
  }

  function updateQty(key, delta) {
    setCart((prev) =>
      prev.map((line) =>
        lineKey(line) === key
          ? { ...line, qty: Math.max(1, Math.min(line.qty + delta, line.kind === 'equipment' ? line.item.available : line.batch.available)) }
          : line
      )
    );
  }

  function removeLine(key) {
    setCart((prev) => prev.filter((line) => lineKey(line) !== key));
  }

  function cancelCurrentSale() {
    setCart([]);
    setPrescriptionReference('');
    setPrescriberName('');
    setPrescriptionDate('');
    setCheckoutError(null);
    setLastReceipt(null);
    setStatus('idle');
  }

  async function cancelFailedSale(saleId) {
    try {
      // A failed queued sale was rejected before the server recorded it, so it
      // is safe to remove only this local failed outbox item. Pending sales are
      // deliberately not cancellable here because they may still sync.
      await db.execute("DELETE FROM pending_sales WHERE id = ? AND status = 'failed'", [saleId]);
    } catch {
      setCheckoutError('Could not cancel the failed sale on this device. Please try again.');
    }
  }

  // For a rejected sale whose medicine was already handed over: an admin
  // approves or voids it from any device.
  async function sendFailedSaleToAdmin(row) {
    setSendingToReview(row.id);
    try {
      await sendSaleToReview(db, row);
      setHeldNotice('Sent to an administrator for review.');
    } catch (error) {
      setCheckoutError(navigator.onLine === false
        ? 'You are offline. Connect to the internet to send this sale to an administrator.'
        : `Could not send the sale for review: ${error.message || 'unknown error'}`);
    } finally {
      setSendingToReview(null);
    }
  }

  const baseLinePrice = (line) => line.kind === 'equipment' ? line.item.selling_price : line.batch.selling_price;
  const lineDiscount = (line) => line.kind === 'equipment'
    ? 0
    : Math.min(Math.max(Number(line.discountAmount || 0), 0), Number(line.batch.selling_price || 0));
  const linePrice = (line) => line.kind === 'equipment'
    ? Number(line.item.selling_price)
    : Math.round((Number(line.batch.selling_price) - lineDiscount(line)) * 100) / 100;
  const total = cart.reduce((sum, line) => sum + line.qty * linePrice(line), 0);

  // Writes the sale into the LOCAL pending_sales queue — works offline.
  // The connector picks it up and calls sell_stock_and_equipment once
  // there's connectivity; nothing here calls Supabase directly.
  async function checkout() {
    if (cart.length === 0 || !staffInfo || !effectiveShopId) return;
    if (salesBlocked) {
      setCheckoutError('New sales are paused because this pharmacy\'s subscription has expired. Ask your administrator to renew with Enora Labs.');
      return;
    }
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
      const soldAt = new Date().toISOString();
      const items = cart.map((line) => ({
        item_type: line.kind,
        quantity: line.qty,
        unit_price: linePrice(line),
        ...(line.kind === 'equipment'
          ? { equipment_supply_id: line.item.id }
          : {
            drug_id: line.drugId,
            batch_id: line.batch.id,
            original_unit_price: baseLinePrice(line),
            // Fixed money amount off each unit, e.g. 50.00 means KES 50 off.
            discount_amount: lineDiscount(line),
          }),
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
          soldAt, 'pending', null,
        ]
      );
      await flushAll(db);
      const remaining = await db.getAll('SELECT status, last_error FROM pending_sales WHERE id = ?', [localId]);
      const queueRow = remaining[0] || null;

      // The receipt is built from the cart, so it can be printed even offline.
      // Its number is the sale's own ID, which the server keeps after sync.
      const receipt = {
        receiptNo: receiptNumberFor(localId),
        time: soldAt,
        paymentMethod,
        servedBy: staffName,
        total,
        items: cart.map((line) => ({
          name: line.drugName,
          qty: line.qty,
          unitPrice: linePrice(line),
          originalUnitPrice: Number(baseLinePrice(line)),
        })),
        prescription: cartNeedsPrescription
          ? { reference: prescriptionReference.trim(), prescriber: prescriberName.trim(), date: prescriptionDate }
          : null,
        pendingSync: Boolean(queueRow && queueRow.status !== 'failed'),
      };
      if (queueRow?.status !== 'failed') rememberReceipt(effectiveShopId, receipt);

      if (!queueRow) {
        const soldByBatch = items.reduce((acc, item) => {
          if (!item.batch_id) return acc;
          const cartLine = cart.find((line) => line.kind === 'drug' && line.batch.id === item.batch_id);
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

      setLastReceipt({ items: cart, total, paymentMethod, time: new Date(soldAt), queueRow, receipt });
      setPrintNotice('');
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
          <h1>{pageMode === 'sale' ? 'New sale' : 'Sales returns'}</h1>
          {activeShopName && <p>{pageMode === 'sale' ? 'Selling from' : 'Processing returns for'} {activeShopName}</p>}
        </div>
        <div className="pos-header-actions">
          {pageMode === 'sale' && effectiveShopId ? (
            <button type="button" className="button secondary" onClick={() => setShowReprint(true)}>Reprint receipt</button>
          ) : null}
          <button type="button" className="button secondary" onClick={() => retryFetchStaff()}>{retrying ? 'Retrying…' : 'Retry staff sync'}</button>
        </div>
      </header>

      {showReprint ? (
        <ReceiptReprint
          shopId={effectiveShopId}
          shop={receiptShop}
          online={typeof navigator === 'undefined' || navigator.onLine !== false}
          onClose={() => setShowReprint(false)}
        />
      ) : null}

      {syncedNotice && <div className="notice success">Staff record synced locally</div>}
      {heldNotice && <div className="notice success held-notice" role="status">
        <span>{heldNotice}</span>
        <button type="button" onClick={() => setHeldNotice('')}>Dismiss</button>
      </div>}
      {failedSales.length > 0 && <section aria-label="Sales needing attention" className="notice danger">
        <strong>{failedSales.length} sale{failedSales.length === 1 ? '' : 's'} need attention</strong>
        <span className="notice-help">Fix and retry if the customer is still here. If the medicine was already handed over, send it to an administrator. Unresolved sales go to the administrator automatically after 15 minutes.</span>
        {failedSales.map((row) => <div key={row.id} className="notice-row">
          <span>{row.last_error || 'The server rejected this sale.'}</span>
          <span className="notice-row-actions">
            <button type="button" onClick={async () => { await db.execute("UPDATE pending_sales SET status = 'pending', last_error = NULL WHERE id = ?", [row.id]); flushAll(db); }}>Retry</button>
            <button type="button" disabled={sendingToReview === row.id} onClick={() => sendFailedSaleToAdmin(row)}>{sendingToReview === row.id ? 'Sending…' : 'Send to admin'}</button>
            <button type="button" className="notice-cancel" onClick={() => cancelFailedSale(row.id)}>Cancel (not handed over)</button>
          </span>
        </div>)}
      </section>}

      <div className="pos-sale-grid">
        <section className="product-pane" aria-label="Product search">
          {pageMode === 'sale' ? <>
          <input
            className="search-input"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // A scanner typing into the search box ends with Enter.
              if (e.key === 'Enter' && looksLikeBarcode(query)) {
                e.preventDefault();
                const code = query.trim();
                setQuery('');
                handleScan(code);
              }
            }}
            placeholder="Search or scan a barcode…"
          />

          {scanNotice ? (
            <div className={scanNotice.ok ? 'scan-notice ok' : 'scan-notice error'} role="status">{scanNotice.text}</div>
          ) : null}

          {unknownBarcode ? (
            <section className="unknown-barcode" aria-label="Unknown barcode">
              <div className="unknown-barcode-head">
                <div>
                  <strong>New barcode: <span className="tnum">{unknownBarcode}</span></strong>
                  <div className="muted small">
                    {canLinkBarcodes
                      ? 'Choose the drug this pack is. Next time it scans straight into the cart.'
                      : 'This barcode is not linked to a drug yet. Ask a pharmacist or administrator to link it, or search for the drug by name.'}
                  </div>
                </div>
                <button type="button" className="table-action" onClick={() => setUnknownBarcode(null)} disabled={linking}>Dismiss</button>
              </div>
              {canLinkBarcodes ? (
                <>
                  <input
                    className="search-input"
                    value={linkSearch}
                    onChange={(e) => setLinkSearch(e.target.value)}
                    placeholder="Find the drug in this shop's stock…"
                    aria-label="Find the drug to link"
                  />
                  {linkError ? <div className="inline-error">{linkError}</div> : null}
                  <div className="unknown-barcode-list">
                    {linkCandidates.map((drug) => (
                      <button key={drug.id} type="button" className="product-row" onClick={() => linkUnknownBarcode(drug)} disabled={linking}>
                        <div>
                          <div className="product-title">{drug.name}</div>
                          <div className="product-meta">{drug.generic_name || 'No generic name'}</div>
                        </div>
                        <div className="product-price"><small>{linking ? 'Linking…' : 'Link and add'}</small></div>
                      </button>
                    ))}
                    {linkCandidates.length === 0 ? <div className="empty-state">No stocked drug matches. Receive the drug first, then link its barcode.</div> : null}
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {query.trim() && results.length === 0 && equipmentResults.length === 0 && remoteSearchLoading && (
            <div className="empty-state">Searching stock while the local catalogue syncs…</div>
          )}

          {query.trim() && visibleResults.length === 0 && equipmentResults.length === 0 && !remoteSearchLoading && (
            <div className="empty-state">No stocked drug batch or priced equipment matches "{query}" for this shop yet.</div>
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

          {equipmentResults.map((item) => (
            <button key={`equipment-${item.id}`} onClick={() => addEquipmentToCart(item)} disabled={!syncStatus.connected || item.available <= 0} className="product-row">
              <div>
                <div className="product-title">{item.name}<span className="mini-badge">Equipment</span></div>
                <div className="product-meta">{item.category || 'Medical equipment'} · {item.available} {item.unit} available</div>
              </div>
              <div className="product-price tnum">{formatKes(item.selling_price)}<small>Per {item.unit}</small></div>
            </button>
          ))}

          {!query.trim() && (
            <div className="empty-state">
              Start typing to find a drug or medical equipment. Drug batches and equipment prices appear as separate stock lines.
            </div>
          )}
          </> : <div className="return-workspace">
            <h2>Return a sold drug</h2>
            <p className="muted">Search the latest sales, select the original sale line, then enter the quantity to return.</p>
            {!syncStatus.connected && <p className="inline-error">Returns require an internet connection so stock and refund records update together.</p>}
            <input className="search-input" value={returnSearch} onChange={(event) => { setReturnSearch(event.target.value); setSelectedReturnItem(null); }} placeholder="Search by drug name or sale ID…" disabled={!syncStatus.connected} />
            {returnLoading && <p className="muted">Loading recent sale items…</p>}
            {returnSearch.trim().length < 2 && <p className="empty-state">Enter at least two characters to find a sale line.</p>}
            {matchedReturnItems.map((item) => (
              <button type="button" key={item.id} className={`product-row ${selectedReturnItem?.id === item.id ? 'selected' : ''}`} onClick={() => { setSelectedReturnItem(item); setReturnQty(1); setReturnRequestId(crypto.randomUUID()); }}>
                <div><div className="product-title">{item.drugs?.name || 'Drug'}<span className="mini-badge">Returnable: {item.returnable}</span></div>
                  <div className="product-meta">Sold {item.sale?.sold_at ? new Date(item.sale.sold_at).toLocaleString('en-KE') : 'date unavailable'} · Batch {item.batches?.batch_number || 'N/A'} · {formatKes(Number(item.unit_price || 0))} each</div>
                </div><div className="product-price">{String(item.sale_id).slice(0, 8)}<small>Sale ID</small></div>
              </button>
            ))}
            {returnSearch.trim().length >= 2 && !returnLoading && matchedReturnItems.length === 0 && <p className="empty-state">No unreturned sale items match that search in the latest 200 sales.</p>}
            {selectedReturnItem && <div className="return-form">
              <h3>{selectedReturnItem.drugs?.name} · {formatKes(Number(selectedReturnItem.unit_price || 0))} refund per unit</h3>
              <label>Quantity to return<input type="number" min="1" max={selectedReturnItem.returnable} step="1" value={returnQty} onChange={(event) => { setReturnQty(Math.max(1, Math.min(Number(event.target.value) || 1, selectedReturnItem.returnable))); setReturnRequestId(null); }} /></label>
              <label>Refund method<select value={refundMethod} onChange={(event) => { setRefundMethod(event.target.value); setReturnRequestId(null); }}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="insurance">Insurance</option><option value="sha">SHA</option></select></label>
              <label>Reason<input value={returnReason} onChange={(event) => { setReturnReason(event.target.value); setReturnRequestId(null); }} /></label>
              <strong>Refund total: {formatKes(Number(returnQty) * Number(selectedReturnItem.unit_price || 0))}</strong>
              <button type="button" className="complete-sale" disabled={!syncStatus.connected || returnSaving || returnQty < 1} onClick={processReturn}>{returnSaving ? 'Recording return…' : 'Record return and restore stock'}</button>
            </div>}
            {returnMessage && <div className="inline-success">{returnMessage}</div>}
            {returnError && <div className="inline-error">{returnError}</div>}
          </div>}
        </section>

        {pageMode === 'sale' ? <aside className="checkout-pane" aria-label="Checkout">
          <div className="cart-heading">Cart ({cart.length})</div>

          <div className="cart-list">
            {cart.length === 0 && <div className="empty-state">No items yet.</div>}
            {cart.map((line) => (
              <div key={lineKey(line)} className="cart-line">
                <div>
                  <div className="cart-drug">{line.drugName}</div>
                  {line.kind === 'equipment'
                    ? <div className="cart-meta">Medical equipment · {line.item.unit}</div>
                    : <div className="cart-meta">Batch {line.batch.batch_number || 'N/A'} · exp {line.batch.expiry_date}</div>}
                  {line.kind === 'drug' && <label className="discount-field">Discount (KES per unit)
                    <input type="number" min="0" max={Number(line.batch.selling_price || 0)} step="0.01" value={line.discountAmount || 0} onChange={(event) => {
                      const maxDiscount = Number(line.batch.selling_price || 0);
                      const discountAmount = Math.min(Math.max(Number(event.target.value) || 0, 0), maxDiscount);
                      setCart((current) => current.map((item) => lineKey(item) === lineKey(line) ? { ...item, discountAmount } : item));
                    }} />
                  </label>}
                  <div className="cart-meta">{lineDiscount(line) > 0 ? <><s>{formatKes(baseLinePrice(line))}</s> − {formatKes(lineDiscount(line))} → </> : null}{formatKes(linePrice(line))} each</div>
                </div>
                <div className="cart-controls">
                  <button type="button" onClick={() => updateQty(lineKey(line), -1)}>-</button>
                  <span className="tnum">{line.qty}</span>
                  <button type="button" onClick={() => updateQty(lineKey(line), 1)}>+</button>
                  <strong className="tnum">{formatKes(line.qty * linePrice(line))}</strong>
                  <button type="button" className="remove-line" onClick={() => removeLine(lineKey(line))}>Remove</button>
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

            {salesBlocked && (
              <div className="inline-error">New sales are paused: this pharmacy&apos;s subscription has expired. You can still look up stock and reprint receipts. Ask your administrator to renew.</div>
            )}

            <button
              className="complete-sale"
              onClick={checkout}
              disabled={cart.length === 0 || status === 'submitting' || cartHasUnclassifiedDrug || salesBlocked}
            >
              {status === 'submitting' ? 'Recording sale…' : 'Complete sale'}
            </button>

            {checkoutError && <div className="inline-error">{checkoutError}</div>}
            {checkoutError && cart.length > 0 && <button type="button" className="cancel-current-sale" onClick={cancelCurrentSale}>Cancel current sale</button>}

            {status === 'done' && lastReceipt && (
              <div className="inline-success">
                {lastReceipt.queueRow?.status === 'failed'
                  ? 'Sale saved on this device but needs attention. See the rejection details above.'
                  : lastReceipt.queueRow
                    ? 'Sale saved on this device and queued to sync.'
                    : 'Sale synced successfully.'}
                {' '}{lastReceipt.items.length} item(s), {formatKes(lastReceipt.total)} via {lastReceipt.paymentMethod}.
                {lastReceipt.queueRow?.status !== 'failed' && lastReceipt.receipt ? (
                  <>
                    {' '}Receipt {lastReceipt.receipt.receiptNo}.
                    <button
                      type="button"
                      className="receipt-print"
                      onClick={() => {
                        const ok = printReceipt(lastReceipt.receipt, receiptShop);
                        setPrintNotice(ok ? '' : 'Your browser blocked the receipt window. Allow pop-ups for this site, then press Print receipt again.');
                      }}
                    >
                      Print receipt
                    </button>
                  </>
                ) : null}
              </div>
            )}
            {printNotice ? <div className="inline-error">{printNotice}</div> : null}
          </div>
        </aside> : <aside className="checkout-pane return-summary" aria-label="Return summary">
          <div className="cart-heading">Return summary</div>
          {selectedReturnItem ? <>
            <div className="cart-drug">{selectedReturnItem.drugs?.name}</div>
            <div className="cart-meta">Sale {String(selectedReturnItem.sale_id).slice(0, 8)} · {new Date(selectedReturnItem.sale?.sold_at).toLocaleDateString('en-KE')}</div>
            <div className="total-row"><span>Quantity</span><span>{returnQty} / {selectedReturnItem.returnable}</span></div>
            <div className="total-row"><span>Refund</span><span>{formatKes(Number(returnQty) * Number(selectedReturnItem.unit_price || 0))}</span></div>
            <p className="muted">The return is recorded against the original sale and the same batch stock is restored.</p>
          </> : <p className="empty-state">Select a sale item to prepare its return.</p>}
        </aside>}
      </div>
    </div>
  );
}