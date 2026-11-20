import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import './Reports.css';

const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', minimumFractionDigits: 2 });
const reportMeta = {
  sales: ['Sales report', 'Revenue, order volume, and payment mix for the selected period.'],
  purchases: ['Purchase report', 'Stock received at cost, grouped from actual supplier receipts.'],
  inventory: ['Inventory report', 'On-hand inventory at cost and the batches that need attention.'],
  expiry: ['Expiry report', 'Batches approaching or past expiry, valued at cost.'],
  profit: ['Profit & loss', 'Revenue, cost of goods sold, recorded expenses, and net profit.'],
};

function monthBounds(value) {
  const [year, month] = value.split('-').map(Number);
  return { start: new Date(year, month - 1, 1).toISOString(), end: new Date(year, month, 1).toISOString() };
}
function monthValue() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function daysUntil(dateValue) { return Math.ceil((new Date(`${dateValue}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000); }

export default function Reports({ section = 'sales', activeShopId, activeShopName, isActive = true, dataVersion = 0 }) {
  const [month, setMonth] = useState(monthValue());
  const [rows, setRows] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const meta = reportMeta[section] || reportMeta.sales;

  useEffect(() => {
    if (!activeShopId || !isActive) return undefined;
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const { start, end } = monthBounds(month);
        let nextRows = []; let nextMetrics = [];
        if (section === 'sales') {
          const { data, error: requestError } = await supabase.from('sales').select('id, total_amount, payment_method, sold_at').eq('shop_id', activeShopId).gte('sold_at', start).lt('sold_at', end).order('sold_at', { ascending: false });
          if (requestError) throw requestError;
          const total = (data || []).reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
          const cash = (data || []).filter((row) => row.payment_method === 'cash').reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
          nextRows = data || []; nextMetrics = [['Revenue', money.format(total)], ['Orders', String((data || []).length)], ['Average sale', money.format((data || []).length ? total / data.length : 0)], ['Cash collected', money.format(cash)]];
        } else if (section === 'purchases') {
          const { data, error: requestError } = await supabase.from('stock_movements').select('id, quantity, created_at, movement_type, batches(batch_number, cost_price, drugs(name))').eq('shop_id', activeShopId).eq('movement_type', 'received').gte('created_at', start).lt('created_at', end).order('created_at', { ascending: false });
          if (requestError) throw requestError;
          const value = (data || []).reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.batches?.cost_price || 0), 0);
          nextRows = data || []; nextMetrics = [['Received at cost', money.format(value)], ['Receipts', String((data || []).length)], ['Units received', String((data || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0))]];
        } else if (section === 'inventory' || section === 'expiry') {
          const { data, error: requestError } = await supabase.from('batches').select('id, batch_number, expiry_date, quantity_remaining, cost_price, selling_price, drugs(name)').eq('shop_id', activeShopId).order('expiry_date');
          if (requestError) throw requestError;
          const current = data || [];
          if (section === 'inventory') {
            nextRows = current.filter((row) => Number(row.quantity_remaining) > 0);
            const stockValue = nextRows.reduce((sum, row) => sum + Number(row.quantity_remaining || 0) * Number(row.cost_price || 0), 0);
            nextMetrics = [['Stock value at cost', money.format(stockValue)], ['Active batches', String(nextRows.length)], ['Units on hand', String(nextRows.reduce((sum, row) => sum + Number(row.quantity_remaining || 0), 0))]];
          } else {
            nextRows = current.filter((row) => Number(row.quantity_remaining) > 0 && daysUntil(row.expiry_date) <= 30);
            const expired = nextRows.filter((row) => daysUntil(row.expiry_date) < 0).length;
            nextMetrics = [['At risk at cost', money.format(nextRows.reduce((sum, row) => sum + Number(row.quantity_remaining || 0) * Number(row.cost_price || 0), 0))], ['Expired', String(expired)], ['Within 30 days', String(nextRows.filter((row) => daysUntil(row.expiry_date) >= 0).length)]];
          }
        } else {
          const [salesResult, saleItemsResult, financeResult] = await Promise.all([
            supabase.from('sales').select('id, total_amount, sold_at').eq('shop_id', activeShopId).gte('sold_at', start).lt('sold_at', end),
            supabase.from('sale_items').select('quantity, batches(cost_price), sales!inner(shop_id, sold_at)').eq('sales.shop_id', activeShopId).gte('sales.sold_at', start).lt('sales.sold_at', end),
            supabase.rpc('finance_transaction_list', { p_shop_id: activeShopId, p_kind: 'expense', p_start: month.concat('-01'), p_end: new Date(new Date(end).getTime() - 86400000).toISOString().slice(0, 10) }),
          ]);
          if (salesResult.error) throw salesResult.error; if (saleItemsResult.error) throw saleItemsResult.error; if (financeResult.error) throw financeResult.error;
          const revenue = (salesResult.data || []).reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
          const cogs = (saleItemsResult.data || []).reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.batches?.cost_price || 0), 0);
          const expenses = (financeResult.data || []).filter((row) => row.category !== 'refunds').reduce((sum, row) => sum + Number(row.amount || 0), 0);
          nextRows = [['Revenue', revenue], ['Cost of goods sold', cogs], ['Gross profit', revenue - cogs], ['Operating expenses', expenses], ['Net profit', revenue - cogs - expenses]];
          nextMetrics = [['Revenue', money.format(revenue)], ['COGS', money.format(cogs)], ['Gross profit', money.format(revenue - cogs)], ['Net profit', money.format(revenue - cogs - expenses)]];
        }
        if (!cancelled) { setRows(nextRows); setMetrics(nextMetrics); }
      } catch (loadError) { if (!cancelled) setError(loadError.message || 'Could not load this report.'); }
      finally { if (!cancelled) setLoading(false); }
    }
    load(); return () => { cancelled = true; };
  }, [activeShopId, section, month, isActive, dataVersion]);

  const table = useMemo(() => {
    if (section === 'sales') return { headers: ['Date', 'Payment', 'Sale ID', 'Amount'], rows: rows.map((row) => [new Date(row.sold_at).toLocaleDateString('en-KE'), row.payment_method || 'Other', String(row.id).slice(0, 8).toUpperCase(), money.format(Number(row.total_amount || 0))]) };
    if (section === 'purchases') return { headers: ['Received', 'Drug', 'Batch', 'Units', 'Cost value'], rows: rows.map((row) => [new Date(row.created_at).toLocaleDateString('en-KE'), row.batches?.drugs?.name || 'Drug', row.batches?.batch_number || '—', String(row.quantity), money.format(Number(row.quantity || 0) * Number(row.batches?.cost_price || 0))]) };
    if (section === 'inventory' || section === 'expiry') return { headers: ['Drug', 'Batch', 'Expiry', 'Units', 'Cost value', section === 'expiry' ? 'Status' : 'Selling value'], rows: rows.map((row) => [row.drugs?.name || 'Drug', row.batch_number || '—', new Date(`${row.expiry_date}T00:00:00`).toLocaleDateString('en-KE'), String(row.quantity_remaining), money.format(Number(row.quantity_remaining || 0) * Number(row.cost_price || 0)), section === 'expiry' ? (daysUntil(row.expiry_date) < 0 ? 'Expired' : `${daysUntil(row.expiry_date)} days`) : money.format(Number(row.quantity_remaining || 0) * Number(row.selling_price || 0))]) };
    return { headers: ['Measure', 'Amount'], rows: rows.map(([label, amount]) => [label, money.format(Number(amount || 0))]) };
  }, [rows, section]);

  return <main className="reports-page"><header className="reports-header"><div><h1>{meta[0]}</h1><p>{meta[1]} {activeShopName ? `Showing ${activeShopName}.` : ''}</p></div><label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></header>{error && <p className="report-error" role="alert">{error}</p>}<section className="report-summary">{metrics.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</section><section className="report-table"><h2>{section === 'profit' ? 'Period summary' : 'Details'}</h2>{loading ? <p className="empty-state">Loading report…</p> : table.rows.length === 0 ? <p className="empty-state">No data for this period.</p> : <div className="table-wrap"><table><thead><tr>{table.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}</section></main>;
}
