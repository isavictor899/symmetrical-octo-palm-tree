// Receipt printing for thermal roll printers (58mm / 80mm) and A4.
//
// A receipt is a plain object, built either at checkout (works offline) or
// from a synced sale (for reprints):
// {
//   receiptNo, time, paymentMethod, servedBy, total, reprint, pendingSync,
//   items: [{ name, qty, unitPrice, originalUnitPrice }],
//   prescription: { reference, prescriber, date } | null,
// }

export const RECEIPT_WIDTHS = [
  { value: '80mm', label: '80mm thermal (most common)' },
  { value: '58mm', label: '58mm thermal (small / Bluetooth)' },
  { value: 'a4', label: 'A4 office printer' },
];

const DEFAULT_WIDTH = '80mm';
const DEVICE_WIDTH_KEY = 'pharmacy-pos:receipt-width';
const RECENT_RECEIPTS_KEY = 'pharmacy-pos:recent-receipts';
const RECENT_RECEIPTS_LIMIT = 30;

const PAYMENT_LABELS = {
  cash: 'Cash',
  mpesa: 'M-Pesa',
  card: 'Card',
  insurance: 'Insurance',
  sha: 'SHA',
};

function isWidth(value) {
  return RECEIPT_WIDTHS.some((width) => width.value === value);
}

// ---------------------------------------------------------------------------
// Device setting: an optional override of the shop default, for this device only.
// ---------------------------------------------------------------------------
export function getDeviceReceiptWidth() {
  try {
    const value = window.localStorage.getItem(DEVICE_WIDTH_KEY);
    return isWidth(value) ? value : '';
  } catch {
    return '';
  }
}

export function setDeviceReceiptWidth(value) {
  try {
    if (isWidth(value)) window.localStorage.setItem(DEVICE_WIDTH_KEY, value);
    else window.localStorage.removeItem(DEVICE_WIDTH_KEY);
  } catch {
    // Storage blocked (private mode): the shop default is used instead.
  }
}

export function resolveReceiptWidth(shop) {
  const device = getDeviceReceiptWidth();
  if (device) return device;
  return isWidth(shop?.receipt_paper_width) ? shop.receipt_paper_width : DEFAULT_WIDTH;
}

// ---------------------------------------------------------------------------
// Recent receipts kept on this device, so a receipt can be reprinted at once,
// even offline and before the sale has synced.
// ---------------------------------------------------------------------------
export function rememberReceipt(shopId, receipt) {
  if (!shopId || !receipt?.receiptNo) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_RECEIPTS_KEY) || '[]');
    const next = [{ shopId, receipt }, ...all.filter((entry) => entry?.receipt?.receiptNo !== receipt.receiptNo)]
      .slice(0, RECENT_RECEIPTS_LIMIT);
    window.localStorage.setItem(RECENT_RECEIPTS_KEY, JSON.stringify(next));
  } catch {
    // Not essential: synced sales can still be reprinted from the server.
  }
}

export function recentReceipts(shopId) {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_RECEIPTS_KEY) || '[]');
    return all.filter((entry) => entry?.shopId === shopId).map((entry) => entry.receipt);
  } catch {
    return [];
  }
}

