import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import PlanCard from './PlanCard';
import { defaultBrandColor, applyBrandTheme, cacheTheme } from '../lib/theme';
import {
  applyFontScale,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEP,
  loadFontScale,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  saveFontScale,
} from '../lib/fontScale';
import {
  getDeviceReceiptWidth,
  printReceipt,
  RECEIPT_WIDTHS,
  sampleReceipt,
  setDeviceReceiptWidth,
  markTestReceiptPrinted,
} from '../lib/receipt';
import './Settings.css';

const SHOP_FIELDS = 'id, name, theme_color, location, phone, email, kra_pin, ppb_licence_no, receipt_footer, receipt_paper_width';

const EMPTY_SHOP = {
  name: '',
  location: '',
  phone: '',
  email: '',
  kra_pin: '',
  ppb_licence_no: '',
  receipt_footer: '',
  theme_color: '',
  receipt_paper_width: '80mm',
};

function shopToForm(shop) {
  return {
    name: shop?.name || '',
    location: shop?.location || '',
    phone: shop?.phone || '',
    email: shop?.email || '',
    kra_pin: shop?.kra_pin || '',
    ppb_licence_no: shop?.ppb_licence_no || '',
    receipt_footer: shop?.receipt_footer || '',
    theme_color: shop?.theme_color || defaultBrandColor,
    receipt_paper_width: shop?.receipt_paper_width || '80mm',
  };
}

function shopRpcArgs(form) {
  return {
    p_name: form.name.trim(),
    p_location: form.location.trim() || null,
    p_phone: form.phone.trim() || null,
    p_email: form.email.trim() || null,
    p_kra_pin: form.kra_pin.replace(/\s/g, '').toUpperCase() || null,
    p_ppb_licence_no: form.ppb_licence_no.trim() || null,
    p_receipt_footer: form.receipt_footer.trim() || null,
    p_theme_color: form.theme_color || null,
    p_receipt_paper_width: form.receipt_paper_width || null,
  };
}

// Quick checks so staff get instant feedback; the database repeats every check.
function validateShopForm(form) {
  if (form.name.trim().length < 2) return 'Enter a shop name.';
  if (form.phone.trim() && !/^\+?[0-9 ()-]{7,20}$/.test(form.phone.trim())) return 'Enter a valid phone number, for example 0712 345 678.';
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) return 'Enter a valid email address.';
  const kra = form.kra_pin.replace(/\s/g, '').toUpperCase();
  if (kra && !/^[AP][0-9]{9}[A-Z]$/.test(kra)) return 'A KRA PIN is 11 characters, for example P051234567X.';
  return '';
}

function announceShopsChanged() {
  window.dispatchEvent(new Event('pharmacy-pos:shops-changed'));
}

