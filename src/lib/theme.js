// Shared brand-theme logic — single source of truth for App.jsx,
// Dashboard.jsx, and Settings.jsx.

export const defaultBrandColor = '#2F6F5E';
const CACHE_KEY = 'shop-theme-color';

export function shadeHex(hex, percent) {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;

  const number = Number.parseInt(value, 16);
  const adjust = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (number >> 16) + adjust));
  const g = Math.min(255, Math.max(0, ((number >> 8) & 0x00ff) + adjust));
  const b = Math.min(255, Math.max(0, (number & 0x0000ff) + adjust));

  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

export function applyBrandTheme(colorHex) {
  const themeColor = colorHex || defaultBrandColor;
  const root = document.documentElement;
  root.style.setProperty('--brand-primary', themeColor);
  root.style.setProperty('--brand-primary-deep', shadeHex(themeColor, -18));
  root.style.setProperty('--brand-primary-soft', shadeHex(themeColor, 26));
  root.style.setProperty('--brand-primary-contrast', '#ffffff');
}

// Applies a cached color instantly (avoids a flash of default while the
// real value loads from Supabase), then returns it so callers can decide
// whether to trust it or wait for the authoritative DB value.
export function applyCachedThemeIfAny() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyBrandTheme(cached);
    return cached;
  } catch {
    return null;
  }
}

export function cacheTheme(colorHex) {
  try {
    localStorage.setItem(CACHE_KEY, colorHex);
  } catch {
    // Non-fatal — just means no instant-paint next load.
  }
}