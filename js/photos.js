/* Progress photos: a section on the Weight tab and a full-screen viewer.

   Photos are taken or picked through a plain file input, shrunk on the phone
   to a size that is sharp on its screen but small enough to keep (long edge
   1600px, JPEG), and stored as bytes in IndexedDB alongside a thumbnail for
   the grid. Each photo knows its date and pose — Front, Side, Back — so a
   comparison is always like with like, and shows the bodyweight trend on the
   day it was taken.

   Object URLs for the images are made once per photo and kept here. The
   Weight tab repaints itself on every drag across its chart; the grid must
   not decode forty JPEGs each time that happens. */

import * as store from './store.js';
import { DAY, escapeHTML, dayStart } from './chart.js';

const LONG_EDGE = 1600;
const THUMB_EDGE = 480;
const JPEG_QUALITY = 0.82;
const THUMB_QUALITY = 0.72;

const POSE_LABELS = { front: 'Front', side: 'Side', back: 'Back' };

const state = {
  photos: [],          // live, oldest first
  bytes: new Map(),    // id -> { hasFull, hasThumb }
  urls: new Map(),     // id -> { full, thumb } object URLs, made on demand
  pose: 'front',
  date: '',            // yyyy-mm-dd, '' = today
  busy: false,         // a file is being shrunk and stored
  error: null,
  viewer: null,        // { id, compare, confirmDelete }
  trendAt: () => null, // supplied by the Weight tab: trend lbs on a day
  onChange: () => {},  // the Weight tab repaints when photos change
};

let root = null;      // the section's container
const thumbTried = new Set();   // ids whose thumbnail was attempted, pass or fail
let overlay = null;   // the viewer, attached to <body> so it floats above all

/* ---------- helpers ---------- */

function todayInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* Now for today, else midday that day: well clear of midnight in any zone. */
function takenAtFor(dateValue) {
  if (!dateValue || dateValue === todayInputValue()) return new Date().toISOString();
  const [y, m, d] = dateValue.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0).toISOString();
}

function dateLabel(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function poseLabel(pose) {
  return POSE_LABELS[pose] || 'Front';
}

function weightLabel(photo) {
  const t = dayStart(new Date(photo.taken_at).getTime()) + DAY - 1;
  const lbs = state.trendAt(t);
  return lbs == null ? '' : `${Number(lbs).toFixed(1)} lbs`;
}

const byId = (id) => state.photos.find((p) => p.id === id) || null;

/* The earliest photo of the same pose, which is what you compare against. */
function baselineFor(photo) {
  return state.photos.find((p) => p.pose === photo.pose && p.id !== photo.id) || null;
}

/* ---------- image work ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image this phone can open."));
    };
    img.src = url;
  });
}

function drawTo(img, longEdge, quality) {
  const scale = Math.min(1, longEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Couldn't encode the photo."));
      blob.arrayBuffer().then((buffer) => resolve({ buffer, width, height }));
    }, 'image/jpeg', quality);
  });
}

/* Shrink a picked file to the sizes we keep. The <img> route (rather than
   createImageBitmap) is deliberate: Safari applies the EXIF orientation
   there, so a portrait shot stays portrait. */
export async function processImage(file) {
  const { img, release } = await loadImage(file);
  try {
    const full = await drawTo(img, LONG_EDGE, JPEG_QUALITY);
    const thumb = await drawTo(img, THUMB_EDGE, THUMB_QUALITY);
    return {
      full: full.buffer, thumb: thumb.buffer,
      width: full.width, height: full.height, mime: 'image/jpeg',
    };
  } finally {
    release();
  }
}

/* A thumbnail for bytes that arrived from Storage without one. */
async function makeThumb(id) {
  const row = await store.getPhotoBytes(id);
  if (!row || row.thumb) return;
  const file = new Blob([row.full], { type: row.mime || 'image/jpeg' });
  const { img, release } = await loadImage(file);
  try {
    const thumb = await drawTo(img, THUMB_EDGE, THUMB_QUALITY);
    await store.savePhotoThumb(id, thumb.buffer);
  } finally {
    release();
  }
}

/* ---------- object urls ---------- */

async function urlFor(id, kind) {
  const have = state.urls.get(id) || {};
  if (have[kind]) return have[kind];
  const row = await store.getPhotoBytes(id);
  if (!row) return null;
  const bytes = kind === 'thumb' ? (row.thumb || row.full) : row.full;
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: row.mime || 'image/jpeg' }));
  state.urls.set(id, { ...have, [kind]: url });
  return url;
}

