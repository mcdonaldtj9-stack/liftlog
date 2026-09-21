/* Exercises the real store.js / db.js against a spec-compliant IndexedDB.
   Run with `npm test`. This is the only safety net that runs off-device, so it
   should cover anything where a silent data bug would cost a logged workout. */

import 'fake-indexeddb/auto';
import * as store from '../js/store.js';

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

// ---------- seeding ----------

await store.init();
const seeded = await store.listExercises();
check('seeds the starter exercise list', seeded.length > 50, `got ${seeded.length}`);
check('seeded exercises carry a muscle group', seeded.every((e) => e.muscle_group));
check('seeded exercises carry a tracks mode', seeded.every((e) => e.tracks));
check('sync metadata present', seeded.every((e) => e.id && e.updated_at && e.dirty === 1 && e.deleted === 0));

await store.init();
const afterSecondInit = await store.listExercises();
check('init is idempotent', afterSecondInit.length === seeded.length,
  `${seeded.length} -> ${afterSecondInit.length}`);

// ---------- custom exercises ----------

const custom = await store.createExercise({ name: '  Reverse Hyper  ' });
check('creates a custom exercise', custom.name === 'Reverse Hyper');
check('custom flagged', custom.is_custom === 1);

const dupe = await store.createExercise({ name: 'reverse   hyper' });
check('dedupes on a normalised name', dupe.id === custom.id);

const found = await store.findExercise('REVERSE HYPER');
check('finds case-insensitively', found?.id === custom.id);

// ---------- workouts ----------

check('no active workout at rest', (await store.getActiveWorkout()) === null);

const workout = await store.startWorkout();
check('starts a workout', Boolean(workout.id));
check('workout opens unfinished', workout.ended_at === null);
check('place_id column exists for step 3', 'place_id' in workout);

const again = await store.startWorkout();
check('start is idempotent while one is open', again.id === workout.id);

// ---------- sets ----------

const bench = seeded.find((e) => e.name === 'Barbell Bench Press');
const plank = seeded.find((e) => e.name === 'Plank');

await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 135, reps: 10, rpe: 6.5, is_warmup: 1 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 185, reps: 8, rpe: 8 });
await new Promise((r) => setTimeout(r, 2));
const third = await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 185, reps: 7, rpe: 9 });

let sets = await store.setsForWorkout(workout.id);
check('logs three sets', sets.length === 3, `got ${sets.length}`);
check('set_index increments per exercise', sets.map((s) => s.set_index).join(',') === '1,2,3',
  sets.map((s) => s.set_index).join(','));
check('keeps RPE including halves', sets.map((s) => s.rpe).join(',') === '6.5,8,9');
check('keeps the warmup flag', sets[0].is_warmup === 1);
check('order is chronological', sets.map((s) => s.weight).join(',') === '135,185,185');

const last = await store.lastSetFor(bench.id);
check('prefill uses the most recent set', last.id === third.id && last.reps === 7);

// time-tracked exercise
await store.addSet({ workout_id: workout.id, exercise_id: plank.id, seconds: 45, rpe: 7 });
const plankLast = await store.lastSetFor(plank.id);
check('time-tracked set stores seconds', plankLast.seconds === 45 && plankLast.reps === null);
check('time set numbered independently', plankLast.set_index === 1);

// ---------- deletion ----------

await store.deleteSet(sets[1]);
sets = await store.setsForWorkout(workout.id);
const benchSets = sets.filter((s) => s.exercise_id === bench.id);
check('soft-deleted set disappears', benchSets.length === 2, `got ${benchSets.length}`);
check('survivors keep their original set_index',
  benchSets.map((s) => s.set_index).join(',') === '1,3',
  benchSets.map((s) => s.set_index).join(','));
check('live query never returns tombstones', sets.every((s) => s.deleted === 0));

// ---------- finish ----------

await store.finishWorkout(workout);
check('finishing clears the active workout', (await store.getActiveWorkout()) === null);

const recent = await store.recentWorkouts();
check('finished workout appears in recents', recent.length === 1 && recent[0].id === workout.id);

// ---------- usage ordering ----------

const usage = await store.exerciseUsage();
check('usage map tracks exercises used', usage.has(bench.id) && usage.has(plank.id));

// ---------- discard ----------

const throwaway = await store.startWorkout();
await store.addSet({ workout_id: throwaway.id, exercise_id: bench.id, weight: 95, reps: 5 });
await store.discardWorkout(throwaway);
check('discard clears the active workout', (await store.getActiveWorkout()) === null);
check('discard removes its sets', (await store.setsForWorkout(throwaway.id)).length === 0);
check('discard stays out of recents',
  (await store.recentWorkouts()).every((w) => w.id !== throwaway.id));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
