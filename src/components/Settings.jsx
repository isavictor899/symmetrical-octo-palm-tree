import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
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

export default function Settings({ userId }) {
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [shopName, setShopName] = useState('');
  const [themeColor, setThemeColor] = useState(defaultBrandColor);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fontScale, setFontScale] = useState(DEFAULT_FONT_SCALE);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const savedScale = loadFontScale(userId);
    setFontScale(savedScale);
    applyFontScale(savedScale);
  }, [userId]);

  function updateFontScale(value) {
    setFontScale(saveFontScale(userId, value));
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
        const userData = { user: sessionData.session.user };

        const { data: staffRow, error: staffError } = await supabase.from('staff')
          .select('shop_id, role')
          .eq('auth_user_id', userData.user.id)
          .maybeSingle();
        if (staffError) throw staffError;
        if (!staffRow?.shop_id) throw new Error('No shop is linked to this account.');
        const canEditShopSettings = isAdminRole(staffRow.role);
        if (!cancelled) setIsAdmin(canEditShopSettings);
        if (!canEditShopSettings) return;

        const { data: shopsData, error: shopsError } = await supabase.from('shops')
          .select('id, name, theme_color')
          .order('name');
        if (shopsError) throw shopsError;

        if (!cancelled) {
          setAllShops(shopsData || []);
          setSelectedShopId(staffRow.shop_id);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message || 'Unable to load shop settings.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  // Populate the form (and preview the theme) whenever the selected shop changes.
  useEffect(() => {
    const activeShop = allShops.find((shop) => shop.id === selectedShopId);
    if (!activeShop) return;
    setShopName(activeShop.name || '');
    setThemeColor(activeShop.theme_color || defaultBrandColor);
    applyBrandTheme(activeShop.theme_color || defaultBrandColor);
  }, [selectedShopId, allShops]);

  async function saveSettings(event) {
    event.preventDefault();
    if (!selectedShopId) return;

    const trimmedName = shopName.trim();
    if (!trimmedName) {
      setError('Shop name is required.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const { error: saveError } = await supabase
        .from('shops')
        .update({ name: trimmedName, theme_color: themeColor })
        .eq('id', selectedShopId);
      if (saveError) throw saveError;

      setAllShops((previous) => previous.map((shop) =>
        shop.id === selectedShopId ? { ...shop, name: trimmedName, theme_color: themeColor } : shop
      ));
      applyBrandTheme(themeColor);
      cacheTheme(themeColor);
      setError('');
    } catch (saveError) {
      setError(saveError.message || 'Unable to save shop settings.');
    } finally {
      setSaving(false);
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

        {isAdmin && allShops.length > 1 && (
          <nav className="shop-switcher" aria-label="Switch shop" style={{ marginBottom: 18 }}>
            {allShops.map((shop) => (
              <button
                key={shop.id}
                type="button"
                className={shop.id === selectedShopId ? 'active' : ''}
                onClick={() => setSelectedShopId(shop.id)}
              >
                {shop.name}
              </button>
            ))}
          </nav>
        )}

        {isAdmin && <form onSubmit={saveSettings} className="settings-form">
          <label className="field">
            <span>Shop name</span>
            <input
              type="text"
              value={shopName}
              onChange={(event) => setShopName(event.target.value)}
              placeholder="Shop name"
            />
          </label>

          <label className="field color-field">
            <span>Brand colour</span>
            <div className="color-row">
              <input
                type="color"
                value={themeColor}
                onChange={(event) => setThemeColor(event.target.value)}
                aria-label="Brand colour"
              />
              <span className="color-value">{themeColor}</span>
            </div>
          </label>

          {error && <div className="settings-error">{error}</div>}

          <button type="submit" className="save-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </form>}
      </div>
    </main>
  );
}
