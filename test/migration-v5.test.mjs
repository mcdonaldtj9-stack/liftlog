/* v5 -> v6, the upgrade that runs on the phone when progress photos arrive.
   The installed app is on v5 with the weight goal saved and everything
   synced; none of it may be disturbed, and photos must work straight away. */

import 'fake-indexeddb/auto';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const stamp = (extra) => ({
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z',
  dirty: 0, deleted: 0, ...extra,
});

/* ---------- a v5 database, shaped exactly like the phone's ---------- */

const v5 = await new Promise((resolve, reject) => {
  const request = indexedDB.open('liftlog', 5);
  request.onupgradeneeded = () => {
    const db = request.result;
    const idx = (store, pairs) => pairs.forEach(([n, k]) => store.createIndex(n, k));
    idx(db.createObjectStore('exercises', { keyPath: 'id' }),
      [['by_key', 'name_key'], ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('workouts', { keyPath: 'id' }),
      [['by_started', 'started_at'], ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('sets', { keyPath: 'id' }),
      [['by_workout', 'workout_id'], ['by_exercise', 'exercise_id'],
       ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('places', { keyPath: 'id' }),
      [['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('exercise_notes', { keyPath: 'id' }),
      [['by_exercise', 'exercise_id'], ['by_workout', 'workout_id'],
       ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('templates', { keyPath: 'id' }),
      [['by_place', 'place_id'], ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('template_exercises', { keyPath: 'id' }),
      [['by_template', 'template_id'], ['by_exercise', 'exercise_id'],
       ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('bodyweights', { keyPath: 'id' }),
      [['by_weighed', 'weighed_at'], ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    idx(db.createObjectStore('settings', { keyPath: 'id' }),
      [['by_key', 'key'], ['by_updated', 'updated_at'], ['by_dirty', 'dirty']]);
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const names = ['exercises', 'workouts', 'sets', 'places', 'bodyweights', 'settings', 'meta'];
const tx = v5.transaction(names, 'readwrite');
tx.objectStore('places').put(stamp({ id: 'gym', name: 'Planet Fitness — Fenton', lat: null, lng: null, radius_m: 250 }));
tx.objectStore('exercises').put(stamp({ id: 'bench', name: 'Barbell Bench Press', name_key: 'barbell bench press', muscle_group: 'Chest', tracks: 'weight_reps', is_custom: 0 }));
tx.objectStore('workouts').put(stamp({ id: 'w1', started_at: '2026-09-20T10:00:00.000Z', ended_at: '2026-09-20T11:00:00.000Z', place_id: 'gym', template_id: null, plan: ['bench'], notes: '' }));
tx.objectStore('sets').put(stamp({ id: 's1', workout_id: 'w1', exercise_id: 'bench', set_index: 1, weight: 185, reps: 8, seconds: null, rpe: 8, failed: 0, is_warmup: 0, is_dropset: 0, is_pr: 0 }));
tx.objectStore('bodyweights').put(stamp({ id: 'bw1', weighed_at: '2026-09-26T12:00:00.000Z', lbs: 188.2, place_id: 'gym' }));
tx.objectStore('settings').put(stamp({
  id: '6c1f7a52-2d3e-4b8a-9f01-000000000001', key: 'weight_goal',
  value: { start_date: '2026-09-26', start_lbs: 188, goal_date: '2027-02-27', goal_lbs: 165, band_lbs: 2 },
}));
tx.objectStore('meta').put({ key: 'seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'places_seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'sync_watermark_settings', value: '2026-09-27T12:00:00.000Z' });
await new Promise((resolve) => { tx.oncomplete = resolve; });
v5.close();

/* ---------- open with the current build ---------- */

const store = await import('../js/store.js');
const db = await import('../js/db.js');
await store.init();

const handle = await db.open();
check('upgraded to v6', handle.version === 6, `got ${handle.version}`);
check('the photo stores exist',
  handle.objectStoreNames.contains('photos') && handle.objectStoreNames.contains('photo_blobs'));
check('the older stores are all still there',
  ['exercises', 'workouts', 'sets', 'places', 'exercise_notes', 'templates', 'template_exercises',
   'bodyweights', 'settings', 'meta'].every((name) => handle.objectStoreNames.contains(name)));

check('the weigh-in survived', (await store.listWeights())[0]?.lbs === 188.2);
check('the session survived', (await store.setsForWorkout('w1'))[0]?.weight === 185);
check('the saved goal survived', (await store.getSetting('weight_goal'))?.goal_lbs === 165);
check('synced records are not re-marked for upload',
  (await db.get('sets', 's1')).dirty === 0 && (await db.get('bodyweights', 'bw1')).dirty === 0);
check('sync watermarks are kept',
  (await db.getMeta('sync_watermark_settings')) === '2026-09-27T12:00:00.000Z');

check('no photos to begin with', (await store.listPhotos()).length === 0);
const shot = await store.addPhoto({
  taken_at: '2026-10-06T12:00:00.000Z', pose: 'front', full: new Uint8Array(100).buffer,
});
check('a photo can be added on the migrated database',
  shot.dirty === 1 && (await store.getPhotoBytes(shot.id))?.full.byteLength === 100);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
