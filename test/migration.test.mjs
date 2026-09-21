/* The phone already has a v1 database with real sessions in it. Opening at v2
   must add the new stores without touching what's there, so this builds a v1
   database by hand, then lets the app open it. */

import 'fake-indexeddb/auto';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/* ---------- build a v1 database ---------- */

const v1 = await new Promise((resolve, reject) => {
  const request = indexedDB.open('liftlog', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    const exercises = db.createObjectStore('exercises', { keyPath: 'id' });
    exercises.createIndex('by_key', 'name_key');
    const workouts = db.createObjectStore('workouts', { keyPath: 'id' });
    workouts.createIndex('by_started', 'started_at');
    const sets = db.createObjectStore('sets', { keyPath: 'id' });
    sets.createIndex('by_workout', 'workout_id');
    sets.createIndex('by_exercise', 'exercise_id');
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const tx = v1.transaction(['exercises', 'workouts', 'sets', 'meta'], 'readwrite');
tx.objectStore('exercises').put({
  id: 'ex-1', name: 'Barbell Bench Press', name_key: 'barbell bench press',
  muscle_group: 'Chest', tracks: 'weight_reps', is_custom: 0,
  created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z',
  dirty: 1, deleted: 0,
});
tx.objectStore('workouts').put({
  id: 'w-1', started_at: '2026-09-01T10:00:00.000Z', ended_at: '2026-09-01T11:00:00.000Z',
  place_id: null, template_id: null, notes: '',
  created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T11:00:00.000Z',
  dirty: 1, deleted: 0,
});
tx.objectStore('sets').put({
  id: 's-1', workout_id: 'w-1', exercise_id: 'ex-1', set_index: 1,
  weight: 185, reps: 8, seconds: null, rpe: 8.5, is_warmup: 0,
  created_at: '2026-09-01T10:05:00.000Z', updated_at: '2026-09-01T10:05:00.000Z',
  dirty: 1, deleted: 0,
});
tx.objectStore('meta').put({ key: 'seeded_at', value: '2026-09-01T10:00:00.000Z' });
await new Promise((resolve) => { tx.oncomplete = resolve; });
v1.close();

/* ---------- now let the app open it ---------- */

const store = await import('../js/store.js');
const db = await import('../js/db.js');

await store.init();

const handle = await db.open();
check('database upgraded to v2', handle.version === 2, `got ${handle.version}`);
check('new stores created',
  handle.objectStoreNames.contains('places') &&
  handle.objectStoreNames.contains('exercise_notes'));

const workouts = await db.getAll('workouts');
check('existing workout survived', workouts.length === 1 && workouts[0].id === 'w-1');

const sets = await store.setsForWorkout('w-1');
check('existing set survived intact',
  sets.length === 1 && sets[0].weight === 185 && sets[0].rpe === 8.5);

const exercises = await store.listExercises();
check('pre-existing exercise still present',
  exercises.some((e) => e.id === 'ex-1'));
check('seeded exercises were not duplicated over it',
  exercises.filter((e) => e.name_key === 'barbell bench press').length === 1);

const places = await store.listPlaces();
check('places seeded on upgrade', places.length === 3, `got ${places.length}`);

// The new columns are absent on old rows; reading them must not throw.
check('old sets read fine without the new fields',
  sets[0].is_dropset === undefined && !sets[0].failed);

// And the new features work against the migrated data.
await store.saveNote({ workout_id: 'w-1', exercise_id: 'ex-1', body: 'from after the upgrade' });
check('notes work on a migrated workout',
  (await store.getNote('w-1', 'ex-1')).body === 'from after the upgrade');

const indexed = await db.getAllByIndex('sets', 'by_exercise', 'ex-1');
check('indexes still resolve after upgrade', indexed.length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
