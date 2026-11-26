// subscription-reminders: sends due subscription reminders by SMS and email.
//
// Called once a day by pg_cron (header x-cron-secret, checked against the
// secret the job reads from the database vault), or by a console owner with
// "Send now" / "Check setup" (their JWT, MFA-verified).
//
// Providers are optional and switched on by function secrets:
//   SMS   (Africa's Talking): AT_USERNAME, AT_API_KEY, optional AT_SENDER_ID
//   Email (Resend):           RESEND_API_KEY, REMINDER_EMAIL_FROM
// With neither set, nothing is sent and the console lists the reminders for
// sending by WhatsApp instead.
//
// verify_jwt is off for this function because the cron call has no user JWT;
// every request is authenticated below instead.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOWED_ORIGINS = ['https://pos.enoralabs.co.ke', 'http://localhost:5173'];

type Due = {
  organization_id: string; name: string; kind: string; expires_at: string;
  phone: string | null; email: string | null; message: string;
};

function buildCors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

// Kenyan numbers to +2547XXXXXXXX / +2541XXXXXXXX; anything else is skipped.
function kenyanPhone(value: string | null) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^[17]\d{8}$/.test(digits)) return `+254${digits}`;
  return null;
}

const SUBJECTS: Record<string, string> = {
  expires_in_7: 'Your Pharmacy POS subscription ends in 7 days',
  expires_in_1: 'Your Pharmacy POS subscription ends tomorrow',
  expired: 'Your Pharmacy POS subscription has ended',
  read_only_soon: 'Pharmacy POS becomes read-only in 2 days',
  read_only: 'Pharmacy POS is now read-only',
};

async function sendSms(to: string, message: string) {
  const username = Deno.env.get('AT_USERNAME') || '';
  const apiKey = Deno.env.get('AT_API_KEY') || '';
  const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const form = new URLSearchParams({ username, to, message });
  const senderId = Deno.env.get('AT_SENDER_ID');
  if (senderId) form.set('from', senderId);
  const response = await fetch(`https://${host}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  const recipient = payload?.SMSMessageData?.Recipients?.[0];
  if (!response.ok || !recipient || !['Success', 'Sent'].includes(recipient.status)) {
    throw new Error(String(recipient?.status || payload?.SMSMessageData?.Message || `HTTP ${response.status}`).slice(0, 200));
  }
}

async function sendEmail(to: string, subject: string, message: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('REMINDER_EMAIL_FROM'), to: [to], subject, text: message }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload?.message || `HTTP ${response.status}`).slice(0, 200));
  }
}

Deno.serve(async (request) => {
  const corsHeaders = buildCors(request.headers.get('origin'));
  const json = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Reminders are not configured.' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Who is calling: the daily schedule, or a console owner.
  let actor: string | null = null;
  const cronHeader = request.headers.get('x-cron-secret') || '';
  let fromCron = false;
  if (cronHeader) {
    const { data: ok } = await admin.rpc('verify_reminder_cron_secret', { p_secret: cronHeader });
    fromCron = ok === true;
    if (!fromCron) return json({ error: 'Not allowed.' }, 401);
  }
  if (!fromCron) {
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Not allowed.' }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await userClient.auth.getUser();
    const { error: requireError } = await userClient.rpc('platform_require', { p_min_role: 'owner' });
    if (!user || requireError) return json({ error: requireError?.message || 'Not allowed.' }, 403);
    actor = user.id;
  }

  const smsReady = Boolean(Deno.env.get('AT_USERNAME') && Deno.env.get('AT_API_KEY'));
  const emailReady = Boolean(Deno.env.get('RESEND_API_KEY') && Deno.env.get('REMINDER_EMAIL_FROM'));
  const body = await request.json().catch(() => ({}));

  if (body?.action === 'status') {
    const { data: scheduled } = await admin.rpc('reminder_schedule_ready');
    return json({ sms: smsReady, email: emailReady, schedule: scheduled === true });
  }
  if (!smsReady && !emailReady) {
    return json({ sent: 0, failed: 0, skipped: 0, note: 'No SMS or email provider is set up. Send due reminders by WhatsApp from the console.' });
  }

  const { data: due, error: dueError } = await admin.rpc('subscription_reminders_due');
  if (dueError) {
    console.error('[subscription-reminders] due list failed:', dueError.message);
    return json({ error: 'Could not load due reminders.' }, 500);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const reminder of (due || []) as Due[]) {
    const attempts: Array<{ channel: 'sms' | 'email'; to: string; send: () => Promise<void> }> = [];
    const phone = kenyanPhone(reminder.phone);
    if (smsReady && phone) attempts.push({ channel: 'sms', to: phone, send: () => sendSms(phone, reminder.message) });
    if (emailReady && reminder.email) {
      const email = reminder.email;
      attempts.push({ channel: 'email', to: email, send: () => sendEmail(email, SUBJECTS[reminder.kind] || 'Pharmacy POS subscription', reminder.message) });
    }
    if (!attempts.length) { skipped += 1; continue; }

    for (const attempt of attempts) {
      let status = 'sent';
      let error: string | null = null;
      try {
        await attempt.send();
        sent += 1;
      } catch (sendError) {
        status = 'failed';
        error = sendError instanceof Error ? sendError.message : 'Unknown error';
        failed += 1;
        console.error(`[subscription-reminders] ${attempt.channel} to ${reminder.name} failed:`, error);
      }
      await admin.rpc('record_subscription_reminder', {
        p_org: reminder.organization_id, p_kind: reminder.kind, p_expires_at: reminder.expires_at,
        p_channel: attempt.channel, p_recipient: attempt.to, p_status: status, p_error: error, p_actor: actor,
      });
    }
  }

  return json({ sent, failed, skipped });
});