import { useEffect, useMemo, useState } from 'react';
import { usePowerSync, useStatus } from '@powersync/react';
import {
  IconBrandWhatsapp,
  IconCheck,
  IconCircle,
  IconCopy,
  IconMail,
  IconPhone,
} from '@tabler/icons-react';
import { supabase } from '../lib/supabaseClient';
import { canReceiveStock, isAdminRole } from '../lib/roles';
import { getDeviceReceiptWidth, hasPrintedTestReceipt } from '../lib/receipt';
import { APP_BUILD, emailLink, SUPPORT, whatsappLink } from '../lib/support';
import './Help.css';

// audience: 'all' | 'stock' (pharmacists and admins) | 'admin'
const FAQ = [
  {
    audience: 'all',
    q: 'How do I make a sale?',
    a: 'Open New sale, search for the drug or scan its barcode, and add it to the cart. The batch closest to expiry is chosen for you. Choose the payment method and press Complete sale. Prescription-only (POM) drugs need the prescription reference, prescriber and date before the sale can be completed.',
  },
  {
    audience: 'all',
    q: 'Can I sell when the internet is down?',
    a: 'Yes. Sales are saved on this device and marked as waiting to sync. They upload automatically when the internet is back. Do not clear the browser\'s data or uninstall the app while sales are waiting, or they will be lost.',
  },
  {
    audience: 'all',
    q: 'A sale says it needs attention. What do I do?',
    a: 'The server refused it, and the message says why (for example, not enough stock, or a missing prescription detail). If the customer is still with you, fix it and press Retry, or Cancel if they did not take the medicine. If the medicine was already handed over, press Send to admin. Sales left unresolved for 15 minutes go to the administrator automatically, so nothing is lost.',
  },
  {
    audience: 'admin',
    q: 'What is Sales review?',
    a: 'Held sales are offline sales the server refused when they synced, usually because they were more than 7 days old or the stock records had run out. Approve records the sale and reduces stock; Void drops it with a reason. Sales to check were recorded normally but reached the server late, or were uploaded from a different login than the cashier credited. Compare them with your cash or M-Pesa records, then mark them checked. The bell shows when there is something to review.',
  },
  {
    audience: 'all',
    q: 'How do I print or reprint a receipt?',
    a: 'After a sale, press Print receipt. To print one again later, open New sale, press Reprint receipt and search by the receipt number. Reprints are marked COPY.',
  },
  {
    audience: 'all',
    q: 'The receipt is the wrong width or wastes paper.',
    a: 'Go to Settings > This device\'s receipt printer, choose 58mm or 80mm, and press Print test receipt. In the print window choose the receipt printer, set the paper size to the same width, set Margins to None and untick Headers and footers. The browser remembers these settings.',
  },
  {
    audience: 'all',
    q: 'Nothing happens when I press Print.',
    a: 'The browser has probably blocked the receipt window. Look for a blocked pop-up icon in the address bar, allow pop-ups for this site, and press Print again.',
  },
  {
    audience: 'all',
    q: 'How do I use a barcode scanner?',
    a: 'Plug in a USB scanner (or pair a Bluetooth one) and scan on the New sale page. You hear a short beep when the drug is added. A low tone means the barcode is not linked yet or did not read correctly: scan again, or ask a pharmacist to link it.',
  },
  {
    audience: 'all',
    q: 'I forgot my password.',
    a: 'Ask your administrator to press Reset password for you on the Staff page. They will give you a temporary password, and you will choose your own when you sign in. Administrators who are locked out should contact support.',
  },
  {
    audience: 'stock',
    q: 'How do I receive new stock?',
    a: 'Open Receive stock and enter the drug, batch number, expiry date, cost price, selling price and quantity. The first time a drug is received in a shop you must classify it as POM or OTC.',
  },
  {
    audience: 'stock',
    q: 'How do I count stock?',
    a: 'Open Stocked drugs and press Count stock on a drug. Count what is on the shelf for each batch. Any difference needs a reason and is recorded with your name. Let waiting sales sync before counting a batch, or the count will look short.',
  },
  {
    audience: 'stock',
    q: 'How do I link a barcode to a drug?',
    a: 'Open Stocked drugs, press Batches & barcodes on the drug, and scan a pack into the barcode box. You can also link it during a sale when an unknown barcode is scanned. Remove a wrong link with the × next to it.',
  },
  {
    audience: 'stock',
    q: 'How do I handle a customer return?',
    a: 'Open Sales returns, find the sale and choose the item and quantity. Pharmacists can process returns within 7 days, refunded the same way the customer paid; older returns need an administrator. Expired returned stock is not put back on the shelf.',
  },
  {
    audience: 'admin',
    q: 'How do I add staff or remove someone who left?',
    a: 'Open Staff. Add staff member creates their login and shows a temporary password once. When someone leaves, press Deactivate: they can no longer sign in, and their past sales stay on record.',
  },
  {
    audience: 'admin',
    q: 'How do I add a shop or put our KRA PIN on receipts?',
    a: 'Open Settings > Shops. Use Add shop for a new branch, or edit a shop\'s address, phone, KRA PIN, PPB licence number and receipt footer.',
  },
  {
    audience: 'admin',
    q: 'Is the receipt a KRA tax invoice?',
    a: 'No. Receipts say "This is not a tax invoice". Electronic tax invoices need KRA eTIMS, which is not connected yet.',
  },
];

