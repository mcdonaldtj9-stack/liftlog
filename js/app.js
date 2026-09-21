/* LiftLog — app shell: navigation, service-worker install, diagnostics. */

import * as train from './train.js';

const BUILD = '2';

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

if (navigator.storage?.persist) {
  navigator.storage.persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .then((granted) => setText('storageState', granted ? 'Persistent ✓' : 'Best effort'))
    .catch(() => setText('storageState', 'Unknown'));
} else {
  setText('storageState', 'Not supported');
}

/* ---------- boot ---------- */

train.mount(document.getElementById('view-train')).catch((err) => {
  console.error('[liftlog] failed to start', err);
  document.getElementById('view-train').innerHTML =
    `<div class="empty"><h2>Couldn't open the database</h2>
     <p>${String(err && err.message ? err.message : err)}</p></div>`;
});

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
