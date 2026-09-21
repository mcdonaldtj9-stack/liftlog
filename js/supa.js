/* A small Supabase client over plain fetch.

   The official library would work, but it means loading ~100KB of third-party
   code from a CDN at runtime into an app that otherwise has no build step and
   no dependencies. PostgREST and the auth endpoints are a stable, simple HTTP
   API; this is about two hundred lines and can be tested with a fake fetch.

   Credentials and tokens live in IndexedDB `meta`, not localStorage, so there's
   one storage story for everything and it survives the same way the log does. */

import * as db from './db.js';

/* Refresh this far before the token actually expires, so a slow request
   can't land on the far side of the boundary. */
const REFRESH_MARGIN_MS = 60_000;

export class AuthError extends Error {}
export class OfflineError extends Error {}

/* ---------- configuration ---------- */

export async function getConfig() {
  const url = await db.getMeta('supabase_url', '');
  const anonKey = await db.getMeta('supabase_anon_key', '');
  return { url: (url || '').replace(/\/+$/, ''), anonKey: anonKey || '' };
}

export async function setConfig({ url, anonKey }) {
  await db.setMeta('supabase_url', (url || '').trim().replace(/\/+$/, ''));
  await db.setMeta('supabase_anon_key', (anonKey || '').trim());
}

export async function isConfigured() {
  const { url, anonKey } = await getConfig();
  return Boolean(url && anonKey);
}

/* ---------- session ---------- */

export async function getSession() {
  return db.getMeta('supabase_session', null);
}

async function storeSession(payload) {
  if (!payload?.access_token) throw new AuthError('No token in response');
  const session = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // expires_in is seconds from now; store the absolute moment instead.
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    email: payload.user?.email ?? null,
  };
  await db.setMeta('supabase_session', session);
  return session;
}

export async function signOut() {
  await db.setMeta('supabase_session', null);
}

/* Any network-level failure is reported as offline: navigator.onLine lies
   often enough that a failed request is the more honest signal. */
async function call(path, { method = 'POST', headers = {}, body } = {}) {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey) throw new AuthError('Supabase is not configured yet');

  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: { apikey: anonKey, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new OfflineError('Could not reach Supabase');
  }
  return response;
}

export async function signIn(email, password) {
  const response = await call('/auth/v1/token?grant_type=password', {
    body: { email: String(email).trim(), password },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AuthError(payload.error_description || payload.msg || 'Sign in failed');
  }
  return storeSession(payload);
}

async function refresh(session) {
  if (!session?.refresh_token) throw new AuthError('Signed out');

  const response = await call('/auth/v1/token?grant_type=refresh_token', {
    body: { refresh_token: session.refresh_token },
  });

  if (!response.ok) {
    await signOut();
    throw new AuthError('Session expired — sign in again');
  }
  return storeSession(await response.json());
}

/* A valid token, refreshed first if it's close to expiring. */
async function accessToken() {
  let session = await getSession();
  if (!session) throw new AuthError('Signed out');

  if (session.expires_at - Date.now() < REFRESH_MARGIN_MS) {
    session = await refresh(session);
  }
  return session.access_token;
}

/* ---------- authenticated requests ---------- */

async function authed(path, options = {}, { retrying = false } = {}) {
  const token = await accessToken();
  const response = await call(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });

  // The token was rejected despite looking valid — refresh once, then give up
  // rather than looping against a server that keeps saying no.
  if (response.status === 401 && !retrying) {
    await refresh(await getSession());
    return authed(path, options, { retrying: true });
  }

  if (response.status === 401) {
    await signOut();
    throw new AuthError('Session expired — sign in again');
  }

  return response;
}

/* ---------- PostgREST ---------- */

export async function upsert(table, rows) {
  if (!rows.length) return;

  const response = await authed(`/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: rows,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upsert into ${table} failed (${response.status}) ${detail}`.trim());
  }
}

/* One page of rows changed since `since`, oldest first. Ordering by the
   server's own clock is what makes the watermark safe to resume from. */
export async function selectSince(table, since, limit = 500) {
  const params = new URLSearchParams({
    select: '*',
    order: 'server_updated_at.asc',
    limit: String(limit),
  });
  if (since) params.set('server_updated_at', `gt.${since}`);

  const response = await authed(`/rest/v1/${table}?${params}`, { method: 'GET' });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Read from ${table} failed (${response.status}) ${detail}`.trim());
  }
  return response.json();
}
