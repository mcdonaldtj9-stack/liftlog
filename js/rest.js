/* Rest timer.

   The deadline is stored as an absolute timestamp, never a counter that ticks
   down: iOS suspends JavaScript the moment the phone locks, so an in-memory
   countdown simply stops. Storing when rest *ends* means we can always recompute
   what's left, including after the app has been killed and relaunched.

   On finishing, three things are attempted, in descending order of how well they
   work on an iPhone:
     1. An audible beep through Web Audio. Routed through the channel your ringer
        switch controls, so silent mode will silence it.
     2. A local notification, which on an installed iOS PWA plays the system
        sound and haptic. Needs permission, and only fires if the page is alive.
     3. navigator.vibrate(), which iOS does not implement at all. Left in so the
        app behaves properly if it's ever opened on Android. */

import * as db from './db.js';

export const PRESETS = [60, 90, 120, 180];
export const DEFAULT_REST = 120;

let audioCtx = null;

/* Must be called from inside a user gesture or iOS refuses to start audio. */
export function unlockAudio() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const start = audioCtx.currentTime;

  for (let i = 0; i < 3; i++) {
    const at = start + i * 0.26;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.value = 880;

    // Ramp rather than switch, or it clicks.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.22);
  }
}

export function notificationsAvailable() {
  return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
}

export function notificationState() {
  if (!notificationsAvailable()) return 'unsupported';
  return Notification.permission;
}

/* Ask from a tap, never on load — iOS rejects it outright otherwise. */
export async function requestNotifications() {
  if (!notificationsAvailable()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

async function notify() {
  try {
    if (!notificationsAvailable() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.showNotification('Rest is up', {
      body: 'Next set.',
      tag: 'liftlog-rest',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    });
  } catch {
    /* Notifications are a bonus, never the mechanism. */
  }
}

export function fireAlert() {
  beep();
  notify();
  try { navigator.vibrate?.([200, 120, 200]); } catch {}
}

/* ---------- persisted state ---------- */

export async function load() {
  return {
    endsAt: await db.getMeta('rest_ends_at', null),
    duration: await db.getMeta('rest_duration', DEFAULT_REST),
  };
}

export async function start(seconds) {
  const endsAt = Date.now() + seconds * 1000;
  await db.setMeta('rest_ends_at', endsAt);
  await db.setMeta('rest_duration', seconds);
  return endsAt;
}

export async function stop() {
  await db.setMeta('rest_ends_at', null);
}

export function remaining(endsAt) {
  if (!endsAt) return null;
  return Math.max(0, Math.round((endsAt - Date.now()) / 1000));
}

export function format(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
