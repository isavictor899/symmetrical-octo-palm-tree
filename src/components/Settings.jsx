import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isAdminRole } from '../lib/roles';
import { defaultBrandColor, applyBrandTheme, cacheTheme } from '../lib/theme';

export default function Settings() {
  const [allShops, setAllShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState(null);
  const [shopName, setShopName] = useState('');
  const [themeColor, setThemeColor] = useState(defaultBrandColor);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load the full shop list (admins may manage more than one shop),
  // defaulting to the signed-in user's own shop.
  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!userData.user) throw new Error('Please sign in to edit shop settings.');

        const [staffResult, shopsResult] = await Promise.all([
          supabase.from('staff')
            .select('shop_id, role')
            .eq('auth_user_id', userData.user.id)
            .maybeSingle(),
          supabase.from('shops')
            .select('id, name, theme_color')
            .order('name'),
        ]);
        const { data: staffRow, error: staffError } = staffResult;
        if (staffError) throw staffError;
        if (!staffRow?.shop_id) throw new Error('No shop is linked to this account.');
        if (!isAdminRole(staffRow.role)) throw new Error('Settings are available to administrators only.');

        const { data: shopsData, error: shopsError } = shopsResult;
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

        {allShops.length > 1 && (
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

        <form onSubmit={saveSettings} className="settings-form">
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
        </form>
      </div>
    </main>
  );
}
