import { useEffect, useRef } from 'react';

// Barcode helpers for standard USB / Bluetooth scanners. These behave like a
// keyboard: they "type" the code very quickly and press Enter.

// Mirrors public.normalize_barcode() in the database. Returns null for codes
// that cannot be right (bad characters, or a failed GTIN check digit, which
// usually means the scan was misread).
export function normalizeBarcode(raw) {
  let code = String(raw ?? '').replace(/\s/g, '');
  if (!/^[0-9A-Za-z.-]{4,48}$/.test(code)) return null;

  if (/^[0-9]+$/.test(code)) {
    // UPC-A (12 digits) is the same product as its EAN-13 form with a leading 0.
    if (code.length === 12) code = `0${code}`;
    if ([8, 13, 14].includes(code.length)) {
      let sum = 0;
      for (let i = 1; i < code.length; i += 1) {
        const digit = Number(code[code.length - 1 - i]);
        sum += digit * (i % 2 === 1 ? 3 : 1);
      }
      if ((10 - (sum % 10)) % 10 !== Number(code[code.length - 1])) return null;
    }
  }
  return code;
}

// A search-box entry that is clearly a barcode rather than a drug name.
export function looksLikeBarcode(value) {
  return /^\s*[0-9]{6,14}\s*$/.test(String(value ?? ''));
}

function isEditable(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

// Listens for scans anywhere on the page while nothing editable is focused
// (inputs handle their own Enter key). A scan is a burst of keys, each within
// `maxGapMs` of the last, ending in Enter. People type far slower than that.
export function useBarcodeScanner({ enabled = true, onScan, minLength = 6, maxGapMs = 45 }) {
  const handlerRef = useRef(onScan);
  handlerRef.current = onScan;

  useEffect(() => {
    if (!enabled) return undefined;
    let buffer = '';
    let lastKeyAt = 0;

    function onKeyDown(event) {
      if (isEditable(event.target) || event.ctrlKey || event.altKey || event.metaKey) {
        buffer = '';
        return;
      }
      const now = performance.now();
      const fast = now - lastKeyAt <= maxGapMs;
      lastKeyAt = now;

      if (event.key === 'Enter') {
        if (fast && buffer.length >= minLength) {
          // Stop the Enter from also pressing whatever button has focus
          // (for example "Complete sale").
          event.preventDefault();
          event.stopPropagation();
          const code = buffer;
          buffer = '';
          handlerRef.current?.(code);
        } else {
          buffer = '';
        }
        return;
      }

      if (event.key.length === 1) {
        buffer = fast ? buffer + event.key : event.key;
        if (buffer.length > 64) buffer = '';
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, minLength, maxGapMs]);
}

// Short beep so staff know a scan worked without looking at the screen.
let audioContext = null;
export function scanBeep(ok = true) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = audioContext || new AudioContextClass();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = ok ? 'sine' : 'square';
    oscillator.frequency.value = ok ? 1046 : 220;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + (ok ? 0.08 : 0.25));
  } catch {
    // Sound is a nicety; never let it break a sale.
  }
}