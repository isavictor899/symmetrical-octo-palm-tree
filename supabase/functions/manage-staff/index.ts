// manage-staff: the only place staff logins are created, banned or reset.
//
// The browser never holds the service-role key. This function:
//   1. verifies the caller's JWT,
//   2. passes the verified user id to service-role-only SQL functions
//      (staff_admin_*), which check the caller is an active admin and that
//      the target is in their organization,
//   3. performs the Supabase Auth step (create / ban / unban / set password).
//
// Passwords: at least 10 characters, and never one that appears in a known
// data breach (Have I Been Pwned, k-anonymity: only the first 5 characters of
// the SHA-1 hash leave this function). Changing your own password also needs
// the current one; every device using that login is signed out.
//
// Actions: list, create, update, set_active, reset_password, change_own_password.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ROLES = new Set(['admin', 'pharmacist', 'cashier']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD = 10;
const BAN_FOREVER = '876000h'; // ~100 years

class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function text(value: unknown, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function requireUuid(value: unknown, label: string) {
  const id = text(value, 40);
  if (!UUID_PATTERN.test(id)) throw new UserError(`Missing or invalid ${label}.`);
  return id;
}

function requirePassword(value: unknown, email?: string | null) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD) {
    throw new UserError(`The password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 72) throw new UserError('The password is too long.');
  if (/^(.)\1+$/.test(password)) throw new UserError('Choose a password that is not one character repeated.');
  const lower = password.toLowerCase();
  const localPart = (email || '').toLowerCase().split('@')[0];
  if (email && (lower === email.toLowerCase() || (localPart.length >= 4 && lower.includes(localPart)))) {
    throw new UserError('Choose a password that does not contain the email address.');
  }
  return password;
}

// Have I Been Pwned range API. If the service cannot be reached we allow the
// password (the length rules still apply) rather than lock people out.
async function assertNotBreached(password: string) {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'enora-pharmacy-pos' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      console.warn('[manage-staff] breach check unavailable:', response.status);
      return;
    }
    const body = await response.text();
    const found = body.split('\n').some((line) => {
      const [candidate, count] = line.trim().split(':');
      return candidate === suffix && Number(count) > 0;
    });
    if (found) {
      throw new UserError('This password has appeared in a data breach and is easy to guess. Choose a different one.');
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    console.warn('[manage-staff] breach check skipped:', error instanceof Error ? error.message : 'unknown');
  }
}

function requireRole(value: unknown) {
  const role = text(value, 20).toLowerCase();
  if (!ROLES.has(role)) throw new UserError('Choose a role: admin, pharmacist or cashier.');
  return role;
}

// SQL functions raise P0001 with a message meant for the user; anything else is internal.
async function rpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    if (error.code === 'P0001') throw new UserError(error.message);
    console.error(`[manage-staff] ${fn} failed:`, error.code, error.message);
    throw new UserError('The staff change could not be saved. Please try again.', 500);
  }
  return data;
}

async function authStep(promise: Promise<{ error: { message: string } | null }>, context: string) {
  const { error } = await promise;
  if (error) {
    console.error(`[manage-staff] auth step "${context}" failed:`, error.message);
    throw new UserError(`The login could not be updated (${context}). Please try again.`, 500);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sign in to manage staff.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Staff management is not configured.' }, 500);

  try {
    // 1. Who is calling? Verified against Supabase Auth, never trusted from the body.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: 'Your session is invalid. Sign in again.' }, 401);
    const actor = user.id;

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await request.json().catch(() => ({}));
    const action = text(body?.action, 40);

    switch (action) {
      case 'list': {
        const staff = await rpc(admin, 'staff_admin_list', { p_actor: actor });
        return json({ staff: staff ?? [] });
      }

      case 'create': {
        const fullName = text(body.full_name, 80);
        const email = text(body.email, 254).toLowerCase();
        const phone = text(body.phone, 20);
        const role = requireRole(body.role);
        const shopId = requireUuid(body.shop_id, 'shop');
        if (!EMAIL_PATTERN.test(email)) throw new UserError('Enter a valid email address.');
        const password = requirePassword(body.password, email);
        await assertNotBreached(password);

        // Authorise BEFORE creating a login, so a refused request leaves nothing behind.
        await rpc(admin, 'staff_admin_check_create', {
          p_actor: actor, p_shop_id: shopId, p_role: role, p_full_name: fullName,
        });

        const { data: created, error: createError } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (createError || !created?.user) {
          const message = createError?.message || '';
          if (/already|registered|exists/i.test(message)) {
            throw new UserError('A login with this email already exists. Use a different email.');
          }
          console.error('[manage-staff] createUser failed:', message);
          throw new UserError('The login could not be created. Please try again.', 500);
        }

        try {
          const staffId = await rpc(admin, 'staff_admin_create', {
            p_actor: actor,
            p_auth_user_id: created.user.id,
            p_shop_id: shopId,
            p_role: role,
            p_full_name: fullName,
            p_email: email,
            p_phone: phone || null,
          });
          return json({ staff_id: staffId });
        } catch (error) {
          // Never leave an orphan login that could sign in with no staff profile.
          await admin.auth.admin.deleteUser(created.user.id).catch((cleanupError) =>
            console.error('[manage-staff] cleanup deleteUser failed:', cleanupError));
          throw error;
        }
      }

      case 'update': {
        await rpc(admin, 'staff_admin_update', {
          p_actor: actor,
          p_staff_id: requireUuid(body.staff_id, 'staff member'),
          p_full_name: text(body.full_name, 80),
          p_role: requireRole(body.role),
          p_shop_id: requireUuid(body.shop_id, 'shop'),
          p_phone: text(body.phone, 20) || null,
        });
        return json({ ok: true });
      }

      case 'set_active': {
        if (typeof body.active !== 'boolean') throw new UserError('Choose activate or deactivate.');
        const login = await rpc(admin, 'staff_admin_set_active', {
          p_actor: actor,
          p_staff_id: requireUuid(body.staff_id, 'staff member'),
          p_active: body.active,
        });
        if (login) {
          await authStep(
            admin.auth.admin.updateUserById(login, { ban_duration: body.active ? 'none' : BAN_FOREVER }),
            body.active ? 'unban' : 'ban',
          );
        }
        return json({ ok: true });
      }

      case 'reset_password': {
        const password = requirePassword(body.password);
        await assertNotBreached(password);
        const login = await rpc(admin, 'staff_admin_mark_password_reset', {
          p_actor: actor,
          p_staff_id: requireUuid(body.staff_id, 'staff member'),
        });
        await authStep(admin.auth.admin.updateUserById(login, { password }), 'set temporary password');
        return json({ ok: true });
      }

      case 'change_own_password': {
        const currentPassword = String(body.current_password ?? '');
        if (!currentPassword) throw new UserError('Enter your current password.');
        const password = requirePassword(body.password, user.email);
        if (password === currentPassword) throw new UserError('The new password must be different from the current one.');
        // Checked against the stored hash in the database (rate limited there:
        // 5 wrong attempts per 15 minutes), not by signing in again.
        const correct = await rpc(admin, 'staff_verify_own_password', { p_actor: actor, p_password: currentPassword });
        if (correct !== true) throw new UserError('Your current password is not correct.', 403);

        await assertNotBreached(password);
        await authStep(admin.auth.admin.updateUserById(actor, { password }), 'change password');
        await rpc(admin, 'staff_self_password_changed', { p_actor: actor });

        // Supabase ends ALL of this user's sessions when the password is set
        // here, including the caller's; the app signs in again with the new
        // password straight after (see ChangePassword.jsx).
        return json({ ok: true });
      }

      default:
        throw new UserError('Unknown action.');
    }
  } catch (error) {
    if (error instanceof UserError) return json({ error: error.message }, error.status);
    console.error('[manage-staff] unexpected error:', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});