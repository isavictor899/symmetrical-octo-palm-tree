// Browser-side password rules for the "reset link" screen, which sets the
// password directly with Supabase Auth (there is no current password to check).
// Changing a password while signed in goes through manage-staff, which applies
// the same rules on the server.

export const MIN_NEW_PASSWORD = 10;

// Have I Been Pwned range API with k-anonymity: only the first 5 characters of
// the SHA-1 hash are sent. Returns true / false, or null if the check could
// not run (offline, blocked); callers then allow the password.
export async function passwordIsBreached(password) {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: controller.signal,
    }).finally(() => window.clearTimeout(timer));
    if (!response.ok) return null;
    const suffix = hash.slice(5);
    const body = await response.text();
    return body.split('\n').some((line) => {
      const [candidate, count] = line.trim().split(':');
      return candidate === suffix && Number(count) > 0;
    });
  } catch {
    return null;
  }
}

// Returns an error message, or '' if the password is acceptable.
export async function newPasswordProblem(password, email = '') {
  if (password.length < MIN_NEW_PASSWORD) return `Your password must be at least ${MIN_NEW_PASSWORD} characters.`;
  if (password.length > 72) return 'The password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Choose a password that is not one character repeated.';
  const localPart = email.toLowerCase().split('@')[0];
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) return 'Choose a password that does not contain your email address.';
  if (await passwordIsBreached(password)) return 'This password has appeared in a data breach and is easy to guess. Choose a different one.';
  return '';
}