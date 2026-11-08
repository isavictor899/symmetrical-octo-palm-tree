import { useEffect, useMemo, useState, useRef } from 'react';
import { useRefreshGate } from '../lib/useRefreshGate';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import './MonthlyReport.css';

const currency = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  minimumFractionDigits: 2,
});

const paymentLabels = {
  cash: 'Cash',
  mpesa: 'M-Pesa',
  card: 'Card',
  insurance: 'Insurance',
  sha: 'SHA',
};

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(monthValue) {
  const [year, month] = monthValue.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label: start.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' }),
  };
}

function units(value) {
  const number = Math.round(Number(value) || 0);
  return `${number} unit${number === 1 ? '' : 's'}`;
}

function drugName(row) {
  return row?.drugs?.name || row?.batches?.drugs?.name || 'Unknown drug';
}

function groupDrugs(rows, getQuantity, getAmount = () => 0) {
  const grouped = new Map();
  for (const row of rows) {
    const id = row.drug_id || row.batches?.drug_id || row.id || drugName(row);
    const existing = grouped.get(id) || {
      id,
      name: drugName(row),
      generic: row.drugs?.generic_name || row.batches?.drugs?.generic_name || '',
      quantity: 0,
      amount: 0,
    };
    existing.quantity += Number(getQuantity(row) || 0);
    existing.amount += Number(getAmount(row) || 0);
    grouped.set(id, existing);
  }
  return [...grouped.values()];
}

function topRows(rows, count = 8) {
  return [...rows].sort((a, b) => b.quantity - a.quantity || b.amount - a.amount).slice(0, count);
}

function leastRows(rows, count = 8) {
  return [...rows].sort((a, b) => a.quantity - b.quantity || a.amount - b.amount).slice(0, count);
}

function emptyShopReport(shop) {
  return {
    id: shop.id,
    name: shop.name || 'Shop',
    salesTotal: 0,
    transactions: 0,
    unitsSold: 0,
    receivedUnits: 0,
    transferredIn: 0,
    transferredOut: 0,
  };
}

