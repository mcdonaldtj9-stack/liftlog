/* LiftLog — app shell: navigation, service-worker install, diagnostics. */

import * as train from './train.js';
import * as weight from './weight.js';
import * as history from './historyview.js';
import * as rest from './rest.js';
import * as supa from './supa.js';
import * as sync from './sync.js';
import * as backup from './export.js';
import * as db from './db.js';

const BUILD = '22';

const views = {
  train:    { el: document.getElementById('view-train'),    title: 'Train' },
  history:  { el: document.getElementById('view-history'),  title: 'History' },
  weight:   { el: document.getElementById('view-weight'),   title: 'Bodyweight' },
  settings: { el: document.getElementById('view-settings'), title: 'Settings' },
};

const viewTitle = document.getElementById('viewTitle');

function show(name) {
  if (!views[name]) return;
  for (const [key, view] of Object.entries(views)) {
    view.el.hidden = key !== name;
  }
  viewTitle.textContent = views[name].title;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === name);
  }
  try { sessionStorage.setItem('view', name); } catch {}
  // The chart sizes itself to its container, which measures zero while hidden.
  if (name === 'weight') weight.reload();
  if (name === 'history') history.reload();
  if (name === 'settings') prepareExport();
}

document.getElementById('tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) show(tab.dataset.view);
});

try {
  const last = sessionStorage.getItem('view');
  if (last) show(last);
} catch {}

/* The fixed tab bar sits exactly where the iOS keyboard appears. Get it out of
   the way while a field is focused, or it covers what you're typing. */
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input, textarea')) document.body.classList.add('kb-open');
});
document.addEventListener('focusout', () => {
  document.body.classList.remove('kb-open');
});

/* ---------- diagnostics ---------- */

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

setText('buildStamp', `#${BUILD}`);

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;
setText('displayMode', standalone ? 'Installed ✓' : 'In browser');

/* getPropertyValue on a custom property hands back the literal "env(...)"
   string, so measure a probe element instead to get the resolved pixels. */
function resolvedInset(side) {
  const probe = document.createElement('div');
  probe.style.cssText =
    `position:fixed;left:-9999px;top:0;width:0;` +
    `height:env(safe-area-inset-${side},0px);`;
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(px);
}

function reportGeometry() {
  setText('safeArea',
    `t${resolvedInset('top')} b${resolvedInset('bottom')} ` +
    `l${resolvedInset('left')} r${resolvedInset('right')}`);
  setText('viewportSize', `${window.innerWidth}×${window.innerHeight}`);
  setText('screenSize',
    `${screen.width}×${screen.height} @${window.devicePixelRatio}`);

  const vv = window.visualViewport;
  setText('visualVp', vv
    ? `${Math.round(vv.width)}×${Math.round(vv.height)} top${Math.round(vv.offsetTop)}`
    : 'Not supported');

  const os = navigator.userAgent.match(/OS (\d+(?:_\d+)*)/);
  setText('iosVersion', os ? os[1].replace(/_/g, '.') : 'Unknown');
}

reportGeometry();
window.addEventListener('resize', reportGeometry);
window.addEventListener('orientationchange', reportGeometry);

if (navigator.storage?.persist) {
  navigator.storage.persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .then((granted) => setText('storageState', granted ? 'Persistent ✓' : 'Best effort'))
    .catch(() => setText('storageState', 'Unknown'));
} else {
  setText('storageState', 'Not supported');
}

/* ---------- rest alerts ---------- */

const NOTIFY_LABEL = {
  granted: 'On ✓',
  denied: 'Blocked in iOS Settings',
  default: 'Not enabled',
  unsupported: 'Not supported',
};

function showNotifyState() {
  const state = rest.notificationState();
  setText('notifyState', NOTIFY_LABEL[state] || state);
  const button = document.getElementById('enableNotify');
  if (button) button.hidden = state !== 'default';
}

showNotifyState();

document.getElementById('enableNotify')?.addEventListener('click', async () => {
  await rest.requestNotifications();
  rest.unlockAudio();   // same tap also unlocks audio for the beep
  showNotifyState();
});

/* ---------- boot ---------- */

history.mount(document.getElementById('view-history')).catch((err) => {
  console.error('[liftlog] history view failed to start', err);
});

/* Recent sessions on the Train tab open the full session in History. */
document.addEventListener('liftlog:open-session', async (event) => {
  show('history');
  await history.openSession(event.detail.id);
});

weight.mount(document.getElementById('view-weight')).catch((err) => {
  console.error('[liftlog] weight view failed to start', err);
});

train.mount(document.getElementById('view-train')).catch((err) => {
  console.error('[liftlog] failed to start', err);
  document.getElementById('view-train').innerHTML =
    `<div class="empty"><h2>Couldn't open the database</h2>
     <p>${String(err && err.message ? err.message : err)}</p></div>`;
});

/* ---------- sync ---------- */

const el = (id) => document.getElementById(id);

