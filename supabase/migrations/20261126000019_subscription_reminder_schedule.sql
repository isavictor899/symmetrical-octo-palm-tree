-- Daily subscription reminders at 07:00 Nairobi (04:00 UTC).
--
-- pg_cron calls the subscription-reminders edge function with pg_net. The call
-- carries a random secret kept in the database vault; the function checks it
-- with verify_reminder_cron_secret(). The secret is generated here at run time,
-- so it never appears in the repository.
--
-- Note: the URL below is this Supabase project's. A copy of the database on
-- another project needs its own URL here.

create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'reminders_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'reminders_cron_secret',
      'Shared secret between pg_cron and the subscription-reminders edge function'
    );
  end if;
end;
$$;

create or replace function public.verify_reminder_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(length(p_secret) >= 32 and p_secret = (
    select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret'), false);
$$;
revoke all on function public.verify_reminder_cron_secret(text) from public, anon, authenticated;

create or replace function public.reminder_schedule_ready()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from cron.job where jobname = 'subscription-reminders-daily' and active)
     and exists (select 1 from vault.secrets where name = 'reminders_cron_secret');
$$;
revoke all on function public.reminder_schedule_ready() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'subscription-reminders-daily') then
    perform cron.unschedule('subscription-reminders-daily');
  end if;
end;
$$;

select cron.schedule(
  'subscription-reminders-daily',
  '0 4 * * *',
  $job$
    select net.http_post(
      url := 'https://gdgoofbcbmwmzuwwrcbd.supabase.co/functions/v1/subscription-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
      ),
      body := '{"action":"run"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);