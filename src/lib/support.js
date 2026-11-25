// Support contact details, shown on the Help page. Change them here only.
export const SUPPORT = {
  company: 'Enora Labs',
  email: 'info@enoralabs.co.ke',
  phoneDisplay: '0771 156 353',
  phoneTel: '+254771156353',
  // WhatsApp number in international format without "+". Set to '' to hide the button.
  whatsapp: '254771156353',
};

// Set at build time in vite.config.js (commit on Vercel, otherwise build date).
// eslint-disable-next-line no-undef
export const APP_BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev';

export function whatsappLink(message) {
  if (!SUPPORT.whatsapp) return '';
  return `https://wa.me/${SUPPORT.whatsapp}?text=${encodeURIComponent(message)}`;
}

export function emailLink(subject, body) {
  return `mailto:${SUPPORT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}