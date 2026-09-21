/* LiftLog — app shell: navigation, service-worker install, diagnostics. */

import * as train from './train.js';
import * as rest from './rest.js';

const BUILD = '9';

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
