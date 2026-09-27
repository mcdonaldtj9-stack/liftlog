/* send-push — deliver one rest alert by Web Push.

   Called by the database, not by the phone: the 5-second cron job in
   supabase/push.sql claims every alert due within the next few seconds and
   POSTs its id here. This function fetches what it needs with the service
   role (subscription, VAPID keys from Vault), waits out the last few seconds
   so the alert lands on time, signs the message and hands it to the push
   service. The phone's service worker does the rest.

   The response goes back immediately (pg_net gives up after a short timeout);
   the actual work runs as a background task. */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* Never wait longer than this, whatever fire_at says: the cron claims
   alerts at most six seconds early, so anything bigger is a clock problem. */
const MAX_WAIT_MS = 20_000;

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function record(alertId: string, result: string): Promise<void> {
  try {
    await rest(`/rest/v1/rest_alerts?id=eq.${alertId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ result: result.slice(0, 300) }),
    });
  } catch (error) {
    console.error("could not record result", error);
  }
}

async function deliver(alertId: string): Promise<void> {
  const claim = await rest("/rest/v1/rpc/claim_rest_alert", {
    method: "POST",
    body: JSON.stringify({ alert_id: alertId }),
  });
  if (!claim.ok) {
    console.error("claim failed", claim.status, await claim.text());
    return;
  }
  const alert = await claim.json();
  if (!alert || !alert.fire_at) {
    await record(alertId, "cancelled before sending");
    return;
  }
  if (!alert.vapid || !alert.endpoint) {
    await record(alertId, "missing keys or subscription");
    return;
  }

  // Land on the second, not up to six seconds early.
  const wait = new Date(alert.fire_at).getTime() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, MAX_WAIT_MS)));

  const vapidKeys = await webpush.importVapidKeys(alert.vapid, { extractable: false });
  const server = await webpush.ApplicationServer.new({
    contactInformation: alert.subject || "mailto:liftlog@example.com",
    vapidKeys,
  });
  const subscriber = server.subscribe({
    endpoint: alert.endpoint,
    keys: { p256dh: alert.p256dh, auth: alert.auth },
  });

  try {
    await subscriber.pushTextMessage(
      JSON.stringify({ title: alert.title || "Rest is up", body: alert.body || "Next set." }),
      {
        // High: deliver to an idle, locked phone now. A rest alert a minute
        // late is worthless, so it expires fast; the topic makes a moved
        // alert replace an undelivered earlier one instead of stacking.
        urgency: webpush.Urgency.High,
        ttl: 60,
        topic: "liftlog-rest",
      },
    );
    await record(alertId, `sent ${new Date().toISOString()}`);
  } catch (error) {
    if (error instanceof webpush.PushMessageError) {
      const status = error.response.status;
      if (status === 410 || status === 404) {
        // The push service no longer knows this device; the app will
        // re-register on its next launch.
        await rest(`/rest/v1/push_subscriptions?id=eq.${alert.subscription_id}`, { method: "DELETE" });
        await record(alertId, `subscription gone (${status})`);
        return;
      }
      await record(alertId, `push service said ${status}: ${(await error.response.text()).slice(0, 120)}`);
      return;
    }
    await record(alertId, `error: ${String(error)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body: { alert_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("expected JSON", { status: 400 });
  }
  const id = String(body?.alert_id ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new Response("alert_id must be a uuid", { status: 400 });
  }

  EdgeRuntime.waitUntil(deliver(id).catch((error) => console.error("deliver failed", error)));

  return new Response(JSON.stringify({ queued: id }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
});
