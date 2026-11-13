import { useEffect, useMemo, useState, useRef } from 'react';
import { useRefreshGate } from '../lib/useRefreshGate';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import { defaultBrandColor, applyBrandTheme } from '../lib/theme';
import './Dashboard.css';

const currency = new Intl.NumberFormat('en-KE', {
  style: 'currency', currency: 'KES', minimumFractionDigits: 2,
});
const paymentMethods = ['cash', 'mpesa', 'card', 'insurance', 'sha'];
const paymentLabels = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', insurance: 'Insurance', sha: 'SHA' };

function roundedUnits(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function unitLabel(value) {
  const units = roundedUnits(value);
  return `${units} unit${units === 1 ? '' : 's'}`;
}

function parseInsightMessage(message) {
  if (!message) return null;

  const lowStockMatch = message.match(/low at (-?[\d.]+) units\s*\(([\d.]+)\/day average, reorder point ([\d.]+) units\)/i);
  if (!lowStockMatch) return null;

  const currentUnits = Number(lowStockMatch[1]);
  const averagePerDay = Number(lowStockMatch[2]);
  const reorderPoint = Number(lowStockMatch[3]);

  return {
    stockStatus: currentUnits < 0
      ? `Short by ${unitLabel(Math.abs(currentUnits))}`
      : `${unitLabel(currentUnits)} left`,
    averageUse: `${unitLabel(averagePerDay)}/day`,
    reorderPoint: unitLabel(reorderPoint),
  };
}

function buildStockRecommendation(drug) {
  const quantity = roundedUnits(drug.quantity);
  const reorderPoint = roundedUnits(drug.safetyStock);
  const shortage = Math.max(0, reorderPoint - quantity);

  return {
    id: drug.id,
    name: drug.name,
    severity: quantity === 0 ? 'critical' : 'warning',
    stockStatus: shortage > 0 ? `Short by ${unitLabel(shortage)}` : `${unitLabel(quantity)} left`,
    currentStock: unitLabel(quantity),
    reorderPoint: unitLabel(reorderPoint),
  };
}

function stockStatusText(quantity) {
  const units = Math.round(Number(quantity) || 0);
  if (units < 0) return `Discrepancy: ${Math.abs(units)} units short`;
  if (units === 0) return 'Out of stock';
  return `${units} left`;
}

function stockStatusClass(quantity) {
  const units = Math.round(Number(quantity) || 0);
  if (units <= 0) return 'critical';
  return 'warning';
}

function formatInsightMessage(message) {
  if (!message) return '';

  return message
    .replace(/low at -([\d.]+) units/gi, (_match, shortage) => `short by ${roundedUnits(shortage)} units`)
    .replace(/low at ([\d.]+) units/gi, (_match, units) => `low at ${roundedUnits(units)} units`)
    .replace(/\(([\d.]+)\/day average, reorder point ([\d.]+) units\)/gi, (_match, average, reorderPoint) =>
      `(about ${roundedUnits(average)} unit${roundedUnits(average) === 1 ? '' : 's'}/day, reorder at ${roundedUnits(reorderPoint)} units)`
    );
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function isExpiredBatch(batch) {
  return Boolean(batch?.expiry_date && batch.expiry_date < todayDateString());
}

function movementLabel(movement, sourceShopNames = {}) {
  if (movement.movement_type === 'transfer_in') {
    const sourceName = movement.source_shop_id ? sourceShopNames[movement.source_shop_id] : '';
    return sourceName ? `Transferred from ${sourceName}` : 'Transferred from another shop';
  }
  return 'Received from supplier';
}

function roleLabel(role) {
  const value = String(role || '').trim();
  if (!value) return 'Unknown role';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export default function Dashboard({ activeShopId, activeShopName, organizationShops = [], onActiveShopChange, dataVersion = 0, isActive = true }) {
  const gate = useRefreshGate(isActive, dataVersion);
  const showingShopRef = useRef(null);
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [shopName, setShopName] = useState('');
  const [todaySales, setTodaySales] = useState([]);
  const [todayReturns, setTodayReturns] = useState([]);
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [topDrugs, setTopDrugs] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [receivedStock, setReceivedStock] = useState([]);
  const [sourceShopNames, setSourceShopNames] = useState({});
  const [expiredStock, setExpiredStock] = useState([]);
  const [equipmentStock, setEquipmentStock] = useState([]);
  const [todayDiscounts, setTodayDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Runs once: confirm the signed-in user is an admin, then load the
  // full list of shops (with their real saved theme color) so they can
  // switch between them.
  useEffect(() => {
    if (organizationShops.length) {
      setAllShops(organizationShops);
      setSelectedShopId(activeShopId);
      setLoading(false);
      return () => {};
    }

    let cancelled = false;
    async function init() {
      try {
        setLoading(true);
        setError('');
        const { data: userResult, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!userResult.user) throw new Error('Please sign in to view the dashboard.');

        const { data: staff, error: staffError } = await supabase.from('staff')
          .select('shop_id, role, shops(name, organization_id)')
          .eq('auth_user_id', userResult.user.id)
          .single();
        if (staffError) throw staffError;
        if (!staff) throw new Error('No staff record is linked to this account.');
        if (!isAdminRole(staff.role)) throw new Error('The dashboard is available to administrators only.');

        const organizationId = staff.shops?.organization_id;
        if (!organizationId) throw new Error('No organization is linked to this account.');

        const { data: shopsData, error: shopsError } = await supabase.from('shops')
          .select('id, name, theme_color')
          .eq('organization_id', organizationId)
          .order('name');
        if (shopsError) throw shopsError;

        if (!cancelled) {
          setAllShops(shopsData || []);
          setSelectedShopId(staff.shop_id); // default to the admin's own shop
        }
      } catch (initError) {
        if (!cancelled) {
          setError(initError.message || 'Unable to load the dashboard.');
          setLoading(false);
        }
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!organizationShops.length) return;
    setAllShops(organizationShops);
    setSelectedShopId(activeShopId);
  }, [activeShopId, organizationShops]);

  // Reflects the viewed shop's own saved brand color while browsing —
  // editing it happens on the Settings page, not here.
  useEffect(() => {
    const activeShop = allShops.find((shop) => shop.id === selectedShopId);
    if (!activeShop && activeShopName) {
      setShopName(activeShopName);
      return;
    }
    if (!activeShop) return;
    applyBrandTheme(activeShop.theme_color || defaultBrandColor);
    setShopName(activeShop.name || 'Shop');
  }, [selectedShopId, allShops]);

  // Re-runs every time the selected shop changes (including the first load).
  useEffect(() => {
    if (!selectedShopId || !gate) return;
    let cancelled = false;
    async function loadShopData() {
      try {
        if (showingShopRef.current !== selectedShopId) setLoading(true);
        setError('');

        const today = startOfToday();

        // Phase 1: quick minimal load so the dashboard can render fast.
        const salesResult = await supabase.from('sales')
          .select('id, total_amount, payment_method, sold_at')
          .eq('shop_id', selectedShopId).gte('sold_at', today);
        if (salesResult.error) throw salesResult.error;

        if (!cancelled) {
          setTodaySales(salesResult.data || []);
          setTodayReturns([]);
        }

        // Allow the UI to render and stop the initial loading state.
        if (!cancelled) {
          showingShopRef.current = selectedShopId;
          setLoading(false);
        }

        // Phase 2: load less-critical / heavier datasets in the background.
        setLoadingMore(true);
        try {
          const [itemsResult, batchesResult, policyResult, receivedResult, equipmentResult, equipmentSalesResult, returnsResult, discountsResult] = await Promise.all([
            supabase.from('sale_items').select('id, sale_id, drug_id, quantity, unit_price, drugs(name), sales!inner(id, shop_id, sold_at, total_amount, payment_method)')
              .eq('sales.shop_id', selectedShopId).gte('sales.sold_at', today),
            supabase.from('batches').select('id, drug_id, batch_number, expiry_date, quantity_remaining, drugs(name)')
              .eq('shop_id', selectedShopId),
            supabase.from('inventory_policy').select('drug_id, safety_stock_units, drugs(name)')
              .eq('shop_id', selectedShopId),
            supabase.from('stock_movements').select('id, quantity, created_at, movement_type, source_shop_id, batches(cost_price, drugs(name))')
              .eq('shop_id', selectedShopId)
              .in('movement_type', ['received', 'transfer_in'])
              .gte('created_at', today).order('created_at', { ascending: false }),
            supabase.from('shop_equipment_stock')
              .select('equipment_supply_id, quantity_on_hand, average_cost, selling_price, equipment_supplies(name, category, unit)')
              .eq('shop_id', selectedShopId)
              .order('equipment_supply_id'),
            supabase.from('equipment_sale_items')
              .select('id, sale_id, equipment_supply_id, quantity, unit_price, equipment_supplies(name), sales!inner(id, shop_id, sold_at, total_amount, payment_method)')
              .eq('sales.shop_id', selectedShopId).gte('sales.sold_at', today),
            supabase.from('sales_returns').select('id, total_amount, refund_method, created_at')
              .eq('shop_id', selectedShopId).gte('created_at', today),
            supabase.from('sale_item_discounts')
              .select('sale_item_id, original_unit_price, discount_amount, discount_percent, discounted_by, discounted_by_name, discounted_by_role, created_at, sale_items!inner(quantity, drugs(name))')
              .eq('shop_id', selectedShopId).gte('created_at', today).gt('discount_amount', 0)
              .order('created_at', { ascending: false }),
          ]);
          for (const result of [itemsResult, batchesResult, policyResult]) {
            if (result.error) throw result.error;
          }
          if (equipmentResult.error) throw equipmentResult.error;
          if (equipmentSalesResult.error) throw equipmentSalesResult.error;
          if (returnsResult.error) throw returnsResult.error;
          if (discountsResult.error) {
            // The discount ledger is an optional enhancement. A database where
            // the discount migration has not been applied yet must not break
            // the rest of the dashboard.
            console.warn('Discount summary unavailable:', discountsResult.error.message);
          }

          let receivedRows = receivedResult.data || [];
          let sourceNames = {};
          if (receivedResult.error) {
            // Older databases may not have source_shop_id yet. Keep the
            // dashboard working, but only show the source-shop label after
            // the SQL patch has been applied.
            if (receivedResult.error.message?.includes('source_shop_id')) {
              const fallbackReceived = await supabase.from('stock_movements').select('id, quantity, created_at, movement_type, batches(cost_price, drugs(name))')
                .eq('shop_id', selectedShopId)
                .in('movement_type', ['received', 'transfer_in'])
                .gte('created_at', today).order('created_at', { ascending: false });
              if (fallbackReceived.error) throw fallbackReceived.error;
              receivedRows = fallbackReceived.data || [];
            } else {
              throw receivedResult.error;
            }
          } else {
            const sourceShopIds = [...new Set(receivedRows.map((row) => row.source_shop_id).filter(Boolean))];
            if (sourceShopIds.length) {
              const { data: sourceShops, error: sourceShopsError } = await supabase
                .from('shops')
                .select('id, name')
                .in('id', sourceShopIds);
              if (sourceShopsError) throw sourceShopsError;
              sourceNames = Object.fromEntries((sourceShops || []).map((shop) => [shop.id, shop.name]));
            }
          }

          const byDrug = {};
          const transactionsBySale = {};
          for (const item of itemsResult.data || []) {
            if (!byDrug[item.drug_id]) {
              byDrug[item.drug_id] = { id: item.drug_id, name: item.drugs?.name || 'Unknown drug', quantity: 0, revenue: 0 };
            }
            byDrug[item.drug_id].quantity += Number(item.quantity);
            byDrug[item.drug_id].revenue += Number(item.quantity) * Number(item.unit_price);

            const sale = item.sales;
            const saleId = sale?.id || item.sale_id;
            if (saleId) {
              if (!transactionsBySale[saleId]) {
                transactionsBySale[saleId] = {
                  id: saleId,
                  sold_at: sale?.sold_at,
                  payment_method: sale?.payment_method,
                  total_amount: Number(sale?.total_amount || 0),
                  items: [],
                };
              }
              transactionsBySale[saleId].items.push({
                id: item.id || `${saleId}-${item.drug_id}`,
                name: item.drugs?.name || 'Unknown drug',
                quantity: Number(item.quantity || 0),
                amount: Number(item.quantity || 0) * Number(item.unit_price || 0),
              });
            }
          }

          for (const item of equipmentSalesResult.data || []) {
            const id = `equipment:${item.equipment_supply_id}`;
            if (!byDrug[id]) byDrug[id] = { id, name: item.equipment_supplies?.name || 'Equipment', quantity: 0, revenue: 0 };
            byDrug[id].quantity += Number(item.quantity || 0);
            byDrug[id].revenue += Number(item.quantity || 0) * Number(item.unit_price || 0);
            const sale = item.sales;
            if (sale?.id) {
              if (!transactionsBySale[sale.id]) transactionsBySale[sale.id] = {
                id: sale.id, sold_at: sale.sold_at, payment_method: sale.payment_method,
                total_amount: Number(sale.total_amount || 0), items: [],
              };
              transactionsBySale[sale.id].items.push({
                id: item.id, name: item.equipment_supplies?.name || 'Equipment',
                quantity: Number(item.quantity || 0),
                amount: Number(item.quantity || 0) * Number(item.unit_price || 0),
              });
            }
          }

          const stockByDrug = {};
          const expiredRows = [];
          // Start with every policy, including products that currently have no batches.
          for (const policy of policyResult.data || []) {
            stockByDrug[policy.drug_id] = {
              id: policy.drug_id,
              name: policy.drugs?.name || 'Unknown drug',
              quantity: 0,
              safetyStock: Number(policy.safety_stock_units || 0),
            };
          }
          for (const batch of batchesResult.data || []) {
            if (!stockByDrug[batch.drug_id]) {
              stockByDrug[batch.drug_id] = {
                id: batch.drug_id, name: batch.drugs?.name || 'Unknown drug', quantity: 0, safetyStock: 0,
              };
            }
            if (isExpiredBatch(batch) && Number(batch.quantity_remaining || 0) > 0) {
              expiredRows.push(batch);
            } else {
              stockByDrug[batch.drug_id].quantity += Number(batch.quantity_remaining);
            }
          }
          const lowStockRows = Object.values(stockByDrug)
            .filter((drug) => drug.quantity <= drug.safetyStock)
            .sort((a, b) => a.quantity - b.quantity);

          if (!cancelled) {
            setTopDrugs(Object.values(byDrug).sort((a, b) => b.quantity - a.quantity).slice(0, 5));
            setRecentTransactions(Object.values(transactionsBySale).sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at)).slice(0, 8));
            setLowStock(lowStockRows);
            setRecommendations(lowStockRows.map(buildStockRecommendation));
            setReceivedStock(receivedRows);
            setSourceShopNames(sourceNames);
            setExpiredStock(expiredRows);
            setEquipmentStock((equipmentResult.data || []).map((row) => ({
              id: row.equipment_supply_id,
              name: row.equipment_supplies?.name || 'Unknown equipment',
              category: row.equipment_supplies?.category || '',
              unit: row.equipment_supplies?.unit || 'unit',
              quantity: Number(row.quantity_on_hand || 0),
              averageCost: Number(row.average_cost || 0),
              sellingPrice: Number(row.selling_price || 0),
            })));
            setTodayReturns(returnsResult.data || []);
            setTodayDiscounts((discountsResult.data || []).map((row) => ({
              id: row.sale_item_id,
              name: row.sale_items?.drugs?.name || 'Product',
              quantity: Number(row.sale_items?.quantity || 1),
              discountAmount: Number(row.discount_amount || 0),
              // Snapshotted at the time of the discount, so it does not depend
              // on the staff table's RLS visibility.
              staffName: row.discounted_by_name || 'Unknown staff',
              staffRole: row.discounted_by_role || '',
            })));
          }
        } catch (bgErr) {
          if (!cancelled) setError(bgErr.message || 'Unable to load some dashboard data.');
        } finally {
          if (!cancelled) setLoadingMore(false);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Unable to load the dashboard.');
        if (!cancelled) setLoading(false);
      }
    }
    loadShopData();
    return () => { cancelled = true; };
  }, [selectedShopId, gate]);

  const totalRevenue = useMemo(
    () => todaySales.reduce((total, sale) => total + Number(sale.total_amount), 0)
      - todayReturns.reduce((total, row) => total + Number(row.total_amount || 0), 0),
    [todaySales, todayReturns]
  );
  const paymentSummary = useMemo(() => paymentMethods.map((method) => {
    const sales = todaySales.filter((sale) => sale.payment_method === method);
    const refunds = todayReturns.filter((row) => row.refund_method === method);
    return { method, count: sales.length, total: sales.reduce((sum, sale) => sum + Number(sale.total_amount), 0) - refunds.reduce((sum, row) => sum + Number(row.total_amount || 0), 0) };
  }), [todaySales, todayReturns]);
  const receivedUnits = useMemo(() => receivedStock.reduce((total, movement) => total + Number(movement.quantity), 0), [receivedStock]);
  const receivedCost = useMemo(() => receivedStock.reduce(
    (total, movement) => total + Number(movement.quantity) * Number(movement.batches?.cost_price || 0), 0
  ), [receivedStock]);
  const expiredUnits = useMemo(() => expiredStock.reduce(
    (total, batch) => total + Number(batch.quantity_remaining || 0), 0
  ), [expiredStock]);
  const discountTotal = useMemo(
    () => todayDiscounts.reduce((total, row) => total + row.discountAmount * row.quantity, 0),
    [todayDiscounts]
  );

  if (loading) return <main className="dashboard"><p>Loading dashboard…</p></main>;
  if (error) return <main className="dashboard"><p className="error">{error}</p></main>;

  return <main className="dashboard">
    <header><div><p className="eyebrow">{shopName}</p><h1>Today’s sales and stock</h1></div><time>{new Date().toLocaleDateString('en-KE', { dateStyle: 'full' })}</time></header>
    {allShops.length > 1 && (
      <nav className="shop-switcher" aria-label="Switch shop">
        {allShops.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === selectedShopId ? 'active' : ''}
            onClick={() => {
              setSelectedShopId(s.id);
              onActiveShopChange?.(s.id);
            }}
          >
            {s.name}
          </button>
        ))}
      </nav>
    )}
    {loadingMore && <div className="loading-more">Loading additional dashboard data…</div>}
    <section className="metrics" aria-label="Today’s sales summary">
      <article><span>Net sales today</span><strong>{currency.format(totalRevenue)}</strong></article>
      <article><span>Returns today</span><strong>{currency.format(todayReturns.reduce((sum, row) => sum + Number(row.total_amount || 0), 0))}</strong></article>
      <article><span>Transactions</span><strong>{todaySales.length}</strong></article>
      <article><span>Discounts given today</span><strong className={discountTotal > 0 ? 'warning' : ''}>{currency.format(discountTotal)}</strong></article>
      <article><span>Units received today</span><strong>{receivedUnits}</strong></article>
      <article><span>Expired units</span><strong className={expiredUnits > 0 ? 'critical' : ''}>{expiredUnits}</strong></article>
      <article><span>Low-stock drugs</span><strong>{lowStock.length}</strong></article>
      <article><span>Equipment and supplies</span><strong>{equipmentStock.reduce((count, item) => count + (item.quantity > 0 ? 1 : 0), 0)}</strong></article>
    </section>
    <section className="panel recent-transactions">
      <div className="panel-title-row">
        <h2>Recent transactions</h2>
        <span>{todaySales.length} today</span>
      </div>
      {!recentTransactions.length ? <p className="muted">No transactions have been recorded today.</p> : (
        <ul className="transaction-list">
          {recentTransactions.map((sale) => (
            <li key={sale.id}>
              <div className="transaction-main">
                <strong>{new Date(sale.sold_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</strong>
                <small>{paymentLabels[sale.payment_method] || sale.payment_method || 'Payment'} · {currency.format(sale.total_amount)}</small>
              </div>
              <div className="transaction-items">
                {sale.items.map((item) => <span key={item.id}>{item.name} <b>×{item.quantity}</b></span>)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
    <section className="dashboard-grid">
      <article className="panel"><h2>Top-selling products</h2>
        {!topDrugs.length ? <p className="muted">No sales have been recorded today.</p> : <ol className="ranked-list">{topDrugs.map((drug) => <li key={drug.id}><span><strong>{drug.name}</strong><small>{drug.quantity} units sold</small></span><strong>{currency.format(drug.revenue)}</strong></li>)}</ol>}
      </article>
      <article className="panel"><h2>Stock at or below safety level</h2>
        {!lowStock.length ? <p className="muted">All tracked products are above their safety level.</p> : <ul className="stock-list">{lowStock.map((drug) => <li key={drug.id}><span><strong>{drug.name}</strong><small>Safety stock: {drug.safetyStock}</small></span><strong className={stockStatusClass(drug.quantity)}>{stockStatusText(drug.quantity)}</strong></li>)}</ul>}
      </article>
      <article className="panel"><h2>Payment methods today</h2>
        <ul className="payment-list">{paymentSummary.map((payment) => <li key={payment.method}><span><strong>{paymentLabels[payment.method]}</strong><small>{payment.count} transaction{payment.count === 1 ? '' : 's'}</small></span><strong>{currency.format(payment.total)}</strong></li>)}</ul>
      </article>
      <article className="panel"><h2>Discounts given today</h2>
        {!todayDiscounts.length ? <p className="muted">No discounts have been given today.</p> : <>
          <div className="received-summary">
            <span><small>Discounted lines</small><strong>{todayDiscounts.length}</strong></span>
            <span><small>Value given</small><strong>{currency.format(discountTotal)}</strong></span>
          </div>
          <ul className="stock-list">{todayDiscounts.slice(0, 8).map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.name}</strong>
                <small>{row.staffName} · {roleLabel(row.staffRole)} · {currency.format(row.discountAmount)} off each</small>
              </span>
              <strong className="warning">−{currency.format(row.discountAmount * row.quantity)}</strong>
            </li>
          ))}</ul>
        </>}
      </article>
      <article className="panel"><h2>Stock received today</h2>
        {!receivedStock.length ? <p className="muted">No stock has been received today.</p> : <><div className="received-summary"><span><small>Units received</small><strong>{receivedUnits}</strong></span><span><small>Purchase value</small><strong>{currency.format(receivedCost)}</strong></span></div><ul className="stock-list">{receivedStock.map((movement) => <li key={movement.id}><span><strong>{movement.batches?.drugs?.name || 'Stock receipt'}</strong><small>{movementLabel(movement, sourceShopNames)} · {new Date(movement.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</small></span><strong>{movement.quantity} units</strong></li>)}</ul></>}
      </article>
      <article className="panel"><h2>Medical equipment and supplies</h2>
        {!equipmentStock.length ? <p className="muted">No equipment stock has been recorded for this shop.</p> : <ul className="stock-list">{equipmentStock.map((item) => <li key={item.id}><span><strong>{item.name}</strong><small>{item.category || item.unit} · Average cost {currency.format(item.averageCost)} · Selling price {currency.format(item.sellingPrice)}</small></span><strong>{item.quantity} {item.unit}</strong></li>)}</ul>}
      </article>
      <article className="panel"><h2>Expired stock requiring write-off</h2>
        {!expiredStock.length ? <p className="muted">No expired stock is currently on hand.</p> : <ul className="stock-list">{expiredStock.slice(0, 8).map((batch) => <li key={batch.id}><span><strong>{batch.drugs?.name || 'Expired drug'}</strong><small>Batch {batch.batch_number || 'No batch'} · Expired {new Date(batch.expiry_date).toLocaleDateString('en-KE')}</small></span><strong className="critical">{batch.quantity_remaining} units</strong></li>)}</ul>}
      </article>
      <article className="panel recommendations"><h2>Recommendations</h2>
        {!recommendations.length ? <p className="muted">No low-stock recommendations for this shop.</p> : <ul className="stock-list recommendation-list">{recommendations.map((insight) => {
          const parsedInsight = parseInsightMessage(insight.message);
          return <li key={insight.id}>
            <span>
              <strong>{insight.name || insight.drugs?.name || 'Inventory alert'}</strong>
              <small className="recommendation-values">
                <span><b>{parsedInsight?.stockStatus || insight.stockStatus}</b><em>stock status</em></span>
                <span><b>{insight.currentStock}</b><em>current stock</em></span>
                <span><b>{parsedInsight?.reorderPoint || insight.reorderPoint}</b><em>reorder point</em></span>
              </small>
            </span>
            <strong className={`severity-badge ${insight.severity === 'critical' ? 'critical' : 'warning'}`}>{insight.severity}</strong>
          </li>;
        })}</ul>}
      </article>
    </section>
  </main>;
}
