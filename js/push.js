/* Rest alerts that reach a locked phone.

   iOS suspends a web app's JavaScript the moment the screen locks, so the
   local timer can't ring. What can wake a locked iPhone is a push message:
   this module registers the phone with the push service and, every time a
   rest starts, tells Supabase when to send one. A cron job there hands the
   alert to an edge function at the right moment, which signs and sends it.
   The service worker shows it — on the lock screen, with the system sound.

   Nothing here is load-bearing. Every call swallows its errors: with no
   signal, no account, or no permission, the beep and the on-screen timer
   still work exactly as before. */

import * as db from './db.js';
import * as supa from './supa.js';

/* The public half of the VAPID pair. The private half lives in Supabase
   Vault and never leaves the server. Safe to publish: it only identifies the
   sender, it can't send anything. */
export const APPLICATION_SERVER_KEY =
  'BKP_w-Vm_43UNLbVQg1omc3cE87v387mNC1MYNDN0HnNFX1ncOFw-62VUNPIGayMPWY8Mly3skcQdoUkqJBJa08';

/* iOS wants the raw 65-byte key, not the base64 string Chrome also accepts. */
function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function supported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

/* A stable id per install for the subscription row and for the one pending
   alert, so a new rest rewrites the previous row instead of adding to it. */
async function deviceId(key) {
  let id = await db.getMeta(key, null);
  if (!id) {
    id = crypto.randomUUID();
    await db.setMeta(key, id);
  }
  return id;
}

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg || navigator.serviceWorker.ready;
}

/* 'unsupported' | 'no-permission' | 'signed-out' | 'off' | 'on' */
export async function status() {
  if (!supported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'no-permission';
  if (!(await supa.getSession())) return 'signed-out';
  return (await db.getMeta('push_registered_endpoint', null)) ? 'on' : 'off';
}

/* Subscribe this phone and tell the server about it. Call from a tap when
   possible: iOS is happiest granting a subscription inside a gesture. Also
   safe to call at launch once permission exists — it re-checks the endpoint
   and re-registers if the push service handed out a new one. */
export async function enable() {
  try {
    if (!supported() || Notification.permission !== 'granted') return false;
    if (!(await supa.getSession())) return false;

    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(APPLICATION_SERVER_KEY),
      });
    }

    const json = sub.toJSON();
    const known = await db.getMeta('push_registered_endpoint', null);
    if (known !== json.endpoint) {
      await supa.upsert('push_subscriptions', [{
        id: await deviceId('push_subscription_id'),
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      }]);
      await db.setMeta('push_registered_endpoint', json.endpoint);
    }
    return true;
  } catch (error) {
    console.warn('[liftlog] push registration skipped:', error?.message || error);
    return false;
  }
}

/* Ask the server to send the alert at `endsAt` (epoch ms). Rewrites the
   phone's one pending alert, so extending or restarting a rest just moves
   the time. A no-op unless the phone is registered. */
export async function schedule(endsAt, { title = 'Rest is up', body = 'Next set.' } = {}) {
  try {
    if ((await status()) !== 'on') return false;
    await supa.upsert('rest_alerts', [{
      id: await deviceId('rest_alert_id'),
      subscription_id: await deviceId('push_subscription_id'),
      fire_at: new Date(endsAt).toISOString(),
      sent_at: null,
      result: null,
      title,
      body,
    }]);
    return true;
  } catch (error) {
    console.warn('[liftlog] rest alert not scheduled:', error?.message || error);
    return false;
  }
}

/* Skipping a rest, or finishing the session: nothing should ring. */
export async function cancel() {
  try {
    if ((await status()) !== 'on') return false;
    await supa.upsert('rest_alerts', [{
      id: await deviceId('rest_alert_id'),
      subscription_id: await deviceId('push_subscription_id'),
      fire_at: null,
      sent_at: null,
      result: 'cancelled',
    }]);
    return true;
  } catch (error) {
    console.warn('[liftlog] rest alert not cancelled:', error?.message || error);
    return false;
  }
}