function setMessage(text, tone = '') {
  const node = el('syncMessage');
  if (!node) return;
  node.textContent = text || '';
  node.className = `hint ${tone}`;
}

function relativeTime(iso) {
  if (!iso) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return new Date(iso).toLocaleDateString();
}

let forcingSetup = false;

async function refreshSyncUI() {
  const state = await sync.status();

  const showSetup = forcingSetup || !state.configured;
  el('syncSetup').hidden = !showSetup;
  el('syncLogin').hidden = showSetup || state.signedIn;
  el('syncActions').hidden = showSetup || !state.signedIn;

  el('syncState').textContent = !state.configured
    ? 'Not set up'
    : state.signedIn ? 'On ✓' : 'Signed out';
  el('syncAccount').textContent = state.email || '—';
  el('syncLast').textContent = relativeTime(state.lastSyncAt);
  el('syncPending').textContent = state.pending === 0 ? 'Nothing' : String(state.pending);

  if (state.lastError && state.signedIn) setMessage(state.lastError, 'warn');
  return state;
}

/* Sync, then repaint the Train tab if anything came down. Never runs while a
   sheet is open; the next trigger will catch it. */
async function runSync({ quiet = false } = {}) {
  if (document.body.classList.contains('sheet-open')) return null;

  if (!quiet) setMessage('Syncing…');
  const result = await sync.syncNow();

  if (result.ok) {
    if (result.pulled > 0) {
      await train.reload();
      await weight.reload();
      await history.reload();
    }
    if (!quiet) {
      setMessage(result.pushed || result.pulled
        ? `Sent ${result.pushed}, received ${result.pulled}.`
        : 'Already up to date.');
    }
  } else if (!quiet) {
    const words = {
      offline: 'No connection — your work is saved and will go up later.',
      'signed-out': result.message || 'Signed out. Sign in again to resume syncing.',
      unconfigured: 'Add your Supabase details first.',
    };
    setMessage(words[result.reason] || result.message || 'Sync failed.', 'warn');
  }

  await refreshSyncUI();
  return result;
}

el('saveSupa')?.addEventListener('click', async () => {
  const url = el('supaUrl').value.trim();
  const anonKey = el('supaKey').value.trim();
  if (!url || !anonKey) return setMessage('Both the URL and the key are needed.', 'warn');

  await supa.setConfig({ url, anonKey });
  forcingSetup = false;
  setMessage('Saved. Now sign in with the user you created in Supabase.');
  await refreshSyncUI();
});

el('editSupa')?.addEventListener('click', async () => {
  forcingSetup = true;
  const { url, anonKey } = await supa.getConfig();
  el('supaUrl').value = url;
  el('supaKey').value = anonKey;
  await refreshSyncUI();
});

el('doSignIn')?.addEventListener('click', async () => {
  const email = el('supaEmail').value.trim();
  const password = el('supaPassword').value;
  if (!email || !password) return setMessage('Email and password, please.', 'warn');

  setMessage('Signing in…');
  try {
    await supa.signIn(email, password);
    el('supaPassword').value = '';
    // A fresh sign-in may be a fresh install: forget the watermarks so the
    // first sync pulls the whole history rather than only what changed since.
    await sync.resetWatermarks();
    await refreshSyncUI();
    await runSync();
  } catch (error) {
    setMessage(error.message || 'Sign in failed.', 'warn');
    await refreshSyncUI();
  }
});

el('doSync')?.addEventListener('click', () => runSync());

el('doSignOut')?.addEventListener('click', async () => {
  await supa.signOut();
  setMessage('Signed out. Your data stays on this phone.');
  await refreshSyncUI();
});

refreshSyncUI();

/* Triggers: opening the app, coming back to it, and regaining signal. A debounce
   stops a quick tab-out-and-back from firing several at once. */
let syncTimer = null;
function scheduleSync(delay = 400) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync({ quiet: true }), delay);
}

scheduleSync(1200);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(800);
});
window.addEventListener('online', () => scheduleSync(500));

/* ---------- your data: export and restore ---------- */

/* The files are built ahead of time, whenever Settings is opened. iOS only lets
   a tap open the share sheet if nothing asynchronous happens between the tap
   and the share call, so there is no time to read the database then. */
let prepared = null;
let pendingImport = null;

function dataMessage(text, tone = '') {
  const node = el('dataMessage');
  node.textContent = text || '';
  node.className = `hint ${tone}`;
}

/* A hoisted lookup: show() can run for a remembered Settings tab before the
   rest of this module has finished evaluating. */
function byId(id) {
  return document.getElementById(id);
}

