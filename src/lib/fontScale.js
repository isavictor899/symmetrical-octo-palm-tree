const FONT_SCALE_KEY_PREFIX = 'pharmacy-pos:font-scale:';
export const MIN_FONT_SCALE = 0.85;
export const MAX_FONT_SCALE = 1.4;
export const DEFAULT_FONT_SCALE = 1;
export const FONT_SCALE_STEP = 0.05;

export function normalizeFontScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_FONT_SCALE;
  const bounded = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, numeric));
  return Math.round(bounded * 100) / 100;
}

export function applyFontScale(value) {
  const scale = normalizeFontScale(value);
  document.documentElement.style.setProperty('--app-font-size', `${16 * scale}px`);
  return scale;
}

export function loadFontScale(userId) {
  if (!userId) return DEFAULT_FONT_SCALE;
  try {
    const saved = window.localStorage.getItem(`${FONT_SCALE_KEY_PREFIX}${userId}`);
    return saved === null ? DEFAULT_FONT_SCALE : normalizeFontScale(saved);
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function saveFontScale(userId, value) {
  const scale = normalizeFontScale(value);
  applyFontScale(scale);
  if (userId) {
    try {
      window.localStorage.setItem(`${FONT_SCALE_KEY_PREFIX}${userId}`, String(scale));
    } catch {
      // Keep the in-memory setting active when browser storage is unavailable.
    }
  }
  return scale;
}
