/* v4 -> v5, the upgrade that runs on the phone when the weight goal arrives.
   The installed app is on v4 with weigh-ins and synced sessions; none of it
   may be disturbed, and the goal must work straight away. */

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

/* ---------- a v4 database, shaped exactly like the phone's ---------- */

const v4 = await new Promise((resolve, reject) => {
  const request = indexedDB.open('liftlog', 4);
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
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const names = ['exercises', 'workouts', 'sets', 'places', 'bodyweights', 'meta'];
const tx = v4.transaction(names, 'readwrite');
tx.objectStore('places').put(stamp({ id: 'gym', name: 'Planet Fitness — Fenton', lat: null, lng: null, radius_m: 250 }));
tx.objectStore('exercises').put(stamp({ id: 'bench', name: 'Barbell Bench Press', name_key: 'barbell bench press', muscle_group: 'Chest', tracks: 'weight_reps', is_custom: 0 }));
tx.objectStore('workouts').put(stamp({ id: 'w1', started_at: '2026-09-20T10:00:00.000Z', ended_at: '2026-09-20T11:00:00.000Z', place_id: 'gym', template_id: null, plan: ['bench'], notes: '' }));
tx.objectStore('sets').put(stamp({ id: 's1', workout_id: 'w1', exercise_id: 'bench', set_index: 1, weight: 185, reps: 8, seconds: null, rpe: 8, failed: 0, is_warmup: 0, is_dropset: 0, is_pr: 0 }));
tx.objectStore('bodyweights').put(stamp({ id: 'bw1', weighed_at: '2026-09-26T12:00:00.000Z', lbs: 188.2, place_id: 'gym' }));
tx.objectStore('meta').put({ key: 'seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'places_seeded_at', value: '2026-09-20T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'last_scale_id', value: 'gym' });
tx.objectStore('meta').put({ key: 'sync_watermark_bodyweights', value: '2026-09-26T12:00:00.000Z' });
await new Promise((resolve) => { tx.oncomplete = resolve; });
v4.close();

/* ---------- open with the current build ---------- */

const store = await import('../js/store.js');
const db = await import('../js/db.js');
const { DEFAULT_GOAL } = await import('../js/goal.js');
await store.init();

const handle = await db.open();
check('upgraded to v5', handle.version === 5, `got ${handle.version}`);
check('the settings store exists', handle.objectStoreNames.contains('settings'));
check('the older stores are all still there',
  ['exercises', 'workouts', 'sets', 'places', 'exercise_notes', 'templates', 'template_exercises', 'bodyweights', 'meta']
    .every((name) => handle.objectStoreNames.contains(name)));

check('the weigh-in survived', (await store.listWeights())[0]?.lbs === 188.2);
check('and its scale is remembered', (await store.lastScaleId()) === 'gym');
check('the session survived', (await store.setsForWorkout('w1'))[0]?.weight === 185);
check('synced records are not re-marked for upload',
  (await db.get('sets', 's1')).dirty === 0 && (await db.get('bodyweights', 'bw1')).dirty === 0);
check('sync watermarks are kept, so history is not re-downloaded',
  (await db.getMeta('sync_watermark_bodyweights')) === '2026-09-26T12:00:00.000Z');

check('no goal record is seeded — the default applies until you save one',
  (await db.getAll('settings')).length === 0
  && (await store.getSetting('weight_goal', DEFAULT_GOAL)) === DEFAULT_GOAL);
const saved = await store.saveSetting('weight_goal', { ...DEFAULT_GOAL, goal_lbs: 170 });
check('saving a goal works on the migrated database',
  saved.dirty === 1 && (await store.getSetting('weight_goal')).goal_lbs === 170);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