function nairobiTime(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
}

function roleLabel(role) {
  if (isAdminRole(role)) return 'Administrator';
  if (role === 'pharmacist') return 'Pharmacist';
  if (role === 'cashier') return 'Cashier';
  return role || 'Unknown';
}

async function countLocal(db, table) {
  try {
    const rows = await db.getAll(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`);
    return rows.reduce((totals, row) => {
      if (row.status === 'failed') totals.failed += Number(row.n);
      else totals.waiting += Number(row.n);
      return totals;
    }, { waiting: 0, failed: 0 });
  } catch {
    return { waiting: 0, failed: 0 };
  }
}

async function countRows(table, filter) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  return error ? null : count || 0;
}

export default function Help({ staffRole, staffName = '', activeShop = null, activeShopId = null, onNavigatePage }) {
  const db = usePowerSync();
  const syncStatus = useStatus();
  const admin = isAdminRole(staffRole);
  const stockRole = canReceiveStock(staffRole);

  const [email, setEmail] = useState('');
  const [queues, setQueues] = useState({ sales: { waiting: 0, failed: 0 }, receipts: { waiting: 0, failed: 0 } });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [checklist, setChecklist] = useState(null);
  const [faqSearch, setFaqSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setEmail(data.session?.user?.email || '');
    });
    Promise.all([countLocal(db, 'pending_sales'), countLocal(db, 'pending_receipts')]).then(([sales, receipts]) => {
      if (!cancelled) setQueues({ sales, receipts });
    });
    return () => { cancelled = true; };
  }, [db]);

  // Setup checklist for administrators (needs the internet).
  useEffect(() => {
    if (!admin || !activeShopId) return undefined;
    let cancelled = false;
    (async () => {
      const [staffCount, batchCount, barcodeCount] = await Promise.all([
        countRows('staff'),
        countRows('batches', (query) => query.eq('shop_id', activeShopId)),
        countRows('drug_barcodes'),
      ]);
      if (cancelled) return;
      const shopReady = Boolean(activeShop?.location && activeShop?.phone && activeShop?.kra_pin && activeShop?.ppb_licence_no);
      setChecklist([
        { key: 'shop', done: shopReady, label: 'Add shop details for receipts', detail: 'Address, phone, KRA PIN and PPB licence number.', page: 'settings' },
        { key: 'staff', done: staffCount !== null && staffCount > 1, label: 'Add your staff', detail: 'Give each person their own login. Never share one.', page: 'staff' },
        { key: 'stock', done: batchCount !== null && batchCount > 0, label: `Receive stock into ${activeShop?.name || 'this shop'}`, detail: 'Record what is on the shelves, with batch numbers and expiry dates.', page: 'receive' },
        { key: 'barcodes', done: barcodeCount !== null && barcodeCount > 0, label: 'Link barcodes (if you use a scanner)', detail: 'Scan one pack of each drug on Stocked drugs.', page: 'stockedDrugs' },
        { key: 'printer', done: hasPrintedTestReceipt(), label: 'Print a test receipt on this device', detail: 'Settings > This device\'s receipt printer.', page: 'settings' },
      ]);
    })();
    return () => { cancelled = true; };
  }, [admin, activeShopId, activeShop]);

  const diagnostics = useMemo(() => {
    const standalone = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
    const deviceWidth = getDeviceReceiptWidth();
    return [
      'Pharmacy POS diagnostic info',
      `App build: ${APP_BUILD}`,
      `Time: ${nairobiTime(new Date())}`,
      `Signed in as: ${email || 'unknown'} (${roleLabel(staffRole)})`,
      `Shop: ${activeShop?.name || 'none'}${activeShopId ? ` [${String(activeShopId).slice(0, 8)}]` : ''}`,
      `Internet: ${typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online'}`,
      `Sync: ${syncStatus?.connected ? 'connected' : 'not connected'}, last synced ${nairobiTime(syncStatus?.lastSyncedAt)}`,
      `Sales waiting to sync: ${queues.sales.waiting}, failed: ${queues.sales.failed}`,
      `Stock receipts waiting to sync: ${queues.receipts.waiting}, failed: ${queues.receipts.failed}`,
      `Receipt paper: ${deviceWidth ? `${deviceWidth} (this device)` : `${activeShop?.receipt_paper_width || '80mm'} (shop default)`}`,
      `Installed app: ${standalone ? 'yes' : 'no (browser tab)'}`,
      `Screen: ${typeof window !== 'undefined' ? `${window.screen.width}x${window.screen.height}` : 'unknown'}`,
      `Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    ].join('\n');
  }, [email, staffRole, activeShop, activeShopId, syncStatus, queues]);

  const whatsappMessage = [
    `Hello ${SUPPORT.company}, I need help with Pharmacy POS.`,
    `Name: ${staffName || 'not set'}`,
    `Shop: ${activeShop?.name || 'not set'}`,
    `App build: ${APP_BUILD}`,
    '',
    'Problem: ',
  ].join('\n');

  const emailBody = `Please describe the problem here:\n\n\n\n---\n${diagnostics}\n`;

  async function copyDiagnostics() {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError('Copying is blocked on this device. Select the text below and copy it instead.');
    }
  }

  const visibleFaq = FAQ.filter((item) => item.audience === 'all'
    || (item.audience === 'stock' && stockRole)
    || (item.audience === 'admin' && admin))
    .filter((item) => {
      const term = faqSearch.trim().toLowerCase();
      return !term || item.q.toLowerCase().includes(term) || item.a.toLowerCase().includes(term);
    });

  const doneCount = checklist?.filter((item) => item.done).length || 0;
  const hasFailures = queues.sales.failed > 0 || queues.receipts.failed > 0;

  return (
    <div className="page-panel help-page">
      <div className="section-header">
        <div>
          <h2>Help & support</h2>
          <p className="muted">Answers to common questions, and how to reach {SUPPORT.company} when you need a person.</p>
        </div>
      </div>

      <section className="help-contact" aria-labelledby="help-contact-title">
        <h3 id="help-contact-title">Contact support</h3>
        <div className="help-contact-actions">
          {SUPPORT.whatsapp ? (
            <a className="help-contact-button whatsapp" href={whatsappLink(whatsappMessage)} target="_blank" rel="noopener noreferrer">
              <IconBrandWhatsapp size={20} aria-hidden="true" />
              <span><strong>WhatsApp</strong><small>{SUPPORT.phoneDisplay}</small></span>
            </a>
          ) : null}
          <a className="help-contact-button" href={`tel:${SUPPORT.phoneTel}`}>
            <IconPhone size={20} aria-hidden="true" />
            <span><strong>Call</strong><small>{SUPPORT.phoneDisplay}</small></span>
          </a>
          <a className="help-contact-button" href={emailLink(`Pharmacy POS help: ${activeShop?.name || 'support request'}`, emailBody)}>
            <IconMail size={20} aria-hidden="true" />
            <span><strong>Email</strong><small>{SUPPORT.email}</small></span>
          </a>
        </div>
        <p className="muted small">
          When you contact us, press <strong>Copy diagnostic info</strong> below and paste it into your message. It tells us your app version and sync status. It contains no customer or sales details.
        </p>
      </section>

      {hasFailures ? (
        <div className="help-alert" role="alert">
          Some records on this device failed to upload
          ({queues.sales.failed} sale{queues.sales.failed === 1 ? '' : 's'}, {queues.receipts.failed} stock receipt{queues.receipts.failed === 1 ? '' : 's'}).
          Contact support and include the diagnostic info, and do not clear this browser&apos;s data.
        </div>
      ) : null}

      <section className="help-diagnostics" aria-labelledby="help-diagnostics-title">
        <div className="help-diagnostics-head">
          <h3 id="help-diagnostics-title">Diagnostic info</h3>
          <button type="button" className="secondary-button" onClick={copyDiagnostics}>
            {copied ? <IconCheck size={16} aria-hidden="true" /> : <IconCopy size={16} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy diagnostic info'}
          </button>
        </div>
        {copyError ? <p className="error">{copyError}</p> : null}
        <details>
          <summary>Show what is copied</summary>
          <pre className="help-diagnostics-text">{diagnostics}</pre>
        </details>
      </section>

      {admin && checklist ? (
        <section className="help-checklist" aria-labelledby="help-checklist-title">
          <div className="help-diagnostics-head">
            <h3 id="help-checklist-title">Setup checklist</h3>
            <span className="muted small">{doneCount} of {checklist.length} done</span>
          </div>
          <ol>
            {checklist.map((item) => (
              <li key={item.key} className={item.done ? 'done' : ''}>
                {item.done
                  ? <IconCheck size={18} className="help-check-icon" aria-label="Done" />
                  : <IconCircle size={18} className="help-check-icon" aria-label="Not done" />}
                <div>
                  <strong>{item.label}</strong>
                  <div className="muted small">{item.detail}</div>
                </div>
                {!item.done && onNavigatePage ? (
                  <button type="button" className="table-action" onClick={() => onNavigatePage(item.page)}>Go</button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="help-faq" aria-labelledby="help-faq-title">
        <div className="help-diagnostics-head">
          <h3 id="help-faq-title">Common questions</h3>
          <input
            className="help-faq-search"
            value={faqSearch}
            onChange={(event) => setFaqSearch(event.target.value)}
            placeholder="Search help…"
            aria-label="Search help"
          />
        </div>
        {visibleFaq.length === 0 ? <p className="muted">No answers match. Contact support instead.</p> : null}
        {visibleFaq.map((item) => (
          <details key={item.q} className="help-faq-item">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </section>
    </div>
  );
}