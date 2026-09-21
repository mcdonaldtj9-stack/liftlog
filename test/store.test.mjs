/* Exercises the real store.js / db.js against a spec-compliant IndexedDB.
   Run with `npm test`. This is the only safety net that runs off-device, so it
   should cover anything where a silent data bug would cost a logged workout. */

import 'fake-indexeddb/auto';
import * as store from '../js/store.js';
import { shouldConfirmWeight, shouldConfirmReps, checkSet } from '../js/rules.js';

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


// ---------- places ----------

const places = await store.listPlaces();
check('seeds the three gyms', places.length === 3, `got ${places.length}`);
check('places start without coordinates', places.every((p) => p.lat === null && p.radius_m === 250));

const fenton = places.find((p) => p.name.includes('Fenton'));
const garage = places.find((p) => p.name.includes('Garage'));

const placed = await store.startWorkout();
await store.setWorkoutPlace(placed, fenton.id);
const reloaded = await store.getActiveWorkout();
check('workout takes a location', reloaded.place_id === fenton.id);

await store.finishWorkout(reloaded);
const nextOne = await store.startWorkout();
check('next session defaults to the last location used', nextOne.place_id === fenton.id);

// ---------- drop sets ----------

await store.addSet({ workout_id: nextOne.id, exercise_id: bench.id, weight: 225, reps: 5, rpe: 9 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: nextOne.id, exercise_id: bench.id, weight: 180, reps: 6, is_dropset: 1 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: nextOne.id, exercise_id: bench.id, weight: 135, reps: 8, is_dropset: 1 });
await new Promise((r) => setTimeout(r, 2));
const topSet2 = await store.addSet({ workout_id: nextOne.id, exercise_id: bench.id, weight: 225, reps: 4 });

const dropSets = await store.setsForWorkout(nextOne.id);
check('drops reuse the parent set number',
  dropSets.map((s) => s.set_index).join(',') === '1,1,1,2',
  dropSets.map((s) => s.set_index).join(','));
check('drops are flagged', dropSets.map((s) => s.is_dropset).join(',') === '0,1,1,0');
check('a drop does not inflate the next top set number', topSet2.set_index === 2);

// ---------- failed sets ----------

const failedSet = await store.addSet({
  workout_id: nextOne.id, exercise_id: bench.id, weight: 245, reps: 1, rpe: 9, failed: 1,
});
check('failure is recorded', failedSet.failed === 1);
check('a failed set carries no RPE', failedSet.rpe === null);

// ---------- notes ----------

await store.saveNote({ workout_id: nextOne.id, exercise_id: bench.id, body: 'Too light, +10 next time' });
check('note saves against the session and exercise',
  (await store.getNote(nextOne.id, bench.id)).body === 'Too light, +10 next time');

await store.saveNote({ workout_id: nextOne.id, exercise_id: bench.id, body: 'Edited' });
check('editing updates rather than duplicating',
  (await store.getNote(nextOne.id, bench.id)).body === 'Edited');

await store.finishWorkout(nextOne);

// A later session at the SAME gym should see that note.
const atFenton = await store.startWorkout();
await store.setWorkoutPlace(atFenton, fenton.id);
const seenAtFenton = await store.lastNoteFor(bench.id, {
  placeId: fenton.id, excludeWorkoutId: atFenton.id,
});
check('note comes back at the same location', seenAtFenton?.note.body === 'Edited');
check('and is marked as this location', seenAtFenton?.sameLocation === true);
check('and names the place', seenAtFenton?.place?.id === fenton.id);

// A session at a DIFFERENT gym falls back, but flags where it came from.
const seenAtGarage = await store.lastNoteFor(bench.id, {
  placeId: garage.id, excludeWorkoutId: atFenton.id,
});
check('falls back to another location when there is nothing local',
  seenAtGarage?.note.body === 'Edited');
check('and flags that it is from a different gym', seenAtGarage?.sameLocation === false);

check('no note for an exercise never commented on',
  (await store.lastNoteFor(plank.id, { placeId: fenton.id })) === null);

// The note is joined through its workout, so moving a session moves its notes.
await store.saveNote({ workout_id: atFenton.id, exercise_id: plank.id, body: 'Fenton specific' });
await store.setWorkoutPlace(atFenton, garage.id);
const afterMove = await store.lastNoteFor(plank.id, { placeId: garage.id });
check('a note follows its session when the location changes',
  afterMove?.note.body === 'Fenton specific' && afterMove.sameLocation === true);


// ---------- weight sanity check ----------

const lifting = { tracks: 'weight_reps' };
const bodyweight = { tracks: 'bodyweight_reps' };
const timed = { tracks: 'time' };
const ref = (weight) => ({ weight });

const jump = (weight, reference, exercise = lifting, extra = {}) =>
  shouldConfirmWeight({ weight, isWarmup: 0, isDrop: false, ...extra }, reference, exercise);

check('a 5.4% jump asks for confirmation', jump(195, ref(185)) !== null);
check('and reports the percentage', jump(195, ref(185)).percent === 5);
check('and carries both numbers',
  jump(195, ref(185)).value === 195 && jump(195, ref(185)).previous === 185);
