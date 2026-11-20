import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import './Finance.css';

const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', minimumFractionDigits: 2 });
const paymentLabels = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', other: 'Other' };
const titles = {
  expenses: ['Expenses', 'Paid supplier stock and the operating costs you record.'],
  income: ['Income', 'Sales revenue plus other income recorded by the owner.'],
  transactions: ['Financial transactions', 'A complete, shop-specific cash-flow trail.'],
  register: ['Cash register', 'Open your drawer, count it at close, and record the difference.'],
};

function startOfMonth() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
}

export default function Finance({ section = 'transactions', activeShopId, activeShopName, staffRole, isActive = true, dataVersion = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [register, setRegister] = useState(null);
  const [openingFloat, setOpeningFloat] = useState('0');
  const [countedCash, setCountedCash] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ category: '', description: '', amount: '', paymentMethod: 'other' });
  const title = titles[section] || titles.transactions;
  const kind = section === 'expenses' ? 'expense' : section === 'income' ? 'income' : 'all';
  const canManage = isAdminRole(staffRole);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [row.description, row.category, row.payment_method, row.source_type]
      .some((value) => String(value || '').toLowerCase().includes(term)));
  }, [rows, search]);

  const totals = useMemo(() => rows.reduce((summary, row) => {
    const amount = Number(row.amount || 0);
    if (row.entry_type === 'income') summary.income += amount;
    else summary.expense += amount;
    return summary;
  }, { income: 0, expense: 0 }), [rows]);

  async function loadTransactions() {
    if (!activeShopId || !isActive) return;
    setLoading(true);
    try {
      const { data, error: requestError } = await supabase.rpc('finance_transaction_list', {
        p_shop_id: activeShopId,
        p_kind: kind,
        p_start: null,
        p_end: null,
      });
      if (requestError) throw requestError;
      setRows(Array.isArray(data) ? data : []);
      setError('');
    } catch (loadError) {
      setError(loadError.message || 'Could not load financial records. Apply the finance migration and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function loadRegister() {
    if (!activeShopId || !isActive) return;
    setLoading(true);
    try {
      const { data, error: requestError } = await supabase.rpc('cash_register_current', { p_shop_id: activeShopId });
      if (requestError) throw requestError;
      setRegister(data || null);
      setError('');
    } catch (loadError) {
      setError(loadError.message || 'Could not load the cash register. Apply the finance migration and try again.');
    } finally { setLoading(false); }
  }

  useEffect(() => {
    setRows([]); setRegister(null); setError(''); setMessage(''); setSearch('');
    if (section === 'register') loadRegister(); else loadTransactions();
  }, [activeShopId, section, kind, isActive, dataVersion]);

  async function createEntry(event) {
    event.preventDefault();
    if (!activeShopId || saving) return;
    if (!form.category.trim() || !form.description.trim() || Number(form.amount) <= 0) {
      setError('Enter a category, description, and positive amount.');
      return;
    }
    setSaving(true); setError(''); setMessage('');
    try {
      const { error: saveError } = await supabase.rpc('create_finance_entry', {
        p_shop_id: activeShopId,
        p_entry_type: section === 'expenses' ? 'expense' : 'income',
        p_category: form.category.trim(),
        p_description: form.description.trim(),
        p_amount: Number(form.amount),
        p_payment_method: form.paymentMethod,
        p_occurred_at: new Date().toISOString(),
      });
      if (saveError) throw saveError;
      setForm({ category: '', description: '', amount: '', paymentMethod: 'other' });
      setMessage(`${section === 'expenses' ? 'Expense' : 'Income'} recorded.`);
      await loadTransactions();
    } catch (saveError) { setError(saveError.message || 'Could not record this financial entry.'); }
    finally { setSaving(false); }
  }

  async function openRegister(event) {
    event.preventDefault();
    if (!activeShopId || saving || Number(openingFloat) < 0) return;
    setSaving(true); setError('');
    try {
      const { data, error: openError } = await supabase.rpc('open_cash_register', { p_shop_id: activeShopId, p_opening_float: Number(openingFloat) });
      if (openError) throw openError;
      setRegister(data || null); setMessage('Cash register opened. Cash sales and refunds now contribute to your expected cash.');
    } catch (openError) { setError(openError.message || 'Could not open the cash register.'); }
    finally { setSaving(false); }
  }

  async function closeRegister(event) {
    event.preventDefault();
    if (!activeShopId || saving || countedCash === '' || Number(countedCash) < 0) { setError('Enter the cash you counted before closing the register.'); return; }
    setSaving(true); setError('');
    try {
      const { data, error: closeError } = await supabase.rpc('close_cash_register', { p_shop_id: activeShopId, p_counted_cash: Number(countedCash), p_closing_note: note.trim() || null });
      if (closeError) throw closeError;
      const variance = Number(data?.variance || 0);
      setMessage(`Register closed. ${variance === 0 ? 'Count matched the expected cash.' : `Variance: ${money.format(variance)}.`}`);
      setRegister(null); setCountedCash(''); setNote('');
    } catch (closeError) { setError(closeError.message || 'Could not close the cash register.'); }
    finally { setSaving(false); }
  }

  if (!activeShopId) return <main className="finance-page"><p className="empty-state">Select a shop to view finance.</p></main>;

  if (section === 'register') return <main className="finance-page">
    <header className="finance-header"><div><h1>{title[0]}</h1><p>{title[1]} {activeShopName ? `Working in ${activeShopName}.` : ''}</p></div></header>
    {error && <p className="finance-notice danger" role="alert">{error}</p>}{message && <p className="finance-notice success">{message}</p>}
    {loading ? <p className="empty-state">Loading register…</p> : register ? <section className="register-layout">
      <div className="register-ledger"><span>Open since</span><strong>{new Date(register.opened_at).toLocaleString('en-KE')}</strong><span>Opening float</span><strong className="tnum">{money.format(Number(register.opening_float || 0))}</strong><span>Expected cash</span><strong className="tnum register-total">{money.format(Number(register.expected_cash || 0))}</strong><p>Expected cash includes cash sales, cash refunds, and cash finance entries recorded after this drawer was opened.</p></div>
      <form className="finance-form" onSubmit={closeRegister}><h2>Close register</h2><label>Counted cash (KES)<input autoFocus required min="0" step="0.01" type="number" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} /></label><label>Closing note <span>optional</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Explain a difference or handover." /></label><button className="finance-primary" disabled={saving}>{saving ? 'Closing…' : 'Close and reconcile'}</button></form>
    </section> : <section className="register-layout"><div className="register-ledger"><span>Before you start</span><strong>Open a cash drawer</strong><p>Enter the physical cash left in the drawer. The system will track cash activity from this point until you close it.</p></div><form className="finance-form" onSubmit={openRegister}><h2>Start shift</h2><label>Opening cash (KES)<input autoFocus required min="0" step="0.01" type="number" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} /></label><button className="finance-primary" disabled={saving}>{saving ? 'Opening…' : 'Open cash register'}</button></form></section>}
  </main>;

  return <main className="finance-page">
    <header className="finance-header"><div><h1>{title[0]}</h1><p>{title[1]} {activeShopName ? `Showing ${activeShopName}.` : ''}</p></div></header>
    {error && <p className="finance-notice danger" role="alert">{error}</p>}{message && <p className="finance-notice success">{message}</p>}
    <section className="finance-metrics"><article><span>{section === 'expenses' ? 'Recorded expenses' : section === 'income' ? 'Recorded income' : 'Income'}</span><strong className={section === 'expenses' ? 'negative' : 'positive'}>{money.format(section === 'expenses' ? totals.expense : totals.income)}</strong></article><article><span>{section === 'transactions' ? 'Expenses' : 'This month'}</span><strong className="tnum">{section === 'transactions' ? money.format(totals.expense) : rows.filter((row) => String(row.occurred_at || '').slice(0, 7) === startOfMonth().slice(0, 7)).length}</strong></article>{section === 'transactions' && <article><span>Net cash flow</span><strong className={totals.income - totals.expense >= 0 ? 'positive' : 'negative'}>{money.format(totals.income - totals.expense)}</strong></article>}</section>
    {(section === 'expenses' || section === 'income') && canManage && <section className="finance-entry-panel"><div><h2>Add {section === 'expenses' ? 'expense' : 'income'}</h2><p>Manual entries are kept separate from sales and paid stock receipts.</p></div><form className="finance-form inline" onSubmit={createEntry}><label>Category<input required value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} placeholder={section === 'expenses' ? 'e.g. Rent or salary' : 'e.g. Delivery service'} /></label><label>Description<input required value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="What was this for?" /></label><label>Amount (KES)<input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} /></label><label>Method<select value={form.paymentMethod} onChange={(event) => setForm((current) => ({ ...current, paymentMethod: event.target.value }))}>{Object.entries(paymentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="finance-primary" disabled={saving}>{saving ? 'Saving…' : 'Record entry'}</button></form></section>}
    {(section === 'expenses' || section === 'income') && !canManage && <p className="finance-access-note">Only an owner or administrator can add manual financial entries. Sales and paid stock costs still appear here automatically.</p>}
    <section className="finance-list"><div className="finance-list-head"><h2>{section === 'transactions' ? 'Activity' : 'Entries'}</h2><label className="finance-search">Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Description or category" /></label></div>{loading ? <p className="empty-state">Loading financial records…</p> : filteredRows.length === 0 ? <p className="empty-state">No financial records match this view yet.</p> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Method</th><th>Source</th><th>Amount</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={`${row.source_type}-${row.id}`}><td>{new Date(row.occurred_at).toLocaleDateString('en-KE')}</td><td><strong>{row.description}</strong></td><td>{row.category}</td><td>{paymentLabels[row.payment_method] || row.payment_method || 'Other'}</td><td>{String(row.source_type || 'manual').replaceAll('_', ' ')}</td><td className={row.entry_type === 'income' ? 'amount positive' : 'amount negative'}>{row.entry_type === 'income' ? '+' : '−'}{money.format(Number(row.amount || 0))}</td></tr>)}</tbody></table></div>}</section>
  </main>;
}