function forget(id) {
  const have = state.urls.get(id);
  if (!have) return;
  for (const url of Object.values(have)) if (url) URL.revokeObjectURL(url);
  state.urls.delete(id);
}

/* ---------- data ---------- */

export async function refresh() {
  state.photos = await store.listPhotos();
  state.bytes = new Map();
  for (const photo of state.photos) {
    const row = await store.getPhotoBytes(photo.id);
    state.bytes.set(photo.id, { hasFull: Boolean(row), hasThumb: Boolean(row?.thumb) });
  }
  // Drop urls for anything gone.
  for (const id of [...state.urls.keys()]) if (!byId(id)) forget(id);
  // Thumbnails are made for anything that came down without one, then the
  // grid is painted again with them in place.
  const needThumb = state.photos.filter((p) => {
    const b = state.bytes.get(p.id);
    return b?.hasFull && !b.hasThumb && !thumbTried.has(p.id);
  });
  if (needThumb.length) {
    // Tried once only: a file that won't decode shows at full size rather
    // than sending this loop round again on every refresh.
    for (const photo of needThumb) thumbTried.add(photo.id);
    (async () => {
      for (const photo of needThumb) {
        try { await makeThumb(photo.id); } catch { /* a bad file stays full-size */ }
      }
      await refresh();
      render();
    })();
  }
  // Grid urls are resolved up front, so render() itself can stay synchronous.
  for (const photo of state.photos) {
    if (state.bytes.get(photo.id)?.hasFull) await urlFor(photo.id, 'thumb');
  }
}

/* ---------- rendering ---------- */

function renderTile(photo) {
  const url = state.urls.get(photo.id)?.thumb;
  const caption = `${escapeHTML(dateLabel(photo.taken_at))}${weightLabel(photo) ? ` · ${weightLabel(photo)}` : ''}`;
  return `
    <li class="ph-tile">
      <button class="ph-tile-btn" data-act="ph-open" data-id="${photo.id}"
              aria-label="Open photo from ${escapeHTML(dateLabel(photo.taken_at))}">
        ${url
          ? `<img src="${url}" alt="" loading="lazy" decoding="async">`
          : `<span class="ph-tile-wait">Waiting for sync</span>`}
        <span class="ph-tile-pose">${poseLabel(photo.pose)}</span>
        <span class="ph-tile-cap">${caption}</span>
      </button>
    </li>`;
}

export function render() {
  if (!root) return;

  const chips = store.POSES.map((pose) => `
    <button class="chip ${state.pose === pose ? 'is-on' : ''}" data-act="ph-pose" data-pose="${pose}">
      ${poseLabel(pose)}
    </button>`).join('');

  const tiles = [...state.photos].reverse().map(renderTile).join('');

  root.innerHTML = `
    <h3 class="section-label">Progress photos</h3>
    <section class="ph-entry">
      <div class="field">
        <label>Pose</label>
        <div class="chips">${chips}</div>
      </div>
      <div class="field ph-date">
        <label for="phDate">Taken</label>
        <input id="phDate" class="search" type="date" max="${todayInputValue()}"
               value="${escapeHTML(state.date || todayInputValue())}">
      </div>
      <label class="btn btn-quiet btn-block ph-add ${state.busy ? 'is-busy' : ''}">
        ${state.busy ? 'Saving photo…' : '+ Add photo'}
        <input id="phFile" type="file" accept="image/*" ${state.busy ? 'disabled' : ''}>
      </label>
      ${state.error ? `<p class="hint warn">${escapeHTML(state.error)}</p>` : ''}
    </section>
    ${state.photos.length
      ? `<ul class="ph-grid">${tiles}</ul>`
      : `<p class="hint">Same pose, same light, same spot each time — the scale
         can't see what these can.</p>`}`;

  renderViewer();
}

function pane(photo, url) {
  return `
    <figure class="ph-pane">
      ${url ? `<img src="${url}" alt="">` : '<div class="ph-pane-wait">Waiting for sync</div>'}
      <figcaption>
        <strong>${escapeHTML(dateLabel(photo.taken_at))}</strong>
        <span>${poseLabel(photo.pose)}${weightLabel(photo) ? ` · ${weightLabel(photo)}` : ''}</span>
      </figcaption>
    </figure>`;
}

