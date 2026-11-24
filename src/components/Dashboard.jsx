import { useEffect, useMemo, useState, useRef } from 'react';
import { useRefreshGate } from '../lib/useRefreshGate';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import { defaultBrandColor, applyBrandTheme } from '../lib/theme';
import {
  IconAlertTriangle,
  IconCalendarExclamation,
  IconCash,
  IconChartBar,
  IconDiscount,
  IconFilePlus,
  IconMedicalCross,
  IconPackageImport,
  IconPill,
  IconReceipt2,
  IconShoppingCart,
} from '@tabler/icons-react';
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

export default function Dashboard({ activeShopId, activeShopName, organizationShops = [], onActiveShopChange, onNavigatePage, dataVersion = 0, isActive = true }) {
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
  const [supplierDebtSummary, setSupplierDebtSummary] = useState({ amount: 0, count: 0 });
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
          const [itemsResult, batchesResult, policyResult, receivedResult, equipmentResult, equipmentSalesResult, returnsResult, discountsResult, debtSummaryResult] = await Promise.all([
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
            supabase.rpc('supplier_debt_summary', { p_shop_id: selectedShopId }),
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
          if (debtSummaryResult.error) throw debtSummaryResult.error;

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
            setSupplierDebtSummary(debtSummaryResult.data || { amount: 0, count: 0 });
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
  const supplierReceipts = useMemo(() => receivedStock.filter((movement) => movement.movement_type === 'received'), [receivedStock]);
  const receivedUnits = useMemo(
    () => receivedStock.reduce((total, movement) => total + Number(movement.quantity || 0), 0),
    [receivedStock]
  );
  const receivedCost = useMemo(
    () => supplierReceipts.reduce((total, movement) => total + Number(movement.quantity || 0) * Number(movement.batches?.cost_price || 0), 0),
    [supplierReceipts]
  );
  const expiredUnits = useMemo(() => expiredStock.reduce(
    (total, batch) => total + Number(batch.quantity_remaining || 0), 0
  ), [expiredStock]);
  const discountTotal = useMemo(
    () => todayDiscounts.reduce((total, row) => total + row.discountAmount * row.quantity, 0),
    [todayDiscounts]
  );

  if (loading) return <main className="dashboard"><p>Loading dashboard…</p></main>;
  if (error) return <main className="dashboard"><p className="error">{error}</p></main>;

  const quickActions = [
    { label: 'New sale', page: 'sale', icon: IconShoppingCart, tone: 'lime' },
    { label: 'Stocked drugs', page: 'stockedDrugs', icon: IconPill, tone: 'blue' },
    { label: 'Receive stock', page: 'receive', icon: IconPackageImport, tone: 'green' },
    { label: 'Purchase orders', page: 'purchaseOrders', icon: IconFilePlus, tone: 'amber' },
    { label: 'Sales report', page: 'salesReport', icon: IconChartBar, tone: 'slate' },
    { label: 'Expiry review', page: 'expiryReport', icon: IconCalendarExclamation, tone: 'red' },
  ];
  const todayReturnTotal = todayReturns.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const stockedEquipmentCount = equipmentStock.filter((item) => item.quantity > 0).length;
  const metrics = [
    { label: 'Net sales today', value: currency.format(totalRevenue), icon: IconCash, tone: 'green' },
    { label: 'Transactions', value: todaySales.length, icon: IconReceipt2, tone: 'blue' },
    { label: 'Returns today', value: currency.format(todayReturnTotal), icon: IconShoppingCart, tone: 'amber' },
    { label: 'Discounts given', value: currency.format(discountTotal), icon: IconDiscount, tone: discountTotal > 0 ? 'amber' : 'slate' },
    { label: 'Low-stock drugs', value: lowStock.length, icon: IconAlertTriangle, tone: lowStock.length ? 'amber' : 'green' },
    { label: 'Units received', value: receivedUnits, icon: IconPackageImport, tone: 'blue' },
    { label: 'Expired units', value: expiredUnits, icon: IconCalendarExclamation, tone: expiredUnits ? 'red' : 'green' },
    { label: 'Equipment in stock', value: stockedEquipmentCount, icon: IconMedicalCross, tone: 'slate' },
  ];

  return <main className="dashboard">
    <header className="dashboard-heading"><div><h1>Dashboard</h1><p className="dashboard-subtitle">Your pharmacy overview for today.</p></div><time>{new Date().toLocaleDateString('en-KE', { dateStyle: 'full' })}</time></header>
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
    {loadingMore && <div className="loading-more" role="status">Updating shop activity…</div>}
    <section className="dashboard-actions" aria-labelledby="quick-actions-title">
      <div className="dashboard-section-heading"><h2 id="quick-actions-title">Quick actions</h2><span>Common tasks</span></div>
      <div className="dashboard-action-grid">
        {quickActions.map(({ label, page: targetPage, icon: Icon, tone }) => <button key={targetPage} type="button" className="quick-action" onClick={() => onNavigatePage?.(targetPage)}>
          <span className={`quick-action-icon tone-${tone}`}><Icon size={21} stroke={1.8} aria-hidden="true" /></span>
          <span>{label}</span>
        </button>)}
      </div>
    </section>
    <section className="dashboard-metrics" aria-label="Today’s pharmacy summary">
      {metrics.map(({ label, value, icon: Icon, tone }) => <article className="dashboard-metric" key={label}>
        <div><span>{label}</span><i className={`tone-${tone}`}><Icon size={19} stroke={1.8} aria-hidden="true" /></i></div>
        <strong>{value}</strong>
        <small className={label === 'Expired units' && expiredUnits ? 'metric-danger' : label === 'Low-stock drugs' && lowStock.length ? 'metric-attention' : ''}>
          {label === 'Net sales today' ? `${todaySales.length} sale${todaySales.length === 1 ? '' : 's'} recorded` : null}
          {label === 'Transactions' ? 'Today' : null}
          {label === 'Returns today' ? `${todayReturns.length} return${todayReturns.length === 1 ? '' : 's'} recorded` : null}
          {label === 'Discounts given' ? `${todayDiscounts.length} discounted line${todayDiscounts.length === 1 ? '' : 's'}` : null}
          {label === 'Low-stock drugs' ? (lowStock.length ? 'Needs attention' : 'No stock alerts') : null}
          {label === 'Units received' ? 'Received today' : null}
          {label === 'Expired units' ? (expiredUnits ? 'Requires review' : 'No expired units') : null}
          {label === 'Equipment in stock' ? 'Equipment & supplies' : null}
        </small>
      </article>)}
    </section>
    <section className="dashboard-panels" aria-label="Shop activity and stock">
      <article className="dashboard-panel">
        <div className="dashboard-section-heading"><div><h2>Stock needing attention</h2><p>Drugs at or below their reorder level</p></div><button className="dashboard-text-action" type="button" onClick={() => onNavigatePage?.('stockedDrugs')}>View stock <IconChartBar size={15} /></button></div>
        <div className="dashboard-table-wrap"><table><thead><tr><th>Drug</th><th>In stock</th><th>Reorder at</th></tr></thead><tbody>
          {lowStock.map((drug) => <tr key={drug.id}><td><strong>{drug.name}</strong></td><td><span className="stock-critical">{drug.quantity}</span></td><td>{drug.safetyStock} units</td></tr>)}
          {!lowStock.length && <tr><td colSpan={3} className="dashboard-empty">All tracked drugs are above their safety level.</td></tr>}
        </tbody></table></div>
      </article>
      <article className="dashboard-panel">
        <div className="dashboard-section-heading"><div><h2>Recent sales</h2><p>Latest transactions from {shopName || 'this shop'}</p></div><button className="dashboard-text-action" type="button" onClick={() => onNavigatePage?.('sale')}>Open sales <IconChartBar size={15} /></button></div>
        {!recentTransactions.length ? <p className="muted dashboard-empty-copy">No transactions have been recorded today.</p> : <ul className="dashboard-recent-list">{recentTransactions.slice(0, 5).map((sale) => <li key={sale.id}>
          <span className="recent-icon"><IconReceipt2 size={16} stroke={1.8} /></span>
          <span className="recent-description"><strong>Sale {String(sale.id).slice(0, 8).toUpperCase()}</strong><small>{sale.items.map((item) => `${item.name} ×${item.quantity}`).join(' · ')}</small></span>
          <span className="recent-amount"><strong>{currency.format(sale.total_amount)}</strong><small>{new Date(sale.sold_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })} · {paymentLabels[sale.payment_method] || sale.payment_method || 'Payment'}</small></span>
        </li>)}</ul>}
      </article>
      <article className="dashboard-panel">
        <div className="dashboard-section-heading"><div><h2>Top-selling products</h2><p>Based on today’s sales</p></div><IconChartBar className="dashboard-heading-icon" /></div>
        {!topDrugs.length ? <p className="muted dashboard-empty-copy">No product sales recorded today.</p> : <ol className="dashboard-ranked-list">{topDrugs.slice(0, 5).map((drug, index) => <li key={drug.id}><span className="rank">{index + 1}</span><span><strong>{drug.name}</strong><small>{drug.quantity} units sold</small></span><b>{currency.format(drug.revenue)}</b></li>)}</ol>}
      </article>
      <article className="dashboard-panel">
        <div className="dashboard-section-heading"><div><h2>Equipment &amp; supplies</h2><p>Stock held at {shopName || 'this shop'}</p></div><IconMedicalCross className="dashboard-heading-icon" /></div>
        {!equipmentStock.filter((item) => item.quantity > 0).length ? <p className="muted dashboard-empty-copy">No equipment currently in stock at this shop.</p> : <ul className="dashboard-equipment-list">{equipmentStock.filter((item) => item.quantity > 0).slice(0, 5).map((item) => <li key={item.id}><span><strong>{item.name}</strong><small>{item.category || item.unit}</small></span><b>{item.quantity} {item.unit}</b></li>)}</ul>}
      </article>
    </section>
    <section className="dashboard-details" aria-label="More shop details">
      <article className="dashboard-panel"><h2>Payment methods today</h2>
        <ul className="dashboard-list">{paymentSummary.map((payment) => <li key={payment.method}><span><strong>{paymentLabels[payment.method]}</strong><small>{payment.count} transaction{payment.count === 1 ? '' : 's'}</small></span><strong>{currency.format(payment.total)}</strong></li>)}</ul>
      </article>
      <article className="dashboard-panel"><div className="dashboard-section-heading"><div><h2>Supplier debts</h2><p>Unpaid stock receipts at {shopName || 'this shop'}</p></div><button className="dashboard-text-action" type="button" onClick={() => onNavigatePage?.('supplierDebts')}>Review debts <IconChartBar size={15} /></button></div>
        <div className="received-summary"><span><small>Amount due</small><strong>{currency.format(Number(supplierDebtSummary.amount || 0))}</strong></span><span><small>Unpaid receipts</small><strong>{supplierDebtSummary.count || 0}</strong></span></div>
      </article>
      <article className="dashboard-panel"><div className="dashboard-section-heading"><h2>Stock received today</h2><button className="dashboard-text-action" type="button" onClick={() => onNavigatePage?.('supplierDebts')}>Supplier debts <IconChartBar size={15} /></button></div>
        {!receivedStock.length ? <p className="muted dashboard-empty-copy">No stock has been received today.</p> : <><div className="received-summary"><span><small>Units received</small><strong>{receivedUnits}</strong></span><span><small>Supplier purchase value</small><strong>{currency.format(receivedCost)}</strong></span></div><ul className="dashboard-list">{receivedStock.slice(0, 6).map((movement) => <li key={movement.id}><span><strong>{movement.batches?.drugs?.name || 'Stock receipt'}</strong><small>{movementLabel(movement, sourceShopNames)} · {new Date(movement.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</small></span><strong>{movement.quantity} units</strong></li>)}</ul></>}
      </article>
      <article className="dashboard-panel"><h2>Discounts given today</h2>
        {!todayDiscounts.length ? <p className="muted">No discounts have been given today.</p> : <>
          <div className="received-summary">
            <span><small>Discounted lines</small><strong>{todayDiscounts.length}</strong></span>
            <span><small>Value given</small><strong>{currency.format(discountTotal)}</strong></span>
          </div>
          <ul className="dashboard-list">{todayDiscounts.slice(0, 6).map((row) => (
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
      <article className="dashboard-panel"><div className="dashboard-section-heading"><div><h2>Expired stock for write-off</h2><p>Expired batches with units remaining</p></div><button className="dashboard-text-action" type="button" onClick={() => onNavigatePage?.('expiryReport')}>Review expiry <IconCalendarExclamation size={15} /></button></div>
        {!expiredStock.length ? <p className="muted dashboard-empty-copy">No expired stock is currently on hand.</p> : <ul className="dashboard-list">{expiredStock.slice(0, 6).map((batch) => <li key={batch.id}><span><strong>{batch.drugs?.name || 'Expired drug'}</strong><small>Batch {batch.batch_number || 'No batch'} · Expired {new Date(batch.expiry_date).toLocaleDateString('en-KE')}</small></span><strong className="critical">{batch.quantity_remaining} units</strong></li>)}</ul>}
      </article>
      <article className="dashboard-panel dashboard-recommendations"><div className="dashboard-section-heading"><div><h2>Stock recommendations</h2><p>Actions from this shop’s current stock position</p></div></div>
        {!recommendations.length ? <p className="muted dashboard-empty-copy">No low-stock recommendations for this shop.</p> : <ul className="dashboard-list recommendation-list">{recommendations.map((insight) => {
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
