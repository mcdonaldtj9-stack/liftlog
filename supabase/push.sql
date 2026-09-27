-- LiftLog — rest alerts by Web Push. Server side.
--
-- Applied to the project as migration `rest_alerts_push_archive_weigh_places`
-- (2026-09-27), together with the `archived` and `for_weight` columns that
-- schema.sql now carries. Kept here so the whole mechanism is readable in one
-- place; schema.sql stays the thing you paste to create a fresh project, and
-- this is what you paste after it to get lock-screen rest alerts.
--
-- How it works:
--
--   phone  --upsert-->  push_subscriptions   (once per install)
--   phone  --upsert-->  rest_alerts          (every rest: fire_at, or null to cancel)
--   cron, every 5 s:    private.dispatch_rest_alerts()
--                       claims rows due within 6 s, POSTs {alert_id} to the
--                       send-push edge function via pg_net
--   send-push:          calls public.claim_rest_alert(id) with the service
--                       role to get the subscription + VAPID keys from Vault,
--                       waits until fire_at, signs and sends the push
--   phone's sw.js:      shows the notification — on the lock screen
--
-- Secrets live in Vault, never in this file or in the app:
--   vapid_keys     JSON {publicKey, privateKey} JWKs (the public half is
--                  also in js/push.js as APPLICATION_SERVER_KEY)
--   vapid_subject  mailto: contact for the push services
--   project_url    https://<ref>.supabase.co, so cron can call the function
--   anon_key       the legacy anon JWT, so the call passes the gateway
--
-- To rotate the VAPID pair: generate a new one (see the Node snippet in the
-- README), update the Vault secret, change APPLICATION_SERVER_KEY in
-- js/push.js, and every phone re-registers on its next launch.

-- ---------------------------------------------------------------- extensions

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------- tables

-- One row per installed device. The phone chooses the id once and keeps it.
create table if not exists public.push_subscriptions (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- One pending alert per device, rewritten on every rest. fire_at null means
-- cancelled; sent_at is set the moment the dispatcher claims the row.
create table if not exists public.rest_alerts (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  subscription_id uuid not null,
  fire_at         timestamptz,
  title           text,
  body            text,
  sent_at         timestamptz,
  result          text,
  created_at      timestamptz not null default now()
);

create index if not exists rest_alerts_due_idx
  on public.rest_alerts (fire_at) where sent_at is null and fire_at is not null;

do $$
declare
  t text;
begin
  foreach t in array array['push_subscriptions', 'rest_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I
         for all
         to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- dispatcher

create schema if not exists private;

-- Runs from cron as postgres. Claims every alert due within the next few
-- seconds and posts its id to the edge function, which does the waiting and
-- the signing. Only the id travels: keys never sit in the pg_net queue.
create or replace function private.dispatch_rest_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  anon text;
  alert record;
  n integer := 0;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into anon from vault.decrypted_secrets where name = 'anon_key';
  if base_url is null or anon is null then
    return 0;
  end if;

  for alert in
    with claimed as (
      update public.rest_alerts
         set sent_at = now()
       where sent_at is null
         and fire_at is not null
         and fire_at <= now() + interval '6 seconds'
      returning id
    )
    select id from claimed
  loop
    perform net.http_post(
      url := base_url || '/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', anon,
        'Authorization', 'Bearer ' || anon),
      body := jsonb_build_object('alert_id', alert.id),
      timeout_milliseconds := 10000);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function private.dispatch_rest_alerts() from public;

-- What the edge function needs to send one alert, fetched with the service
-- role. Nobody else can call it: the VAPID private key comes back in here.
create or replace function public.claim_rest_alert(alert_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id,
    'fire_at', a.fire_at,
    'title', a.title,
    'body', a.body,
    'subscription_id', s.id,
    'endpoint', s.endpoint,
    'p256dh', s.p256dh,
    'auth', s.auth,
    'vapid', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_keys')::jsonb,
    'subject', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_subject'))
  from public.rest_alerts a
  join public.push_subscriptions s on s.id = a.subscription_id
  where a.id = alert_id;
$$;

revoke all on function public.claim_rest_alert(uuid) from public;
revoke all on function public.claim_rest_alert(uuid) from anon, authenticated;
grant execute on function public.claim_rest_alert(uuid) to service_role;

-- ---------------------------------------------------------------- cron

select cron.schedule('liftlog-rest-alerts', '5 seconds', $$select private.dispatch_rest_alerts()$$);

-- A five-second job writes ~17k run records a day, and nothing cleans them.
select cron.schedule('liftlog-cron-cleanup', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$);
