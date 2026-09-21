/* v3 -> v4, the upgrade that runs on the phone when bodyweight arrives. The
   installed app is on v3 with real routines, targets and synced sessions;
   none of it may be disturbed. */

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

/* ---------- a v3 database, shaped exactly like the phone's ---------- */

const v3 = await new Promise((resolve, reject) => {
  const request = indexedDB.open('liftlog', 3);
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
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const names = ['exercises', 'workouts', 'sets', 'places', 'templates', 'template_exercises', 'meta'];
const tx = v3.transaction(names, 'readwrite');
tx.objectStore('places').put(stamp({ id: 'gym', name: 'Planet Fitness — Fenton', lat: null, lng: null, radius_m: 250 }));
tx.objectStore('exercises').put(stamp({ id: 'bench', name: 'Barbell Bench Press', name_key: 'barbell bench press', muscle_group: 'Chest', tracks: 'weight_reps', is_custom: 0 }));
tx.objectStore('templates').put(stamp({ id: 'push', name: 'Push', place_id: 'gym', position: 0 }));
tx.objectStore('template_exercises').put(stamp({ id: 'te1', template_id: 'push', exercise_id: 'bench', position: 0, target_sets: 3, target_reps: 8 }));
tx.objectStore('workouts').put(stamp({ id: 'w1', started_at: '2026-09-20T10:00:00.000Z', ended_at: '2026-09-20T11:00:00.000Z', place_id: 'gym', template_id: 'push', plan: ['bench'], notes: '' }));
tx.objectStore('sets').put(stamp({ id: 's1', workout_id: 'w1', exercise_id: 'bench', set_index: 1, weight: 185, reps: 8, seconds: null, rpe: 8, failed: 0, is_warmup: 0, is_dropset: 0 }));
tx.objectStore('meta').put({ key: 'seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'places_seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'sync_watermark_sets', value: '2026-09-20T11:00:00.000Z' });
await new Promise((resolve) => { tx.oncomplete = resolve; });
v3.close();

/* ---------- open with the current build ---------- */

const store = await import('../js/store.js');
const db = await import('../js/db.js');
await store.init();

const handle = await db.open();
check('upgraded to v4', handle.version === 4, `got ${handle.version}`);
check('the bodyweight store exists', handle.objectStoreNames.contains('bodyweights'));

check('the routine survived with its targets',
  (await store.templateExercises('push'))[0]?.row.target_reps === 8);
check('the session survived', (await store.setsForWorkout('w1'))[0]?.weight === 185);
check('synced records are not re-marked for upload',
  (await db.get('sets', 's1')).dirty === 0);
check('sync watermarks are kept, so history is not re-downloaded',
  (await db.getMeta('sync_watermark_sets')) === '2026-09-20T11:00:00.000Z');

const reading = await store.addWeight({ lbs: 184.6, place_id: 'gym' });
check('bodyweight works on the migrated database',
  (await store.listWeights()).length === 1 && reading.lbs === 184.6);
check('and remembers the scale', (await store.lastScaleId()) === 'gym');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
