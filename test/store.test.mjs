/* Exercises the real store.js / db.js against a spec-compliant IndexedDB.
   Run with `npm test`. This is the only safety net that runs off-device, so it
   should cover anything where a silent data bug would cost a logged workout. */

import 'fake-indexeddb/auto';
import * as store from '../js/store.js';
import {
  shouldConfirmWeight, shouldConfirmReps, checkSet,
  effectiveReps, estimate1RM, bestE1RM, suggestWeight, modeOf,
} from '../js/rules.js';

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


// ---------- routines ----------

const press = seeded.find((e) => e.name === 'Overhead Press');
const pushdown = seeded.find((e) => e.name === 'Tricep Pushdown');
const pecDeck = seeded.find((e) => e.name === 'Pec Deck');

const pushPF = await store.createTemplate({
  name: 'Push', place_id: fenton.id,
  exerciseIds: [bench.id, press.id, pushdown.id],
});
check('creates a routine', pushPF.name === 'Push' && pushPF.place_id === fenton.id);

const listed = await store.templateExercises(pushPF.id);
check('keeps the exercises in order',
  listed.map((e) => e.exercise.name).join(' / ') === 'Barbell Bench Press / Overhead Press / Tricep Pushdown',
  listed.map((e) => e.exercise.name).join(' / '));

// The same day at a different gym is its own routine.
const pushGarage = await store.createTemplate({
  name: 'Push', place_id: garage.id, exerciseIds: [bench.id, press.id],
});
check('the same name can exist per location', pushGarage.id !== pushPF.id);
check('routines list separately', (await store.listTemplates()).length === 2);

// Reordering and swapping.
await store.setTemplateExercises(pushPF.id, [press.id, bench.id, pecDeck.id]);
const reordered = await store.templateExercises(pushPF.id);
check('reorders and swaps exercises',
  reordered.map((e) => e.exercise.name).join(' / ') === 'Overhead Press / Barbell Bench Press / Pec Deck',
  reordered.map((e) => e.exercise.name).join(' / '));
check('the dropped exercise is gone', reordered.length === 3);

await store.setTemplateExercises(pushPF.id, [press.id, press.id, bench.id]);
check('duplicates collapse', (await store.templateExercises(pushPF.id)).length === 2);
await store.setTemplateExercises(pushPF.id, [bench.id, press.id, pushdown.id]);

// A deleted exercise must not leave a blank row behind.
const doomed = await store.createExercise({ name: 'Machine That Broke' });
await store.setTemplateExercises(pushGarage.id, [bench.id, doomed.id]);
check('routine holds both before deletion',
  (await store.templateExercises(pushGarage.id)).length === 2);
await store.deleteExercise(await store.findExercise('Machine That Broke'));
check('a deleted exercise drops out of the routine',
  (await store.templateExercises(pushGarage.id)).length === 1);

// ---------- starting from a routine ----------

await store.discardWorkout(await store.getActiveWorkout());
check('discarding nothing is harmless', (await store.discardWorkout(null)) === null);
const fromTemplate = await store.startWorkout({ templateId: pushPF.id });
check('session records which routine it came from', fromTemplate.template_id === pushPF.id);
check('session is pre-loaded with the exercises',
  fromTemplate.plan.join(',') === [bench.id, press.id, pushdown.id].join(','));
check('session takes the routine location', fromTemplate.place_id === fenton.id);

// Adding and removing exercises during the session.
const withExtra = await store.addToPlan(fromTemplate, pecDeck.id);
check('an added exercise joins the plan', withExtra.plan.length === 4);
check('adding twice is a no-op',
  (await store.addToPlan(withExtra, pecDeck.id)).plan.length === 4);
const trimmed = await store.removeFromPlan(withExtra, pushdown.id);
check('an exercise can be dropped from the plan',
  trimmed.plan.join(',') === [bench.id, press.id, pecDeck.id].join(','));

check('starting is still idempotent while a session is open',
  (await store.startWorkout({ templateId: pushGarage.id })).id === fromTemplate.id);

// ---------- saving a session as a routine ----------

