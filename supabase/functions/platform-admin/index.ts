// platform-admin: Enora Labs console actions that need the service role.
//
//   onboard               (owner) create a pharmacy: organization, first shop,
//                         and the owner's admin login with a temporary password
//   reset_admin_password  (support) new temporary password for a pharmacy admin
//   add_team_member       (owner) add someone to the console team; creates a
//                         login with a temporary password if they have none
//   reset_member_mfa      (owner) remove a console member's authenticator so
//                         they set it up again (lost phone); not your own
//
// The caller's JWT is verified with Supabase Auth, then platform_require runs
// with the caller's own token: it checks their console role AND that the
// session passed MFA. The SQL functions then re-check the role. Temporary
// passwords are generated here and returned once; never stored or logged.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOWED_ORIGINS = ['https://pos.enoralabs.co.ke', 'http://localhost:5173'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLANS = new Set(['basic', 'pro', 'enterprise']);

function buildCors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function text(value: unknown, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

// 12 characters from an alphabet without look-alikes (no 0/O, 1/l/I), read
// aloud or typed easily by a pharmacy owner.
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function rpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    if (error.code === 'P0001') throw new UserError(error.message);
    console.error(`[platform-admin] ${fn} failed:`, error.code, error.message);
    throw new UserError('The change could not be saved. Please try again.', 500);
  }
  return data;
}

Deno.serve(async (request) => {
  const corsHeaders = buildCors(request.headers.get('origin'));
  const json = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sign in first.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'The console is not configured.' }, 500);

  try {
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

    // Role and MFA, checked with the caller's own session (aal2 lives in it).
    const minRole = action === 'reset_admin_password' ? 'support' : 'owner';
    const { error: requireError } = await userClient.rpc('platform_require', { p_min_role: minRole });
    if (requireError) {
      return json({ error: requireError.code === 'P0001' ? requireError.message : 'Could not check your console access.' }, 403);
    }

    switch (action) {
      case 'onboard': {
        const orgName = text(body.organization_name, 120);
        const plan = text(body.plan, 20).toLowerCase();
        const trialDays = Number(body.trial_days);
        const shopName = text(body.shop_name, 120);
        const adminName = text(body.admin_name, 80);
        const adminEmail = text(body.admin_email, 254).toLowerCase();
        if (!PLANS.has(plan)) throw new UserError('Choose Basic, Pro or Enterprise.');
        if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) throw new UserError('The trial must be between 0 and 90 days.');
        if (!EMAIL_PATTERN.test(adminEmail)) throw new UserError('Enter a valid email for the pharmacy\'s administrator.');

        // Authorise and validate BEFORE creating a login.
        await rpc(admin, 'platform_check_onboard', { p_actor: actor, p_org_name: orgName, p_admin_email: adminEmail });

        const password = temporaryPassword();
        const { data: created, error: createError } = await admin.auth.admin.createUser({
          email: adminEmail,
          password,
          email_confirm: true,
          user_metadata: { full_name: adminName },
        });
        if (createError || !created?.user) {
          if (/already|registered|exists/i.test(createError?.message || '')) {
            throw new UserError('That email already has a login. Use a different email.');
          }
          console.error('[platform-admin] createUser failed:', createError?.message);
          throw new UserError('The login could not be created. Please try again.', 500);
        }

        try {
          const result = await rpc(admin, 'platform_onboard', {
            p_actor: actor,
            p_auth_user_id: created.user.id,
            p_org_name: orgName,
            p_plan: plan,
            p_trial_days: trialDays,
            p_shop_name: shopName,
            p_shop_location: text(body.shop_location, 120) || null,
            p_shop_phone: text(body.shop_phone, 20) || null,
            p_admin_name: adminName,
            p_admin_email: adminEmail,
            p_admin_phone: text(body.admin_phone, 20) || null,
          });
          return json({ ...(result as Record<string, unknown>), email: adminEmail, temporary_password: password });
        } catch (error) {
          // Never leave a login with no pharmacy behind it.
          await admin.auth.admin.deleteUser(created.user.id).catch((cleanupError) =>
            console.error('[platform-admin] cleanup deleteUser failed:', cleanupError));
          throw error;
        }
      }

      case 'reset_admin_password': {
        const staffId = text(body.staff_id, 40);
        if (!UUID_PATTERN.test(staffId)) throw new UserError('Choose an administrator.');
        const target = await rpc(admin, 'platform_admin_login', { p_actor: actor, p_staff_id: staffId }) as { auth_user_id: string; email: string };
        const password = temporaryPassword();
        const { error: updateError } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
        if (updateError) {
          console.error('[platform-admin] password reset failed:', updateError.message);
          throw new UserError('The password could not be reset. Please try again.', 500);
        }
        return json({ email: target.email, temporary_password: password });
      }

      case 'add_team_member': {
        const email = text(body.email, 254).toLowerCase();
        const role = text(body.role, 20).toLowerCase();
        const fullName = text(body.full_name, 80);
        if (!EMAIL_PATTERN.test(email)) throw new UserError('Enter a valid email.');
        if (role !== 'owner' && role !== 'support') throw new UserError('Choose owner or support.');

        // Someone who already has a login (e.g. pharmacy staff) keeps their
        // password; otherwise they get a new login with a temporary one.
        const existing = await rpc(admin, 'platform_find_login', { p_email: email }) as string | null;
        let userId = existing;
        let password: string | null = null;
        if (!userId) {
          password = temporaryPassword();
          const { data: created, error: createError } = await admin.auth.admin.createUser({
            email, password, email_confirm: true, user_metadata: { full_name: fullName },
          });
          if (createError || !created?.user) {
            console.error('[platform-admin] createUser (team) failed:', createError?.message);
            throw new UserError('The login could not be created. Please try again.', 500);
          }
          userId = created.user.id;
        }
        try {
          await rpc(admin, 'platform_add_admin', { p_actor: actor, p_user: userId, p_email: email, p_role: role });
        } catch (error) {
          if (!existing && userId) {
            await admin.auth.admin.deleteUser(userId).catch((cleanupError) =>
              console.error('[platform-admin] cleanup deleteUser failed:', cleanupError));
          }
          throw error;
        }
        return json({ email, temporary_password: password, existing_login: Boolean(existing) });
      }

      case 'reset_member_mfa': {
        const userId = text(body.user_id, 40);
        if (!UUID_PATTERN.test(userId)) throw new UserError('Choose a console member.');
        if (userId === actor) throw new UserError('You cannot reset your own authenticator. Ask another owner.');
        await rpc(admin, 'platform_assert_member', { p_actor: actor, p_user: userId });
        const { data: factors, error: listError } = await admin.auth.admin.mfa.listFactors({ userId });
        if (listError) {
          console.error('[platform-admin] listFactors failed:', listError.message);
          throw new UserError('Could not read their authenticator setup. Please try again.', 500);
        }
        for (const factor of factors?.factors || []) {
          const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
          if (deleteError) {
            console.error('[platform-admin] deleteFactor failed:', deleteError.message);
            throw new UserError('Could not reset their authenticator. Please try again.', 500);
          }
        }
        // They set up a new authenticator at their next sign-in.
        return json({ ok: true, removed: (factors?.factors || []).length });
      }

      default:
        throw new UserError('Unknown action.');
    }
  } catch (error) {
    if (error instanceof UserError) return json({ error: error.message }, error.status);
    console.error('[platform-admin] unexpected error:', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});