check('a 2.7% jump passes silently', jump(190, ref(185)) === null);
check('exactly 5% passes', jump(105, ref(100)) === null);
check('over 5% but under 10 lbs stays quiet', jump(106, ref(100)) === null);
check('over 5% and over 10 lbs stops you', jump(111, ref(100)) !== null);
check('a big absolute jump under 5% stays quiet', jump(410, ref(400)) === null);
check('a 25% cable jump of 5 lbs stays quiet', jump(25, ref(20)) === null);
check('the same 25% on real weight stops you', jump(250, ref(200)) !== null);
check('a fat-fingered extra digit is caught', jump(1850, ref(185)).percent === 900);
check('same weight passes', jump(185, ref(185)) === null);
check('going down passes', jump(135, ref(185)) === null);

check('warmups are never checked', jump(315, ref(135), lifting, { isWarmup: 1 }) === null);
check('drop sets are never checked', jump(315, ref(135), lifting, { isDrop: true }) === null);
check('time-tracked exercises are never checked', jump(315, ref(135), timed) === null);
check('no history means no check', jump(315, null) === null);
check('a zero baseline is skipped rather than dividing', jump(25, ref(0), bodyweight) === null);
check('a null baseline weight is skipped', jump(25, ref(null), bodyweight) === null);
check('added bodyweight still checks against a real baseline',
  jump(45, ref(25), bodyweight) !== null);

// The baseline query must ignore warmups, drops and failures.
const refWorkout = await store.startWorkout();
const squat = seeded.find((e) => e.name === 'Back Squat');

await store.addSet({ workout_id: refWorkout.id, exercise_id: squat.id, weight: 135, reps: 5, is_warmup: 1 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: refWorkout.id, exercise_id: squat.id, weight: 225, reps: 5 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: refWorkout.id, exercise_id: squat.id, weight: 185, reps: 8, is_dropset: 1 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: refWorkout.id, exercise_id: squat.id, weight: 275, reps: 1, failed: 1 });

const baseline = await store.lastWorkSetFor(squat.id);
check('baseline skips warmup, drop and failed sets', baseline.weight === 225,
  `got ${baseline?.weight}`);
check('so the next work set compares against the real one',
  jump(230, baseline) === null);
check('but a genuine outlier still stops you', jump(315, baseline) !== null);

// A warmup-only history gives no baseline at all.
const freshWorkout = await store.startWorkout();
const curl = seeded.find((e) => e.name === 'Preacher Curl');
await store.addSet({ workout_id: refWorkout.id, exercise_id: curl.id, weight: 30, reps: 12, is_warmup: 1 });
check('warmups alone leave no baseline', (await store.lastWorkSetFor(curl.id)) === null);

await store.discardWorkout(await store.getActiveWorkout());


// ---------- rep sanity check ----------

const repRef = (reps) => ({ reps, weight: 185 });
const repJump = (reps, reference, exercise = lifting, extra = {}) =>
  shouldConfirmReps({ reps, isWarmup: 0, isDrop: false, ...extra }, reference, exercise);

check('a stuck key is caught', repJump(88, repRef(8)) !== null);
check('a big but not absurd count is reported as a jump',
  repJump(30, repRef(8)).reason === 'jump');
check('an absurd count is reported as implausible even with history',
  repJump(88, repRef(8)).reason === 'implausible');
check('12 reps after 8 is a rep scheme, not a typo', repJump(12, repRef(8)) === null);
check('20 after 10 is a burnout set, not a typo', repJump(20, repRef(10)) === null);
check('122 after 12 is caught', repJump(122, repRef(12)) !== null);
check('5 after 5 passes', repJump(5, repRef(5)) === null);
check('fewer reps passes', repJump(3, repRef(8)) === null);
check('30 after 8 is caught', repJump(30, repRef(8)) !== null);
check('15 after 5 needs both ratio and gap', repJump(15, repRef(5)) !== null);
check('12 after 4 clears the ratio but not the gap', repJump(12, repRef(4)) === null);

check('an implausible count is caught with no history at all',
  repJump(88, null) !== null);
check('and flagged as implausible', repJump(88, null).reason === 'implausible');
check('a plausible count with no history passes', repJump(12, null) === null);
check('50 passes, 51 does not',
  repJump(50, null) === null && repJump(51, null) !== null);

check('warmup reps are not compared', repJump(20, repRef(5), lifting, { isWarmup: 1 }) === null);
check('drop set reps are not compared', repJump(20, repRef(5), lifting, { isDrop: true }) === null);
check('but an implausible warmup is still caught',
  repJump(88, repRef(5), lifting, { isWarmup: 1 }) !== null);
check('time-tracked exercises are not rep checked', repJump(88, repRef(5), timed) === null);

// ---------- both at once ----------

const both = checkSet(
  { weight: 315, reps: 88, isWarmup: 0, isDrop: false }, { weight: 185, reps: 8 }, lifting);
check('a set wrong in two ways reports both', both.length === 2, `got ${both.length}`);
check('weight is listed first', both[0].kind === 'weight' && both[1].kind === 'reps');

const clean = checkSet(
  { weight: 190, reps: 8, isWarmup: 0, isDrop: false }, { weight: 185, reps: 8 }, lifting);
check('a normal set reports nothing', clean.length === 0);

const weightOnly = checkSet(
  { weight: 315, reps: 8, isWarmup: 0, isDrop: false }, { weight: 185, reps: 8 }, lifting);
check('only the weight is flagged when only it is odd',
  weightOnly.length === 1 && weightOnly[0].kind === 'weight');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