function ShopFields({ form, onChange, idPrefix, showColour = true }) {
  return (
    <>
      <label className="field">
        <span>Shop name</span>
        <input type="text" value={form.name} onChange={(event) => onChange('name', event.target.value)} maxLength={80} required />
      </label>

      <div className="settings-grid">
        <label className="field">
          <span>Location / address</span>
          <input type="text" value={form.location} onChange={(event) => onChange('location', event.target.value)} placeholder="e.g. Nakuru CBD, Kenyatta Ave" maxLength={160} />
        </label>
        <label className="field">
          <span>Phone</span>
          <input type="tel" value={form.phone} onChange={(event) => onChange('phone', event.target.value)} placeholder="e.g. 0712 345 678" maxLength={20} />
        </label>
        <label className="field">
          <span>Email (optional)</span>
          <input type="email" value={form.email} onChange={(event) => onChange('email', event.target.value)} maxLength={254} />
        </label>
      </div>

      <fieldset className="settings-fieldset">
        <legend>Printed on receipts</legend>
        <div className="settings-grid">
          <label className="field">
            <span>KRA PIN</span>
            <input
              type="text"
              value={form.kra_pin}
              onChange={(event) => onChange('kra_pin', event.target.value.toUpperCase())}
              placeholder="e.g. P051234567X"
              maxLength={13}
              autoCapitalize="characters"
              aria-describedby={`${idPrefix}-kra-help`}
            />
          </label>
          <label className="field">
            <span>PPB premises licence no.</span>
            <input type="text" value={form.ppb_licence_no} onChange={(event) => onChange('ppb_licence_no', event.target.value)} maxLength={40} />
          </label>
        </div>
        <label className="field">
          <span>Receipt printer paper (shop default)</span>
          <select value={form.receipt_paper_width} onChange={(event) => onChange('receipt_paper_width', event.target.value)}>
            {RECEIPT_WIDTHS.map((width) => <option key={width.value} value={width.value}>{width.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Receipt footer message</span>
          <textarea
            value={form.receipt_footer}
            onChange={(event) => onChange('receipt_footer', event.target.value)}
            placeholder="e.g. Asante kwa kununua! Keep medicines out of reach of children."
            maxLength={200}
            rows={2}
          />
        </label>
        <p className="settings-hint" id={`${idPrefix}-kra-help`}>
          Receipts are not KRA tax invoices. Electronic tax invoices need eTIMS, which is not connected yet.
        </p>
      </fieldset>

      {showColour ? (
        <label className="field color-field">
          <span>Brand colour</span>
          <div className="color-row">
            <input
              type="color"
              value={form.theme_color || defaultBrandColor}
              onChange={(event) => onChange('theme_color', event.target.value)}
              aria-label="Brand colour"
            />
            <span className="color-value">{form.theme_color || defaultBrandColor}</span>
          </div>
        </label>
      ) : null}
    </>
  );
}

export default function Settings({ userId, organizationShops = [], activeShopId = null, subscription = null }) {
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [form, setForm] = useState(EMPTY_SHOP);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [fontScale, setFontScale] = useState(DEFAULT_FONT_SCALE);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deviceWidth, setDeviceWidth] = useState(() => getDeviceReceiptWidth());
  const [printerNotice, setPrinterNotice] = useState('');

  const [addingShop, setAddingShop] = useState(false);
  const [newShop, setNewShop] = useState(EMPTY_SHOP);
  const [newShopError, setNewShopError] = useState('');
  const [creatingShop, setCreatingShop] = useState(false);

  useEffect(() => {
    const savedScale = loadFontScale(userId);
    setFontScale(savedScale);
    applyFontScale(savedScale);
  }, [userId]);

  function updateFontScale(value) {
    setFontScale(saveFontScale(userId, value));
  }

  // The shop this device is selling from (any role), for the printer section.
  const deviceShop = organizationShops.find((shop) => shop.id === activeShopId) || null;
  const shopDefaultWidth = deviceShop?.receipt_paper_width || '80mm';
  const effectiveWidth = deviceWidth || shopDefaultWidth;

  function changeDeviceWidth(value) {
    setDeviceReceiptWidth(value);
    setDeviceWidth(getDeviceReceiptWidth());
    setPrinterNotice('');
  }

  function printTestReceipt() {
    const ok = printReceipt(sampleReceipt(), deviceShop || { name: 'Test shop' }, effectiveWidth);if (ok) markTestReceiptPrinted();
    setPrinterNotice(ok ? '' : 'Your browser blocked the receipt window. Allow pop-ups for this site, then try again.');
  }

  // Load the full shop list (admins may manage more than one shop),
  // defaulting to the signed-in user's own shop.
  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        // getSession reads the signed-in user from local storage, so this does not
        // add a network round trip. Row-level security still protects the data.
        const { data: sessionData, error: userError } = await supabase.auth.getSession();
        if (userError) throw userError;
        if (!sessionData.session?.user) throw new Error('Please sign in to edit shop settings.');

        const { data: staffRow, error: staffError } = await supabase.from('staff')
          .select('shop_id, role')
          .eq('auth_user_id', sessionData.session.user.id)
          .maybeSingle();
        if (staffError) throw staffError;
        if (!staffRow?.shop_id) throw new Error('No shop is linked to this account.');
        const canEditShopSettings = isAdminRole(staffRow.role);
        if (!cancelled) setIsAdmin(canEditShopSettings);
        if (!canEditShopSettings) return;

        const { data: shopsData, error: shopsError } = await supabase.from('shops')
          .select(SHOP_FIELDS)
          .order('name');
        if (shopsError) throw shopsError;

        if (!cancelled) {
          setAllShops(shopsData || []);
          setSelectedShopId(staffRow.shop_id);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Unable to load shop settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => { cancelled = true; };
  }, []);

  // Populate the form (and preview the theme) whenever the selected shop changes.
  useEffect(() => {
    const activeShop = allShops.find((shop) => shop.id === selectedShopId);
    if (!activeShop) return;
    setForm(shopToForm(activeShop));
    applyBrandTheme(activeShop.theme_color || defaultBrandColor);
  }, [selectedShopId, allShops]);

  function updateForm(field, value) {
    setForm((previous) => ({ ...previous, [field]: value }));
    if (field === 'theme_color') applyBrandTheme(value);
  }

  function updateNewShop(field, value) {
    setNewShop((previous) => ({ ...previous, [field]: value }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!selectedShopId || saving) return;

    const problem = validateShopForm(form);
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');

    try {
      const { error: saveError } = await supabase.rpc('update_shop_details', {
        p_shop_id: selectedShopId,
        ...shopRpcArgs(form),
      });
      if (saveError) throw saveError;

      const { data: refreshed, error: refreshError } = await supabase.from('shops')
        .select(SHOP_FIELDS)
        .eq('id', selectedShopId)
        .maybeSingle();
      if (refreshError) throw refreshError;

      setAllShops((previous) => previous.map((shop) => (shop.id === selectedShopId ? refreshed : shop)));
      applyBrandTheme(refreshed?.theme_color || defaultBrandColor);
      cacheTheme(refreshed?.theme_color || defaultBrandColor);
      setMessage(`${refreshed?.name || 'Shop'} settings saved.`);
      announceShopsChanged();
    } catch (saveError) {
      setError(saveError.message || 'Unable to save shop settings.');
    } finally {
      setSaving(false);
    }
  }

  function openAddShop() {
    const current = allShops.find((shop) => shop.id === selectedShopId);
    setNewShop({ ...EMPTY_SHOP, theme_color: current?.theme_color || defaultBrandColor });
    setNewShopError('');
    setMessage('');
    setAddingShop(true);
  }

  function closeAddShop() {
    if (creatingShop) return;
    setAddingShop(false);
    setNewShopError('');
  }

  async function createShop(event) {
    event.preventDefault();
    if (creatingShop) return;

    const problem = validateShopForm(newShop);
    if (problem) {
      setNewShopError(problem);
      return;
    }

    setCreatingShop(true);
    setNewShopError('');
    try {
      const { data: newShopId, error: createError } = await supabase.rpc('create_shop', shopRpcArgs(newShop));
      if (createError) throw createError;

      const { data: shopsData, error: shopsError } = await supabase.from('shops').select(SHOP_FIELDS).order('name');
      if (shopsError) throw shopsError;

      setAllShops(shopsData || []);
      setSelectedShopId(newShopId);
      setAddingShop(false);
      setMessage(`${newShop.name.trim()} was added. Next, add or move staff to it from the Staff page, then receive its stock.`);
      announceShopsChanged();
    } catch (createError) {
      setNewShopError(createError.message || 'Unable to add the shop.');
    } finally {
      setCreatingShop(false);
    }
  }

  if (loading) {
    return <main className="settings-page"><div className="settings-card"><p>Loading settings…</p></div></main>;
  }

  return (
    <main className="settings-page">
      <div className="settings-card">
        <div className="settings-header">
          <div>
            <p className="eyebrow">System preferences</p>
            <h1>Store settings</h1>
          </div>
        </div>

        <PlanCard subscription={subscription} isAdmin={isAdmin} />

        <section className="font-size-settings" aria-labelledby="font-size-heading">
          <div className="font-size-settings-copy">
            <h2 id="font-size-heading">App text size</h2>
            <p>Adjust text across the app. This setting is saved for your account on this device.</p>
          </div>
          <div className="font-size-controls">
            <button
              className="font-size-step"
              type="button"
              aria-label="Decrease app text size"
              onClick={() => updateFontScale(fontScale - FONT_SCALE_STEP)}
              disabled={fontScale <= MIN_FONT_SCALE}
            >
              A−
            </button>
            <label className="font-size-slider-label">
              <span className="font-size-value">{Math.round(fontScale * 100)}%</span>
              <input
                type="range"
                min={MIN_FONT_SCALE}
                max={MAX_FONT_SCALE}
                step={FONT_SCALE_STEP}
                value={fontScale}
                onChange={(event) => updateFontScale(Number(event.target.value))}
                aria-label="App text size"
              />
            </label>
            <button
              className="font-size-step font-size-step-large"
              type="button"
              aria-label="Increase app text size"
              onClick={() => updateFontScale(fontScale + FONT_SCALE_STEP)}
              disabled={fontScale >= MAX_FONT_SCALE}
            >
              A+
            </button>
            <button
              className="font-size-reset"
              type="button"
              onClick={() => updateFontScale(DEFAULT_FONT_SCALE)}
              disabled={fontScale === DEFAULT_FONT_SCALE}
            >
              Reset
            </button>
          </div>
          <div className="font-size-preview" aria-live="polite">
            <strong>Preview</strong>
            <span>Readable text for stock, sales, and reports.</span>
          </div>
        </section>

        <section className="settings-printer" aria-labelledby="printer-heading">
          <h2 id="printer-heading">This device's receipt printer</h2>
          <p>Saved on this device only. Use it when this till's printer differs from the shop's usual one.</p>
          <div className="settings-printer-row">
            <label className="field">
              <span>Paper width</span>
              <select value={deviceWidth} onChange={(event) => changeDeviceWidth(event.target.value)}>
                <option value="">Use shop default ({RECEIPT_WIDTHS.find((width) => width.value === shopDefaultWidth)?.label || shopDefaultWidth})</option>
                {RECEIPT_WIDTHS.map((width) => <option key={width.value} value={width.value}>{width.label}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button" onClick={printTestReceipt}>Print test receipt</button>
          </div>
          <p className="settings-hint">
            For thermal printers, set the printer's paper size to the same width in the print dialog and turn off headers and footers.
          </p>
          {printerNotice ? <div className="settings-error" role="alert">{printerNotice}</div> : null}
        </section>

        {isAdmin ? (
          <section className="settings-shops" aria-labelledby="shop-settings-heading">
            <div className="settings-shops-header">
              <div>
                <h2 id="shop-settings-heading">Shops</h2>
                <p>{allShops.length === 1 ? '1 shop in your organization.' : `${allShops.length} shops in your organization.`}</p>
              </div>
              <button type="button" className="secondary-button" onClick={openAddShop}>Add shop</button>
            </div>

            {allShops.length > 1 ? (
              <nav className="shop-switcher" aria-label="Choose shop to edit">
                {allShops.map((shop) => (
                  <button
                    key={shop.id}
                    type="button"
                    className={shop.id === selectedShopId ? 'active' : ''}
                    onClick={() => { setSelectedShopId(shop.id); setMessage(''); setError(''); }}
                  >
                    {shop.name}
                  </button>
                ))}
              </nav>
            ) : null}

            <form onSubmit={saveSettings} className="settings-form">
              <ShopFields form={form} onChange={updateForm} idPrefix="edit-shop" />

              {message ? <div className="settings-success" role="status">{message}</div> : null}
              {error ? <div className="settings-error" role="alert">{error}</div> : null}

              <button type="submit" className="save-button" disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </button>
            </form>
          </section>
        ) : null}
      </div>

      {addingShop ? (
        <div className="modal-backdrop" role="presentation">
          <form className="classification-modal settings-shop-modal" onSubmit={createShop}>
            <div>
              <h3>Add a shop</h3>
              <p className="muted small">The new shop joins your organization. It starts with no stock and no staff.</p>
            </div>

            <ShopFields form={newShop} onChange={updateNewShop} idPrefix="new-shop" />

            {newShopError ? <p className="error">{newShopError}</p> : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeAddShop} disabled={creatingShop}>Cancel</button>
              <button type="submit" disabled={creatingShop}>{creatingShop ? 'Adding…' : 'Add shop'}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}