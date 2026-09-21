/* v2 -> v3, which is the upgrade that actually runs on the phone: the installed
   app is on v2, holding real sessions, notes and locations. Nothing here may be
   lost when routines arrive. */

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

const stamp = (extra) => ({
  created_at: '2026-09-15T10:00:00.000Z',
  updated_at: '2026-09-15T10:00:00.000Z',
  dirty: 1,
  deleted: 0,
  ...extra,
});

/* ---------- build a v2 database ---------- */

const v2 = await new Promise((resolve, reject) => {
  const request = indexedDB.open('liftlog', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    const exercises = db.createObjectStore('exercises', { keyPath: 'id' });
    exercises.createIndex('by_key', 'name_key');
    const workouts = db.createObjectStore('workouts', { keyPath: 'id' });
    workouts.createIndex('by_started', 'started_at');
    const sets = db.createObjectStore('sets', { keyPath: 'id' });
    sets.createIndex('by_workout', 'workout_id');
    sets.createIndex('by_exercise', 'exercise_id');
    db.createObjectStore('places', { keyPath: 'id' });
    const notes = db.createObjectStore('exercise_notes', { keyPath: 'id' });
    notes.createIndex('by_exercise', 'exercise_id');
    notes.createIndex('by_workout', 'workout_id');
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const stores = ['exercises', 'workouts', 'sets', 'places', 'exercise_notes', 'meta'];
const tx = v2.transaction(stores, 'readwrite');

tx.objectStore('places').put(stamp({
  id: 'place-fenton', name: 'Planet Fitness — Fenton', lat: null, lng: null, radius_m: 250,
}));
tx.objectStore('exercises').put(stamp({
  id: 'ex-1', name: 'Barbell Bench Press', name_key: 'barbell bench press',
  muscle_group: 'Chest', tracks: 'weight_reps', is_custom: 0,
}));
tx.objectStore('exercises').put(stamp({
  id: 'ex-2', name: 'My Custom Lift', name_key: 'my custom lift',
  muscle_group: 'Other', tracks: 'weight_reps', is_custom: 1,
}));
tx.objectStore('workouts').put(stamp({
  id: 'w-1', started_at: '2026-09-15T10:00:00.000Z', ended_at: '2026-09-15T11:00:00.000Z',
  place_id: 'place-fenton', template_id: null, notes: '',
}));
tx.objectStore('sets').put(stamp({
  id: 's-1', workout_id: 'w-1', exercise_id: 'ex-1', set_index: 1,
  weight: 225, reps: 5, seconds: null, rpe: 9, failed: 0, is_warmup: 0, is_dropset: 0,
}));
tx.objectStore('sets').put(stamp({
  id: 's-2', workout_id: 'w-1', exercise_id: 'ex-1', set_index: 1,
  weight: 185, reps: 8, seconds: null, rpe: null, failed: 0, is_warmup: 0, is_dropset: 1,
}));
tx.objectStore('exercise_notes').put(stamp({
  id: 'n-1', workout_id: 'w-1', exercise_id: 'ex-1', body: 'Go up 10 next time',
}));
tx.objectStore('meta').put({ key: 'seeded_at', value: '2026-09-15T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'places_seeded_at', value: '2026-09-15T10:00:00.000Z' });
tx.objectStore('meta').put({ key: 'last_place_id', value: 'place-fenton' });

await new Promise((resolve) => { tx.oncomplete = resolve; });
v2.close();

/* ---------- open it with the current build ---------- */

const store = await import('../js/store.js');
const db = await import('../js/db.js');

await store.init();

const handle = await db.open();
check('upgraded to the current version', handle.version === 4, `got ${handle.version}`);
check('routine stores added',
  handle.objectStoreNames.contains('templates') &&
  handle.objectStoreNames.contains('template_exercises'));

// Everything that was there before.
const sets = await store.setsForWorkout('w-1');
check('both sets survived', sets.length === 2, `got ${sets.length}`);
check('the drop set kept its flag and its parent number',
  sets[1].is_dropset === 1 && sets[1].set_index === 1);
check('RPE survived', sets[0].rpe === 9);

check('the custom exercise survived',
  (await store.listExercises()).some((e) => e.id === 'ex-2'));
check('places were not re-seeded over the existing one',
  (await store.listPlaces()).length === 1);
check('the existing note survived',
  (await store.getNote('w-1', 'ex-1')).body === 'Go up 10 next time');
check('notes still resolve by location',
  (await store.lastNoteFor('ex-1', { placeId: 'place-fenton' }))?.sameLocation === true);

// Old workouts have no plan array; the session view must cope.
const workout = await db.get('workouts', 'w-1');
check('a pre-routines workout simply has no plan', workout.plan === undefined);

// And routines work on top of the migrated data.
const routine = await store.createTemplate({
  name: 'Push', place_id: 'place-fenton', exerciseIds: ['ex-1', 'ex-2'],
});
check('a routine can be built from migrated exercises',
  (await store.templateExercises(routine.id)).length === 2);

const started = await store.startWorkout({ templateId: routine.id });
check('and starts a pre-loaded session',
  started.plan.join(',') === 'ex-1,ex-2' && started.place_id === 'place-fenton');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