await store.addSet({ workout_id: trimmed.id, exercise_id: bench.id, weight: 185, reps: 8 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: trimmed.id, exercise_id: bench.id, weight: 185, reps: 7, is_dropset: 1 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: trimmed.id, exercise_id: press.id, weight: 95, reps: 8 });

const saved = await store.createTemplateFromWorkout(
  await store.getActiveWorkout(), 'Push (saved)');
const savedList = await store.templateExercises(saved.id);
check('a session becomes a routine',
  savedList.map((e) => e.exercise.name).join(' / ') === 'Barbell Bench Press / Overhead Press',
  savedList.map((e) => e.exercise.name).join(' / '));
check('a drop set does not duplicate its exercise', savedList.length === 2);
check('the routine inherits the session location', saved.place_id === fenton.id);
check('planned-but-unused exercises are left out',
  !savedList.some((e) => e.exercise.id === pecDeck.id));

// ---------- deleting a routine ----------

const before = (await store.listTemplates()).length;
await store.deleteTemplate(saved);
check('deleting removes it from the list',
  (await store.listTemplates()).length === before - 1);
check('and takes its exercise rows with it',
  (await store.templateExercises(saved.id)).length === 0);

await store.discardWorkout(await store.getActiveWorkout());


// ---------- estimated 1RM ----------

const nowISO = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const workSet = (extra) => ({
  weight: 185, reps: 8, rpe: 8, failed: 0, is_warmup: 0, is_dropset: 0,
  created_at: nowISO, ...extra,
});

check('RPE counts reps left in reserve', effectiveReps(workSet({})) === 10);
check('a set at RPE 10 has none in reserve', effectiveReps(workSet({ rpe: 10 })) === 8);
check('no RPE is treated as none in reserve', effectiveReps(workSet({ rpe: null })) === 8);

check('e1RM from 185 x 8 @ 8 is about 247',
  Math.round(estimate1RM(workSet({}))) === 247, `got ${estimate1RM(workSet({}))}`);
check('the same set without RPE estimates lower',
  estimate1RM(workSet({ rpe: null })) < estimate1RM(workSet({})));
check('a failed set is not evidence of strength',
  estimate1RM(workSet({ failed: 1 })) === null);
check('a warmup is not evidence either',
  estimate1RM(workSet({ is_warmup: 1 })) === null);
check('bodyweight with no load gives nothing',
  estimate1RM(workSet({ weight: 0 })) === null);
check('too many effective reps declines to answer',
  estimate1RM(workSet({ reps: 12, rpe: 6 })) === null);
check('right at the limit still answers',
  estimate1RM(workSet({ reps: 12, rpe: 10 })) !== null);

// Recency.
check('a recent set counts', bestE1RM([workSet({ created_at: daysAgo(10) })]) !== null);
check('a stale set is ignored entirely',
  bestE1RM([workSet({ created_at: daysAgo(90) })]) === null);
check('the best recent set wins',
  Math.round(bestE1RM([
    workSet({ weight: 185, created_at: daysAgo(5) }),
    workSet({ weight: 205, created_at: daysAgo(2) }),
  ])) === 273);
check('a stale peak cannot beat recent work',
  Math.round(bestE1RM([
    workSet({ weight: 315, created_at: daysAgo(120) }),
    workSet({ weight: 185, created_at: daysAgo(2) }),
  ])) === 247);
check('no qualifying sets gives no estimate', bestE1RM([]) === null);

// ---------- weight suggestions ----------

const e1rm = estimate1RM(workSet({}));
check('suggesting for the same reps returns the same weight',
  suggestWeight(e1rm, 8) === 185, `got ${suggestWeight(e1rm, 8)}`);
check('fewer reps suggests more weight', suggestWeight(e1rm, 5) === 200);
check('more reps suggests less weight', suggestWeight(e1rm, 12) === 170);
check('heavier weights round to 5', suggestWeight(400, 5) % 5 === 0);
check('lighter weights round to 2.5', suggestWeight(80, 10) === 57.5);
check('no estimate means no suggestion', suggestWeight(null, 8) === null);
check('no target reps means no suggestion', suggestWeight(e1rm, null) === null);
check('a lower target RPE suggests a lighter weight',
  suggestWeight(e1rm, 8, 6) < suggestWeight(e1rm, 8, 8));