async function prepareExport() {
  byId('exportJson').disabled = true;
  byId('exportCsv').disabled = true;
  try {
    const tables = await backup.readAll();
    const json = JSON.stringify(backup.buildBackup(tables, { build: BUILD }), null, 1);
    prepared = {
      json,
      jsonFile: new File([json], backup.datedName('liftlog', 'json'), { type: 'application/json' }),
      csvFiles: [
        new File([backup.buildSetsCSV(tables)], backup.datedName('liftlog-sets', 'csv'), { type: 'text/csv' }),
        new File([backup.buildWeightsCSV(tables)], backup.datedName('liftlog-weight', 'csv'), { type: 'text/csv' }),
      ],
    };

    const live = (name) => tables[name].filter((r) => !r.deleted).length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const lastExport = await db.getMeta('last_export_at', null);
    byId('dataSummary').textContent = [
      plural(live('workouts'), 'session'),
      plural(live('sets'), 'set'),
      plural(live('bodyweights'), 'weigh-in'),
      plural(live('templates'), 'routine'),
    ].join(' · ') + (lastExport
      ? ` · last backed up ${new Date(lastExport).toLocaleDateString()}`
      : ' · never backed up');

    byId('exportJson').disabled = false;
    byId('exportCsv').disabled = false;
  } catch (error) {
    byId('dataSummary').textContent = `Couldn't read your data: ${error.message}`;
  }
}

/* Called straight from the tap, with nothing awaited first. */
function offer(files, title) {
  backup.share(files, title)
    .then(async () => {
      await db.setMeta('last_export_at', new Date().toISOString());
      dataMessage('Saved.', '');
      prepareExport();
    })
    .catch((error) => {
      if (error?.name === 'AbortError') return;          // you closed the share sheet
      if (error?.message === 'unsupported') {
        el('exportText').value = prepared.json;
        el('exportFallback').hidden = false;
        return;
      }
      dataMessage(`Couldn't share: ${error.message}`, 'warn');
    });
}

el('exportJson').addEventListener('click', () => {
  if (prepared) offer([prepared.jsonFile], 'LiftLog backup');
});

el('exportCsv').addEventListener('click', () => {
  if (prepared) offer(prepared.csvFiles, 'LiftLog spreadsheets');
});

el('exportCopy').addEventListener('click', () => {
  navigator.clipboard?.writeText(prepared?.json || '')
    .then(() => dataMessage('Copied.'))
    .catch(() => {
      el('exportText').select();
      dataMessage('Select all and copy.', '');
    });
});

el('importPick').addEventListener('click', () => el('importFile').click());

el('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const parsed = backup.parseBackup(await file.text());
    const plan = backup.planImport(parsed, await backup.readAll());
    const preview = el('importPreview');

    if (!plan.total) {
      preview.hidden = true;
      dataMessage('Nothing to restore: everything in that backup is already here, or older than what is.');
      return;
    }

    pendingImport = plan;
    const labels = {
      workouts: 'session', sets: 'set', bodyweights: 'weigh-in', templates: 'routine',
      exercises: 'exercise', places: 'location', exercise_notes: 'note',
      template_exercises: 'routine entry',
    };
    const parts = Object.entries(plan.counts).filter(([, n]) => n)
      .map(([name, n]) => `${n} ${labels[name]}${n === 1 ? '' : 's'}`);
    const taken = new Date(parsed.exported_at).toLocaleDateString();

    preview.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'confirm';
    const lead = document.createElement('p');
    lead.textContent = `Backup from ${taken}: ${parts.join(', ')} ${plan.total === 1 ? 'is' : 'are'} new or newer than what's on this phone. Anything you've changed since stays as it is.`;
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    actions.innerHTML = '<button class="btn btn-quiet" id="importCancel">Cancel</button>'
      + '<button class="btn" id="importApply">Merge it in</button>';
    box.append(lead, actions);
    preview.append(box);
    preview.hidden = false;
    dataMessage('');

    el('importCancel').addEventListener('click', () => {
      pendingImport = null;
      preview.hidden = true;
    });
    el('importApply').addEventListener('click', async () => {
      if (!pendingImport) return;
      const count = await backup.applyImport(pendingImport.plan);
      pendingImport = null;
      preview.hidden = true;
      dataMessage(`Restored ${count} ${count === 1 ? 'item' : 'items'}. They'll upload on the next sync.`);
      await Promise.all([train.reload(), weight.reload(), history.reload()]);
      prepareExport();
      scheduleSync(300);
    });
  } catch (error) {
    dataMessage(error.message, 'warn');
  }
});

prepareExport();

/* ---------- service worker ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => {
        setText('swState', 'Active ✓');
        document.getElementById('forceUpdate')?.addEventListener('click', async () => {
          setText('swState', 'Checking…');
          try {
            await reg.update();
            setText('swState', 'Up to date ✓');
          } catch {
            setText('swState', 'Check failed');
          }
        });
      })
      .catch(() => setText('swState', 'Failed'));

    // A new build took over — reload so you're never left on a stale screen.
    // Only when replacing an existing worker: on first install the controller
    // goes null -> active, and reloading there can loop.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      // Never yank the page out from under a set you're mid-way through
      // entering. The new worker is already active; the next launch picks it up.
      if (document.body.classList.contains('sheet-open')) return;
      reloading = true;
      window.location.reload();
    });
  });
} else {
  setText('swState', 'Not supported');
}
