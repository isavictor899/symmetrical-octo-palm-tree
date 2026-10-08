import { useEffect, useMemo, useState } from 'react';
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
  return [...rows].filter((row) => row.quantity > 0).sort((a, b) => a.quantity - b.quantity || a.amount - b.amount).slice(0, count);
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

export default function MonthlyReport({ organizationShops = [], dataVersion = 0 }) {
  const [month, setMonth] = useState(currentMonthValue());
  const [shops, setShops] = useState(organizationShops);
  const [sales, setSales] = useState([]);
  const [saleItems, setSaleItems] = useState([]);
  const [movements, setMovements] = useState([]);
  const [currentInventory, setCurrentInventory] = useState([]);
  const [sourceShopNames, setSourceShopNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (organizationShops.length) setShops(organizationShops);
  }, [organizationShops]);

  useEffect(() => {
    let cancelled = false;

    async function loadReport() {
      try {
        setLoading(true);
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

        const [salesResult, saleItemsResult, movementResult, inventoryResult] = await Promise.all([
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
            .select('shop_id, drug_id, quantity_remaining, selling_price, expiry_date, drugs(name, generic_name)')
            .in('shop_id', shopIds),
        ]);

        if (salesResult.error) throw salesResult.error;
        if (saleItemsResult.error) throw saleItemsResult.error;
        if (inventoryResult.error) throw inventoryResult.error;

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
          setSaleItems(saleItemsResult.data || []);
          setMovements(movementRows);
          setCurrentInventory(inventoryResult.data || []);
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
  }, [month, organizationShops, dataVersion]);

  const report = useMemo(() => {
    const shopMap = new Map(shops.map((shop) => [shop.id, emptyShopReport(shop)]));

    for (const sale of sales) {
      const row = shopMap.get(sale.shop_id);
      if (!row) continue;
      row.salesTotal += Number(sale.total_amount || 0);
      row.transactions += 1;
    }

    for (const item of saleItems) {
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

    return {
      shopRows: [...shopMap.values()],
      totalSales: sales.reduce((total, sale) => total + Number(sale.total_amount || 0), 0),
      transactions: sales.length,
      unitsSold: saleItems.reduce((total, item) => total + Number(item.quantity || 0), 0),
      receivedUnits: movements.filter((row) => row.movement_type === 'received').reduce((total, row) => total + Number(row.quantity || 0), 0),
      transferredOutUnits: movements.filter((row) => row.movement_type === 'transfer_out').reduce((total, row) => total + Number(row.quantity || 0), 0),
      topSelling: topRows(soldDrugs),
      leastSelling: leastRows(soldDrugs),
      receivedDrugs: topRows(receivedDrugs, 10),
      transferOutDrugs: topRows(transferOutDrugs, 10),
      inventoryDrugs: topRows(inventoryDrugs, 12),
      paymentRows: Object.values(paymentSummary).sort((a, b) => b.amount - a.amount),
      transferRows: movements.filter((row) => row.movement_type === 'transfer_out' || row.movement_type === 'transfer_in'),
    };
  }, [shops, sales, saleItems, movements, currentInventory]);

  const { label } = monthRange(month);

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

      <section className="report-metrics" aria-label="Monthly organization summary">
        <article><span>Total sales</span><strong>{currency.format(report.totalSales)}</strong></article>
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
        <DrugPanel title="Drugs bought / received" rows={report.receivedDrugs} empty="No supplier stock receipts this month." showAmount />
        <DrugPanel title="Current organization stock" rows={report.inventoryDrugs} empty="No current stock found." showAmount amountLabel="Stock value" />

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