// Called on sign-out so the next person on a shared till cannot see them.
export function clearRecentReceipts() {
  try {
    window.localStorage.removeItem(RECENT_RECEIPTS_KEY);
  } catch {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function receiptNumberFor(saleOrClientId) {
  return String(saleOrClientId || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function paymentLabel(method) {
  return PAYMENT_LABELS[method] || String(method || '').toUpperCase();
}

function money(value) {
  return Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function formatReceiptTime(value) {
  return new Date(value).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function pageCss(width) {
  if (width === 'a4') {
    return `
      @page { size: A4; margin: 16mm; }
      body { width: 120mm; margin: 0 auto; font-size: 12pt; }
    `;
  }
  // Printable width is a few mm narrower than the roll. The page height is
  // set to the receipt's measured length just before printing (see
  // fitPageToContent): Chrome ignores "auto" heights in @page size.
  const content = width === '58mm' ? '48mm' : '72mm';
  const fontSize = width === '58mm' ? '10.5px' : '12px';
  return `
    @page { size: ${width} 200mm; margin: 0; }
    html, body { width: ${width}; }
    body { box-sizing: border-box; width: ${content}; margin: 0 auto; padding: 3mm 0 6mm; font-size: ${fontSize}; }
  `;
}

export function buildReceiptHtml(receipt, shop, width = DEFAULT_WIDTH) {
  const items = receipt.items || [];
  const subtotal = items.reduce((sum, item) => sum + Number(item.originalUnitPrice ?? item.unitPrice) * Number(item.qty), 0);
  const total = Number(receipt.total ?? items.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.qty), 0));
  const discount = Math.max(0, Math.round((subtotal - total) * 100) / 100);

  const shopLines = [
    shop?.location,
    shop?.phone ? `Tel: ${shop.phone}` : '',
    shop?.email,
  ].filter(Boolean).map((line) => `<div>${escapeHtml(line)}</div>`).join('');

  const legalLines = [
    shop?.kra_pin ? `KRA PIN: ${shop.kra_pin}` : '',
    shop?.ppb_licence_no ? `PPB Licence: ${shop.ppb_licence_no}` : '',
  ].filter(Boolean).map((line) => `<div>${escapeHtml(line)}</div>`).join('');

  const itemRows = items.map((item) => {
    const qty = Number(item.qty);
    const unit = Number(item.unitPrice);
    const original = Number(item.originalUnitPrice ?? unit);
    const lineDiscount = original > unit
      ? `<div class="row muted"><span>&nbsp;&nbsp;Discount ${escapeHtml(money(original - unit))} each</span></div>`
      : '';
    return `
      <div class="item">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="row"><span>&nbsp;&nbsp;${qty} x ${escapeHtml(money(original))}</span><span>${escapeHtml(money(original * qty))}</span></div>
        ${lineDiscount}
      </div>`;
  }).join('');

  const rx = receipt.prescription?.reference
    ? `
      <div class="rule"></div>
      <div class="section-title">Prescription</div>
      <div class="row"><span>Ref</span><span>${escapeHtml(receipt.prescription.reference)}</span></div>
      ${receipt.prescription.prescriber ? `<div class="row"><span>Prescriber</span><span>${escapeHtml(receipt.prescription.prescriber)}</span></div>` : ''}
      ${receipt.prescription.date ? `<div class="row"><span>Date</span><span>${escapeHtml(formatDate(receipt.prescription.date))}</span></div>` : ''}`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt ${escapeHtml(receipt.receiptNo)}</title>
<style>
  ${pageCss(width)}
  * { box-sizing: border-box; }
  body { color: #000; font-family: "Courier New", Courier, monospace; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .center { text-align: center; }
  .shop-name { font-size: 1.35em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
  .title { margin: 2mm 0 1mm; font-weight: 700; letter-spacing: 0.08em; }
  .copy { display: inline-block; margin-top: 1mm; padding: 0 2mm; border: 1px solid #000; font-weight: 700; }
  .rule { margin: 2mm 0; border-top: 1px dashed #000; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .row span:last-child { text-align: right; white-space: nowrap; }
  .item { margin-bottom: 1.2mm; }
  .item-name { font-weight: 700; word-break: break-word; }
  .muted { color: #000; opacity: 0.8; }
  .total { font-size: 1.3em; font-weight: 700; }
  .section-title { font-weight: 700; }
  .footer { margin-top: 3mm; text-align: center; white-space: pre-line; }
  .small { font-size: 0.85em; }
</style>
</head>
<body>
  <div class="center">
    <div class="shop-name">${escapeHtml(shop?.name || 'Pharmacy')}</div>
    ${shopLines}
    ${legalLines}
    <div class="title">SALES RECEIPT</div>
    ${receipt.reprint ? '<div class="copy">COPY</div>' : ''}
  </div>
  <div class="rule"></div>
  <div class="row"><span>Receipt no.</span><span>${escapeHtml(receipt.receiptNo)}</span></div>
  <div class="row"><span>Date</span><span>${escapeHtml(formatReceiptTime(receipt.time))}</span></div>
  ${receipt.servedBy ? `<div class="row"><span>Served by</span><span>${escapeHtml(receipt.servedBy)}</span></div>` : ''}
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  ${discount > 0 ? `<div class="row"><span>Subtotal</span><span>${escapeHtml(money(subtotal))}</span></div>
  <div class="row"><span>Discount</span><span>-${escapeHtml(money(discount))}</span></div>` : ''}
  <div class="row total"><span>TOTAL KES</span><span>${escapeHtml(money(total))}</span></div>
  <div class="row"><span>Paid by</span><span>${escapeHtml(paymentLabel(receipt.paymentMethod))}</span></div>
  ${rx}
  <div class="rule"></div>
  <div class="footer">${escapeHtml(shop?.receipt_footer || 'Thank you. Get well soon!')}</div>
  <div class="center small">This is not a tax invoice.</div>
  ${receipt.pendingSync ? '<div class="center small">Recorded offline. Will sync automatically.</div>' : ''}
</body>
</html>`;
}

// Sets the page to exactly the receipt's length, so a thermal printer feeds
// only as much paper as the receipt needs. Exported for tests.
export function fitPageToContent(doc, width) {
  if (width === 'a4' || !doc?.body) return;
  // Measure the body itself: the window's own height would add blank paper.
  const heightPx = doc.body.getBoundingClientRect().height;
  const heightMm = Math.ceil((heightPx * 25.4) / 96) + 6;
  let style = doc.getElementById('receipt-page-size');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'receipt-page-size';
    doc.head.appendChild(style);
  }
  style.textContent = `@page { size: ${width} ${heightMm}mm; margin: 0; }`;
}

// Opens the print dialog. Returns false if the browser blocked the popup.
export function printReceipt(receipt, shop, width = resolveReceiptWidth(shop)) {
  // Do not pass `noopener`: browsers return null for that option, which would
  // stop us writing the receipt into the window.
  const popup = window.open('', '_blank', width === 'a4' ? 'width=820,height=900' : 'width=420,height=760');
  if (!popup) return false;

  popup.document.open();
  popup.document.write(buildReceiptHtml(receipt, shop, width));
  popup.document.close();
  popup.focus();

  let printed = false;
  const printOnce = () => {
    if (printed || popup.closed) return;
    printed = true;
    fitPageToContent(popup.document, width);
    popup.print();
  };
  popup.onload = printOnce;
  // about:blank may already count as loaded before onload is assigned.
  window.setTimeout(printOnce, 300);
  popup.onafterprint = () => popup.close();
  return true;
}

// Remembers that a test receipt was printed on this device (setup checklist).
const TEST_PRINT_KEY = 'pharmacy-pos:test-receipt-printed';

export function markTestReceiptPrinted() {
  try {
    window.localStorage.setItem(TEST_PRINT_KEY, new Date().toISOString());
  } catch {
    // Only used for the setup checklist.
  }
}

export function hasPrintedTestReceipt() {
  try {
    return Boolean(window.localStorage.getItem(TEST_PRINT_KEY));
  } catch {
    return false;
  }
}

export function sampleReceipt() {
  return {
    receiptNo: 'TEST0001',
    time: new Date().toISOString(),
    paymentMethod: 'mpesa',
    servedBy: 'Test print',
    total: 470,
    items: [
      { name: 'Paracetamol 500mg tabs x10', qty: 2, unitPrice: 50, originalUnitPrice: 50 },
      { name: 'Amoxicillin 500mg caps x21', qty: 1, unitPrice: 320, originalUnitPrice: 350 },
      { name: 'Digital thermometer', qty: 1, unitPrice: 50, originalUnitPrice: 50 },
    ],
    prescription: null,
  };
}