// ---------- inferring targets from a session ----------

check('the common rep count wins', modeOf([8, 8, 7]) === 8);
check('a tie has no winner', modeOf([5, 8]) === null);
check('a single value is its own mode', modeOf([5]) === 5);
check('nothing in, nothing out', modeOf([]) === null);

// ---------- targets on routines ----------

const targeted = await store.createTemplate({
  name: 'Targets', place_id: null,
  exercises: [
    { exercise_id: bench.id, target_sets: 3, target_reps: 8 },
    { exercise_id: press.id, target_sets: 4, target_reps: 6 },
  ],
});
const targetRows = await store.templateExercises(targeted.id);
check('targets are stored per exercise',
  targetRows[0].row.target_sets === 3 && targetRows[0].row.target_reps === 8);
check('and differ per exercise',
  targetRows[1].row.target_sets === 4 && targetRows[1].row.target_reps === 6);

check('plain ids still work and mean no target',
  (await store.templateExercises(
    (await store.createTemplate({ name: 'Untargeted', exerciseIds: [bench.id] })).id
  ))[0].row.target_sets === null);

await store.discardWorkout(await store.getActiveWorkout());
const targetedSession = await store.startWorkout({ templateId: targeted.id });
const sessionTargets = await store.targetsForWorkout(targetedSession);
check('a session exposes its routine targets',
  sessionTargets.get(bench.id).sets === 3 && sessionTargets.get(bench.id).reps === 8);
check('a session with no routine has no targets',
  (await store.targetsForWorkout({ template_id: null })).size === 0);

// Saving a session infers its targets from what was actually done.
await store.addSet({ workout_id: targetedSession.id, exercise_id: bench.id, weight: 185, reps: 8, rpe: 8 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: targetedSession.id, exercise_id: bench.id, weight: 185, reps: 8, rpe: 9 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: targetedSession.id, exercise_id: bench.id, weight: 185, reps: 7, rpe: 10 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: targetedSession.id, exercise_id: bench.id, weight: 135, reps: 12, is_warmup: 1 });

const inferred = await store.createTemplateFromWorkout(
  await store.getActiveWorkout(), 'Inferred');
const inferredRows = await store.templateExercises(inferred.id);
check('inferred sets count only working sets',
  inferredRows[0].row.target_sets === 3, `got ${inferredRows[0].row.target_sets}`);
check('inferred reps take the most common value',
  inferredRows[0].row.target_reps === 8, `got ${inferredRows[0].row.target_reps}`);

// And the estimate is available for the suggestion.
const benchE1RM = await store.bestE1RMFor(bench.id);
check('an estimate is available after real sets', benchE1RM > 0);
check('which produces a usable suggestion', suggestWeight(benchE1RM, 5) > 0);

await store.discardWorkout(await store.getActiveWorkout());


// ---------- discarding takes its notes with it ----------

await store.discardWorkout(await store.getActiveWorkout());
const noteSession = await store.startWorkout();
await store.saveNote({ workout_id: noteSession.id, exercise_id: bench.id, body: 'gone with the session' });
await store.discardWorkout(noteSession);
check('discarding a session deletes its notes',
  (await store.getNote(noteSession.id, bench.id)) === null);

// A stray left behind by an older build is swept on the next start.
const { put: rawPut, get: rawGet, newRecord } = await import('../js/db.js');
const strayWorkout = newRecord({ started_at: new Date().toISOString(), ended_at: null, deleted: 1 });
await rawPut('workouts', strayWorkout);
const strayNote = newRecord({ workout_id: strayWorkout.id, exercise_id: bench.id, body: 'stray' });
await rawPut('exercise_notes', strayNote);
await store.init();
check('a stray note on a deleted session is swept at start',
  (await rawGet('exercise_notes', strayNote.id)).deleted === 1);
check('and marked for upload so the server hears about it',
  (await rawGet('exercise_notes', strayNote.id)).dirty === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