function renderViewer() {
  const v = state.viewer;
  const photo = v && byId(v.id);
  if (!photo) {
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.classList.remove('ph-viewing');
    return;
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'ph-viewer';
    overlay.addEventListener('click', onClick);
    document.body.appendChild(overlay);
    document.body.classList.add('ph-viewing');
  }

  const baseline = v.compare ? baselineFor(photo) : null;
  const panes = baseline
    ? pane(baseline, state.urls.get(baseline.id)?.full) + pane(photo, state.urls.get(photo.id)?.full)
    : pane(photo, state.urls.get(photo.id)?.full);

  const footer = v.confirmDelete ? `
    <div class="confirm ph-confirm">
      <p>Delete this photo?</p>
      <div class="confirm-actions">
        <button class="btn btn-quiet" data-act="ph-del-cancel">Keep</button>
        <button class="btn btn-danger" data-act="ph-del-confirm">Delete</button>
      </div>
    </div>` : `
    <div class="ph-actions">
      <button class="btn btn-quiet ${v.compare ? 'is-on' : ''}" data-act="ph-compare"
              ${baselineFor(photo) ? '' : 'disabled'}>
        ${v.compare ? 'Just this one' : 'Compare with first'}
      </button>
      <button class="btn-link danger" data-act="ph-del">Delete</button>
    </div>`;

  overlay.innerHTML = `
    <div class="ph-viewer-head">
      <span>${escapeHTML(dateLabel(photo.taken_at))} · ${poseLabel(photo.pose)}</span>
      <button class="btn-link" data-act="ph-close">Done</button>
    </div>
    <div class="ph-panes ${baseline ? 'is-pair' : ''}">${panes}</div>
    ${footer}`;
}

/* ---------- events ---------- */

async function openViewer(id) {
  const photo = byId(id);
  if (!photo) return;
  await urlFor(id, 'full');
  const baseline = baselineFor(photo);
  if (baseline) await urlFor(baseline.id, 'full');
  state.viewer = { id, compare: false, confirmDelete: false };
  renderViewer();
}

async function addFile(file) {
  if (!file) return;
  const dateField = root.querySelector('#phDate');
  if (dateField) state.date = dateField.value;
  state.busy = true;
  state.error = null;
  render();
  try {
    const image = await processImage(file);
    await store.addPhoto({
      taken_at: takenAtFor(state.date),
      pose: state.pose,
      ...image,
    });
    state.date = '';
    await refresh();
    state.onChange();
  } catch (error) {
    state.error = error.message || String(error);
  } finally {
    state.busy = false;
    render();
  }
}

/* True when the tap was ours, so the Weight tab leaves it alone. */
export async function onClick(event) {
  const trigger = event.target.closest('[data-act^="ph-"]');
  if (!trigger) return false;
  const { act } = trigger.dataset;

  switch (act) {
    case 'ph-pose':
      state.pose = trigger.dataset.pose;
      render();
      return true;

    case 'ph-open':
      await openViewer(trigger.dataset.id);
      return true;

    case 'ph-close':
      state.viewer = null;
      renderViewer();
      return true;

    case 'ph-compare':
      if (state.viewer) state.viewer.compare = !state.viewer.compare;
      renderViewer();
      return true;

    case 'ph-del':
      if (state.viewer) state.viewer.confirmDelete = true;
      renderViewer();
      return true;

    case 'ph-del-cancel':
      if (state.viewer) state.viewer.confirmDelete = false;
      renderViewer();
      return true;

    case 'ph-del-confirm': {
      const photo = state.viewer && byId(state.viewer.id);
      if (photo) {
        await store.deletePhoto(photo);
        forget(photo.id);
      }
      state.viewer = null;
      await refresh();
      render();
      state.onChange();
      return true;
    }
  }
  return false;
}

export function onChange(event) {
  if (event.target.id !== 'phFile') return false;
  const file = event.target.files?.[0];
  addFile(file);
  return true;
}

export function onInput(event) {
  if (event.target.id !== 'phDate') return false;
  state.date = event.target.value;
  return true;
}

/* ---------- lifecycle ---------- */

/* `trendAt(t)` gives the bodyweight trend on a day; `onChange` lets the
   Weight tab know a photo came or went. */
export async function mount(element, { trendAt, onChange: changed } = {}) {
  root = element;
  if (trendAt) state.trendAt = trendAt;
  if (changed) state.onChange = changed;
  await refresh();
  render();
}

export function setTrend(trendAt) {
  state.trendAt = trendAt || (() => null);
}

export async function reload() {
  if (!root) return;
  await refresh();
  render();
}

export function count() {
  return state.photos.length;
}