export default function MonthlyReport({ organizationShops = [], dataVersion = 0, isActive = true }) {
  const gate = useRefreshGate(isActive, dataVersion);
  const showingMonthRef = useRef(null);
  const autoInsightsMonthRef = useRef(null);
  const insightsRequestIdRef = useRef(0);
  const [month, setMonth] = useState(currentMonthValue());
  const [shops, setShops] = useState(organizationShops);
  const [sales, setSales] = useState([]);
  const [salesReturns, setSalesReturns] = useState([]);
  const [saleItems, setSaleItems] = useState([]);
  const [equipmentSaleItems, setEquipmentSaleItems] = useState([]);
  const [movements, setMovements] = useState([]);
  const [currentInventory, setCurrentInventory] = useState([]);
  const [equipmentInventory, setEquipmentInventory] = useState([]);
  const [sourceShopNames, setSourceShopNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reportRefreshKey, setReportRefreshKey] = useState(0);
  const [aiInsights, setAiInsights] = useState('');
  const [aiError, setAiError] = useState('');
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const [transferSelection, setTransferSelection] = useState(null);
  const [transferSourceShopId, setTransferSourceShopId] = useState('');
  const [transferBatchId, setTransferBatchId] = useState('');
  const [transferQuantity, setTransferQuantity] = useState('1');
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [transferMessage, setTransferMessage] = useState('');

  useEffect(() => {
    if (organizationShops.length) setShops(organizationShops);
  }, [organizationShops]);

  useEffect(() => {
    if (!gate) return undefined;
    let cancelled = false;

    async function loadReport() {
      try {
        if (showingMonthRef.current !== month) setLoading(true);
        setError('');

        let reportShops = organizationShops;
        if (!reportShops.length) {
          const { data: userResult, error: userError } = await supabase.auth.getUser();
          if (userError) throw userError;
          if (!userResult.user) throw new Error('Please sign in to view monthly reports.');

          const { data: staff, error: staffError } = await supabase.from('staff')
            .select('shop_id, role, shops(organization_id)')
            .eq('auth_user_id', userResult.user.id)
            .single();
          if (staffError) throw staffError;
          if (!isAdminRole(staff.role)) throw new Error('Monthly organization reports are available to administrators only.');

          const organizationId = staff.shops?.organization_id;
          if (!organizationId) throw new Error('No organization is linked to this account.');

          const { data: shopsData, error: shopsError } = await supabase.from('shops')
            .select('id, name, theme_color')
            .eq('organization_id', organizationId)
            .order('name');
          if (shopsError) throw shopsError;
          reportShops = shopsData || [];
        }

        const shopIds = reportShops.map((shop) => shop.id).filter(Boolean);
        if (!shopIds.length) throw new Error('No shops were found for this organization.');

        const { startIso, endIso } = monthRange(month);

        const [salesResult, saleItemsResult, movementResult, inventoryResult, equipmentSalesResult, equipmentInventoryResult, returnsResult] = await Promise.all([
          supabase.from('sales')
            .select('id, shop_id, total_amount, payment_method, sold_at')
            .in('shop_id', shopIds)
            .gte('sold_at', startIso)
            .lt('sold_at', endIso),
          supabase.from('sale_items')
            .select('drug_id, quantity, unit_price, drugs(name, generic_name), sales!inner(shop_id, sold_at)')
            .in('sales.shop_id', shopIds)
            .gte('sales.sold_at', startIso)
            .lt('sales.sold_at', endIso),
          supabase.from('stock_movements')
            .select('id, shop_id, drug_id, movement_type, quantity, created_at, source_shop_id, batches(cost_price, drugs(name, generic_name))')
            .in('shop_id', shopIds)
            .in('movement_type', ['received', 'transfer_in', 'transfer_out'])
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false }),
          supabase.from('batches')
            .select('id, shop_id, drug_id, quantity_remaining, selling_price, expiry_date, drugs(name, generic_name)')
            .in('shop_id', shopIds),
          supabase.from('equipment_sale_items')
            .select('equipment_supply_id, quantity, unit_price, equipment_supplies(name, unit), sales!inner(shop_id, sold_at)')
            .in('sales.shop_id', shopIds).gte('sales.sold_at', startIso).lt('sales.sold_at', endIso),
          supabase.from('shop_equipment_stock')
            .select('shop_id, equipment_supply_id, quantity_on_hand, selling_price, equipment_supplies(name, unit)')
            .in('shop_id', shopIds),
          supabase.from('sales_returns')
            .select('shop_id, refund_method, total_amount, created_at')
            .in('shop_id', shopIds).gte('created_at', startIso).lt('created_at', endIso),
        ]);

        if (salesResult.error) throw salesResult.error;
        showingMonthRef.current = month;
        if (saleItemsResult.error) throw saleItemsResult.error;
        if (inventoryResult.error) throw inventoryResult.error;
        if (equipmentSalesResult.error) throw equipmentSalesResult.error;
        if (equipmentInventoryResult.error) throw equipmentInventoryResult.error;
        if (returnsResult.error) throw returnsResult.error;

        let movementRows = movementResult.data || [];
        let sourceNames = {};
        if (movementResult.error) {
          if (movementResult.error.message?.includes('source_shop_id')) {
            const fallbackMovementResult = await supabase.from('stock_movements')
              .select('id, shop_id, drug_id, movement_type, quantity, created_at, batches(cost_price, drugs(name, generic_name))')
              .in('shop_id', shopIds)
              .in('movement_type', ['received', 'transfer_in', 'transfer_out'])
              .gte('created_at', startIso)
              .lt('created_at', endIso)
              .order('created_at', { ascending: false });
            if (fallbackMovementResult.error) throw fallbackMovementResult.error;
            movementRows = fallbackMovementResult.data || [];
          } else {
            throw movementResult.error;
          }
        } else {
          const sourceShopIds = [...new Set(movementRows.map((row) => row.source_shop_id).filter(Boolean))];
          if (sourceShopIds.length) {
            const { data: sourceShops, error: sourceError } = await supabase.from('shops')
              .select('id, name')
              .in('id', sourceShopIds);
            if (sourceError) throw sourceError;
            sourceNames = Object.fromEntries((sourceShops || []).map((shop) => [shop.id, shop.name]));
          }
        }

        if (!cancelled) {
          setShops(reportShops);
          setSales(salesResult.data || []);
          setSalesReturns(returnsResult.data || []);
          setSaleItems(saleItemsResult.data || []);
          setEquipmentSaleItems(equipmentSalesResult.data || []);
          setMovements(movementRows);
          setCurrentInventory(inventoryResult.data || []);
          setEquipmentInventory(equipmentInventoryResult.data || []);
          setSourceShopNames(sourceNames);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Unable to load the monthly report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadReport();
    return () => { cancelled = true; };
  }, [month, organizationShops, gate, reportRefreshKey]);

  const report = useMemo(() => {
    const shopMap = new Map(shops.map((shop) => [shop.id, emptyShopReport(shop)]));

    for (const sale of sales) {
      const row = shopMap.get(sale.shop_id);
      if (!row) continue;
      row.salesTotal += Number(sale.total_amount || 0);
      row.transactions += 1;
    }

    for (const refund of salesReturns) {
      const row = shopMap.get(refund.shop_id);
      if (row) row.salesTotal -= Number(refund.total_amount || 0);
    }

    for (const item of saleItems) {
      const row = shopMap.get(item.sales?.shop_id);
      if (!row) continue;
      row.unitsSold += Number(item.quantity || 0);
    }
    for (const item of equipmentSaleItems) {
      const row = shopMap.get(item.sales?.shop_id);
      if (!row) continue;
      row.unitsSold += Number(item.quantity || 0);
    }

    for (const movement of movements) {
      const row = shopMap.get(movement.shop_id);
      if (!row) continue;
      const quantity = Number(movement.quantity || 0);
      if (movement.movement_type === 'received') row.receivedUnits += quantity;
      if (movement.movement_type === 'transfer_in') row.transferredIn += quantity;
      if (movement.movement_type === 'transfer_out') row.transferredOut += quantity;
    }

    const soldDrugs = groupDrugs(
      saleItems,
      (item) => item.quantity,
      (item) => Number(item.quantity || 0) * Number(item.unit_price || 0)
    );
    const slowSellingCandidates = new Map(soldDrugs.map((drug) => [drug.id, drug]));
    for (const stock of currentInventory) {
      const id = stock.drug_id;
      if (!id || slowSellingCandidates.has(id)) continue;
      slowSellingCandidates.set(id, {
        id,
        name: stock.drugs?.name || 'Unknown drug',
        generic: stock.drugs?.generic_name || '',
        quantity: 0,
        amount: 0,
      });
    }
    const soldEquipment = equipmentSaleItems.reduce((grouped, item) => {
      const id = item.equipment_supply_id;
      const row = grouped.get(id) || { id, name: item.equipment_supplies?.name || 'Equipment', generic: item.equipment_supplies?.unit || '', quantity: 0, amount: 0 };
      row.quantity += Number(item.quantity || 0);
      row.amount += Number(item.quantity || 0) * Number(item.unit_price || 0);
      grouped.set(id, row);
      return grouped;
    }, new Map());
    const currentEquipment = equipmentInventory.reduce((grouped, item) => {
      const id = item.equipment_supply_id;
      const row = grouped.get(id) || { id, name: item.equipment_supplies?.name || 'Equipment', generic: item.equipment_supplies?.unit || '', quantity: 0, amount: 0 };
      row.quantity += Number(item.quantity_on_hand || 0);
      row.amount += Number(item.quantity_on_hand || 0) * Number(item.selling_price || 0);
      grouped.set(id, row);
      return grouped;
    }, new Map());
    const receivedDrugs = groupDrugs(
      movements.filter((row) => row.movement_type === 'received'),
      (row) => row.quantity,
      (row) => Number(row.quantity || 0) * Number(row.batches?.cost_price || 0)
    );
    const transferOutDrugs = groupDrugs(
      movements.filter((row) => row.movement_type === 'transfer_out'),
      (row) => row.quantity
    );
    const inventoryDrugs = groupDrugs(
      currentInventory,
      (row) => row.quantity_remaining,
      (row) => Number(row.quantity_remaining || 0) * Number(row.selling_price || 0)
    );

    const paymentSummary = sales.reduce((acc, sale) => {
      const method = sale.payment_method || 'unknown';
      if (!acc[method]) acc[method] = { method, count: 0, amount: 0 };
      acc[method].count += 1;
      acc[method].amount += Number(sale.total_amount || 0);
      return acc;
    }, {});
    for (const refund of salesReturns) {
      const method = refund.refund_method || 'unknown';
      if (!paymentSummary[method]) paymentSummary[method] = { method, count: 0, amount: 0 };
      paymentSummary[method].amount -= Number(refund.total_amount || 0);
    }

    return {
      shopRows: [...shopMap.values()],
      totalSales: sales.reduce((total, sale) => total + Number(sale.total_amount || 0), 0)
        - salesReturns.reduce((total, refund) => total + Number(refund.total_amount || 0), 0),
      returnsAmount: salesReturns.reduce((total, refund) => total + Number(refund.total_amount || 0), 0),
      transactions: sales.length,
      unitsSold: saleItems.reduce((total, item) => total + Number(item.quantity || 0), 0)
        + equipmentSaleItems.reduce((total, item) => total + Number(item.quantity || 0), 0),
      receivedUnits: movements.filter((row) => row.movement_type === 'received').reduce((total, row) => total + Number(row.quantity || 0), 0),
      transferredOutUnits: movements.filter((row) => row.movement_type === 'transfer_out').reduce((total, row) => total + Number(row.quantity || 0), 0),
      topSelling: topRows(soldDrugs),
      leastSelling: leastRows([...slowSellingCandidates.values()]),
      soldEquipment: topRows([...soldEquipment.values()]),
      currentEquipment: topRows([...currentEquipment.values()], 12),
      receivedDrugs: topRows(receivedDrugs, 10),
      transferOutDrugs: topRows(transferOutDrugs, 10),
      inventoryDrugs: topRows(inventoryDrugs, 12),
      paymentRows: Object.values(paymentSummary).sort((a, b) => b.amount - a.amount),
      transferRows: movements.filter((row) => row.movement_type === 'transfer_out' || row.movement_type === 'transfer_in'),
    };
  }, [shops, sales, salesReturns, saleItems, equipmentSaleItems, movements, currentInventory, equipmentInventory]);

  const { label } = monthRange(month);

  const transferSuggestions = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const isUnexpired = (batch) => !batch.expiry_date || String(batch.expiry_date).slice(0, 10) >= today;
    const soldByShopDrug = new Map();
    for (const item of saleItems) {
      const shopId = item.sales?.shop_id;
      const drugId = item.drug_id || item.drugs?.id;
      if (!shopId || !drugId) continue;
      const key = `${shopId}:${drugId}`;
      soldByShopDrug.set(key, (soldByShopDrug.get(key) || 0) + Number(item.quantity || 0));
    }

    const stockByShopDrug = new Map();
    for (const batch of currentInventory) {
      const key = `${batch.shop_id}:${batch.drug_id}`;
      const rows = stockByShopDrug.get(key) || [];
      rows.push(batch);
      stockByShopDrug.set(key, rows);
    }

    const suggestions = [];
    for (const target of shops) {
      for (const [key, targetSold] of soldByShopDrug) {
        if (!key.startsWith(`${target.id}:`) || targetSold < 2) continue;
        const drugId = key.slice(target.id.length + 1);
        const targetBatches = (stockByShopDrug.get(key) || []).filter(isUnexpired);
        const targetStock = targetBatches.reduce((sum, batch) => sum + Number(batch.quantity_remaining || 0), 0);
        const shortage = Math.max(0, targetSold - targetStock);
        if (!shortage) continue;

        const donors = shops.filter((shop) => shop.id !== target.id).map((shop) => {
          const batches = (stockByShopDrug.get(`${shop.id}:${drugId}`) || [])
            .filter((batch) => Number(batch.quantity_remaining || 0) > 0 && isUnexpired(batch))
            .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')));
          const donorSold = soldByShopDrug.get(`${shop.id}:${drugId}`) || 0;
          const donorOnHand = batches.reduce((sum, batch) => sum + Number(batch.quantity_remaining || 0), 0);
          let remainingSurplus = Math.max(0, donorOnHand - donorSold);
          const transferableBatches = batches.map((batch) => {
            const transferable = Math.min(Number(batch.quantity_remaining || 0), remainingSurplus);
            remainingSurplus -= transferable;
            return { ...batch, transferable };
          }).filter((batch) => batch.transferable > 0);
          const available = transferableBatches.reduce((sum, batch) => sum + batch.transferable, 0);
          return { ...shop, batches: transferableBatches, available };
        }).filter((shop) => shop.available > 0).sort((a, b) => b.available - a.available);

        if (donors.length) {
          suggestions.push({
            drugId,
            drugName: targetBatches[0]?.drugs?.name || saleItems.find((row) => row.drug_id === drugId)?.drugs?.name || 'Drug',
            targetShopId: target.id,
            targetShopName: target.name || 'Shop',
            targetSold,
            targetStock,
            shortage,
            donors,
          });
        }
      }
    }
    return suggestions.sort((a, b) => b.shortage - a.shortage || b.targetSold - a.targetSold).slice(0, 5);
  }, [shops, saleItems, currentInventory]);

  useEffect(() => {
    setAiInsights('');
    setAiError('');
    insightsRequestIdRef.current += 1;
    setGeneratingInsights(false);
  }, [month]);

  async function generateInsights() {
    if (generatingInsights) return;
    const requestId = ++insightsRequestIdRef.current;
    setGeneratingInsights(true);
    setAiError('');
    setAiInsights('');
    try {
      const analytics = {
        totalSales: report.totalSales,
        returnsAmount: report.returnsAmount,
        transactions: report.transactions,
        unitsSold: report.unitsSold,
        topSelling: report.topSelling.slice(0, 8).map(({ name, quantity, amount }) => ({ name, quantity, amount })),
        leastSelling: report.leastSelling.slice(0, 8).map(({ name, quantity, amount }) => ({ name, quantity, amount })),
        shops: report.shopRows.map(({ name, salesTotal, transactions, unitsSold }) => ({ name, salesTotal, transactions, unitsSold })),
        stockTransferOpportunities: transferSuggestions.map(({ drugName, targetShopName, targetSold, targetStock, donors }) => ({
          drugName, targetShopName, targetSold, targetStock,
          possibleSources: donors.map(({ name, available }) => ({ shopName: name, available })),
        })),
      };
      const { data, error: functionError } = await supabase.functions.invoke('monthly-report-insights', {
        body: { month, shopIds: shops.map((shop) => shop.id), analytics },
      });
      if (functionError) throw functionError;
      if (!data?.insights) throw new Error('The AI service returned no report insights.');
      if (requestId !== insightsRequestIdRef.current) return;
      setAiInsights(data.insights);
    } catch (insightError) {
      if (requestId === insightsRequestIdRef.current) setAiError(insightError.message || 'Unable to generate AI insights. Check the AI function setup and try again.');
    } finally {
      if (requestId === insightsRequestIdRef.current) setGeneratingInsights(false);
    }
  }

  useEffect(() => {
    if (loading || error || !shops.length || showingMonthRef.current !== month || autoInsightsMonthRef.current === month) return;
    autoInsightsMonthRef.current = month;
    generateInsights();
  }, [loading, error, month]);

  function openTransferSuggestion(suggestion) {
    const firstDonor = suggestion.donors[0];
    const firstBatch = firstDonor?.batches[0];
    setTransferSelection(suggestion);
    setTransferSourceShopId(firstDonor?.id || '');
    setTransferBatchId(firstBatch?.id || '');
    setTransferQuantity(String(Math.min(suggestion.shortage, firstBatch?.transferable || 1)));
    setTransferMessage('');
  }

  async function saveSuggestedTransfer(event) {
    event.preventDefault();
    if (!transferSelection || savingTransfer) return;
    const selectedDonor = transferSelection.donors.find((shop) => shop.id === transferSourceShopId);
    const batch = selectedDonor?.batches.find((item) => item.id === transferBatchId);
    const quantity = Number(transferQuantity);
    if (!batch || !Number.isInteger(quantity) || quantity < 1 || quantity > batch.transferable || quantity > transferSelection.shortage) {
      setAiError('Choose a valid batch and quantity within the suggested stock limits.');
      return;
    }

    setSavingTransfer(true);
    setAiError('');
    try {
      const { error: transferError } = await supabase.rpc('transfer_stock_between_shops', {
        p_from_shop_id: transferSourceShopId,
        p_to_shop_id: transferSelection.targetShopId,
        p_batch_id: transferBatchId,
        p_quantity: quantity,
      });
      if (transferError) throw transferError;
      setTransferMessage(`${quantity} unit${quantity === 1 ? '' : 's'} of ${transferSelection.drugName} transferred to ${transferSelection.targetShopName}.`);
      setTransferSelection(null);
      setReportRefreshKey((key) => key + 1);
    } catch (transferError) {
      setAiError(transferError.message || 'Unable to transfer the selected stock.');
    } finally {
      setSavingTransfer(false);
    }
  }

  if (loading) return <main className="monthly-report"><p>Loading monthly report…</p></main>;
  if (error) return <main className="monthly-report"><p className="error">{error}</p></main>;

  return (
    <main className="monthly-report">
      <header className="monthly-header">
        <div>
          <p className="eyebrow">Organization report</p>
          <h1>Monthly sales and inventory</h1>
          <p className="muted">Whole organization summary with shop-level details for {label}.</p>
        </div>
        <label className="month-picker">
          <span>Report month</span>
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
      </header>

      <div className="monthly-report-layout">
        <div className="monthly-report-data">
      <section className="report-metrics" aria-label="Monthly organization summary">
        <article><span>Total sales</span><strong>{currency.format(report.totalSales)}</strong></article>
        <article><span>Returns / refunds</span><strong>{currency.format(report.returnsAmount)}</strong></article>
        <article><span>Transactions</span><strong>{report.transactions}</strong></article>
        <article><span>Units sold</span><strong>{units(report.unitsSold)}</strong></article>
        <article><span>Units received</span><strong>{units(report.receivedUnits)}</strong></article>
        <article><span>Transferred out</span><strong>{units(report.transferredOutUnits)}</strong></article>
      </section>

      <section className="report-grid">
        <article className="report-panel wide">
          <h2>Sales by shop</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Shop</th><th>Sales</th><th>Transactions</th><th>Units sold</th><th>Received</th><th>Transfer in</th><th>Transfer out</th></tr></thead>
              <tbody>
                {report.shopRows.map((shop) => (
                  <tr key={shop.id}>
                    <td><strong>{shop.name}</strong></td>
                    <td>{currency.format(shop.salesTotal)}</td>
                    <td>{shop.transactions}</td>
                    <td>{units(shop.unitsSold)}</td>
                    <td>{units(shop.receivedUnits)}</td>
                    <td>{units(shop.transferredIn)}</td>
                    <td>{units(shop.transferredOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <DrugPanel title="Top-selling drugs" rows={report.topSelling} empty="No sales were recorded this month." showAmount />
        <DrugPanel title="Least-selling drugs" rows={report.leastSelling} empty="No sold drugs to compare yet." showAmount />
        <DrugPanel title="Medical equipment sold" rows={report.soldEquipment} empty="No equipment sales were recorded this month." showAmount />
        <DrugPanel title="Drugs bought / received" rows={report.receivedDrugs} empty="No supplier stock receipts this month." showAmount />
        <DrugPanel title="Current organization stock" rows={report.inventoryDrugs} empty="No current stock found." showAmount amountLabel="Stock value" />
        <DrugPanel title="Current equipment stock" rows={report.currentEquipment} empty="No current equipment stock found." showAmount amountLabel="Stock value" />

        <article className="report-panel wide">
          <h2>Transfers between shops</h2>
          {!report.transferRows.length ? <p className="muted">No transfers were recorded this month.</p> : (
            <ul className="report-list">
              {report.transferRows.slice(0, 14).map((movement) => {
                const shop = shops.find((item) => item.id === movement.shop_id);
                const sourceName = movement.source_shop_id ? sourceShopNames[movement.source_shop_id] : '';
                const direction = movement.movement_type === 'transfer_in'
                  ? `Received by ${shop?.name || 'shop'}${sourceName ? ` from ${sourceName}` : ''}`
                  : `Sent from ${shop?.name || 'shop'}`;
                return <li key={movement.id}><span><strong>{drugName(movement)}</strong><small>{direction} · {new Date(movement.created_at).toLocaleDateString('en-KE')}</small></span><strong>{units(movement.quantity)}</strong></li>;
              })}
            </ul>
          )}
        </article>

        <article className="report-panel">
          <h2>Payment methods</h2>
          {!report.paymentRows.length ? <p className="muted">No payments this month.</p> : (
            <ul className="report-list">
              {report.paymentRows.map((payment) => <li key={payment.method}><span><strong>{paymentLabels[payment.method] || payment.method}</strong><small>{payment.count} transaction{payment.count === 1 ? '' : 's'}</small></span><strong>{currency.format(payment.amount)}</strong></li>)}
            </ul>
          )}
        </article>
      </section>
        </div>

        <aside className="monthly-ai-panel" aria-label="AI monthly report insights">
          <div className="monthly-ai-heading">
            <div><p className="eyebrow">Report assistant</p><h2>Monthly insights</h2></div>
            <span className="ai-badge">AI</span>
          </div>
          <p className="muted small">A short read of sales movement and possible stock balancing for {label}.</p>
          <button type="button" className="monthly-ai-button" onClick={generateInsights} disabled={generatingInsights}>
            {generatingInsights ? 'Reading report…' : aiInsights ? 'Refresh AI insights' : 'Generate AI insights'}
          </button>
          {aiInsights ? <p className="monthly-ai-output">{aiInsights}</p> : <p className="monthly-ai-placeholder">Generate a briefing based on this month’s aggregated report data.</p>}
          {aiError ? <p className="monthly-ai-error" role="alert">{aiError}</p> : null}
          <p className="monthly-ai-disclaimer">Medicine sales are stock and demand signals only; they cannot establish community health rates. The AI request sends aggregated report totals, medicine names and sales, and shop summaries to Google Gemini. No customer, staff, or transaction-level records are sent. Use a paid Gemini API project for real business data.</p>

          <div className="monthly-ai-lists">
            <section>
              <h3>Best sellers</h3>
              {!report.topSelling.length ? <p className="muted small">No drug sales this month.</p> : report.topSelling.slice(0, 4).map((item, index) => (
                <div className="monthly-ai-list-row" key={`best-${item.id}`}><span>{index + 1}. {item.name}</span><strong>{units(item.quantity)}</strong></div>
              ))}
            </section>
            <section>
              <h3>Slow movers</h3>
              {!report.leastSelling.length ? <p className="muted small">No sold drugs to compare.</p> : report.leastSelling.slice(0, 4).map((item) => (
                <div className="monthly-ai-list-row" key={`slow-${item.id}`}><span>{item.name}</span><strong>{units(item.quantity)}</strong></div>
              ))}
            </section>
          </div>

          <section className="monthly-transfer-suggestions">
            <h3>Possible stock transfers</h3>
            {!transferSuggestions.length ? <p className="muted small">No clear transfer matches. Suggestions appear when another shop has stock above this month’s sales and a receiving shop has sold more than its current stock.</p> : transferSuggestions.map((suggestion) => (
              <article className="monthly-transfer-card" key={`${suggestion.targetShopId}-${suggestion.drugId}`}>
                <strong>{suggestion.drugName}</strong>
                <p>{suggestion.targetShopName}: {units(suggestion.targetSold)} sold, {units(suggestion.targetStock)} currently on hand.</p>
                <small>Potential source: {suggestion.donors[0].name} ({units(suggestion.donors[0].available)} above its monthly sales)</small>
                <button type="button" className="monthly-transfer-button" onClick={() => openTransferSuggestion(suggestion)}>Review transfer</button>
              </article>
            ))}
          </section>

          {transferMessage ? <p className="monthly-transfer-success" role="status">{transferMessage}</p> : null}
          {transferSelection ? (
            <form className="monthly-transfer-form" onSubmit={saveSuggestedTransfer}>
              <h3>Transfer {transferSelection.drugName}</h3>
              <p className="muted small">To {transferSelection.targetShopName} · suggested need up to {units(transferSelection.shortage)}</p>
              <label>From shop
                <select value={transferSourceShopId} onChange={(event) => {
                  const nextShopId = event.target.value;
                  const nextDonor = transferSelection.donors.find((shop) => shop.id === nextShopId);
                  const nextBatch = nextDonor?.batches[0];
                  setTransferSourceShopId(nextShopId);
                  setTransferBatchId(nextBatch?.id || '');
                  setTransferQuantity(String(Math.min(transferSelection.shortage, nextBatch?.transferable || 1)));
                }}>
                  {transferSelection.donors.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {units(shop.available)} available</option>)}
                </select>
              </label>
              <label>Batch
                <select value={transferBatchId} onChange={(event) => {
                  const batch = transferSelection.donors.find((shop) => shop.id === transferSourceShopId)?.batches.find((item) => item.id === event.target.value);
                  setTransferBatchId(event.target.value);
                  setTransferQuantity(String(Math.min(transferSelection.shortage, batch?.transferable || 1)));
                }}>
                  {transferSelection.donors.find((shop) => shop.id === transferSourceShopId)?.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.expiry_date ? `Expires ${batch.expiry_date} · ` : ''}{units(batch.transferable)} transferable</option>)}
                </select>
              </label>
              <label>Quantity
                <input type="number" min="1" max={Math.min(transferSelection.shortage, transferSelection.donors.find((shop) => shop.id === transferSourceShopId)?.batches.find((batch) => batch.id === transferBatchId)?.transferable || 1)} step="1" value={transferQuantity} onChange={(event) => setTransferQuantity(event.target.value)} required />
              </label>
              <div className="monthly-transfer-actions">
                <button type="submit" className="monthly-transfer-button" disabled={savingTransfer}>{savingTransfer ? 'Transferring…' : 'Transfer stock'}</button>
                <button type="button" className="monthly-transfer-cancel" onClick={() => setTransferSelection(null)}>Cancel</button>
              </div>
            </form>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function DrugPanel({ title, rows, empty, showAmount = false, amountLabel = 'Sales value' }) {
  return (
    <article className="report-panel">
      <h2>{title}</h2>
      {!rows.length ? <p className="muted">{empty}</p> : (
        <ul className="report-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.name}</strong>
                {row.generic ? <small>{row.generic}</small> : null}
              </span>
              <strong>{units(row.quantity)}{showAmount ? <small>{amountLabel}: {currency.format(row.amount)}</small> : null}</strong>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
