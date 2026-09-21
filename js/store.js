/* Domain operations on top of db.js.
   Everything here writes to IndexedDB before the UI updates — iOS suspends
   standalone web apps aggressively, so nothing important lives in memory only. */

import * as db from './db.js';
import { SEED_EXERCISES, SEED_PLACES } from './seed.js';

/* Collapse a name to a comparison key so "Incline  Bench" and "incline bench"
   are recognised as the same exercise. */
export function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ---------- setup ---------- */

export async function init() {
  await db.open();
  await seedPlaces();

  const seeded = await db.getMeta('seeded_at');
  if (seeded) return;

  const existing = await db.getAll('exercises');
  if (existing.length === 0) {
    const records = SEED_EXERCISES.map(([name, muscle_group, tracks]) =>
      db.newRecord({
        name,
        name_key: nameKey(name),
        muscle_group,
        tracks,
        is_custom: 0,
      })
    );
    await db.putMany('exercises', records);
  }

  await db.setMeta('seeded_at', db.nowISO());
}

/* Places arrived after the first release, so this is seeded on its own key
   rather than under seeded_at. */
async function seedPlaces() {
  if (await db.getMeta('places_seeded_at')) return;

  const existing = await db.getAll('places');
  if (existing.length === 0) {
    await db.putMany('places', SEED_PLACES.map((name) => db.newRecord({
      name,
      lat: null,          // captured on site in step 3
      lng: null,
      radius_m: 250,
    })));
  }

  await db.setMeta('places_seeded_at', db.nowISO());
}

/* ---------- places ---------- */

export async function listPlaces() {
  const all = await db.getAll('places');
  return all.filter(db.isLive).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createPlace(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Place needs a name');
  const record = db.newRecord({ name: trimmed, lat: null, lng: null, radius_m: 250 });
  await db.put('places', record);
  return record;
}

export async function setWorkoutPlace(workout, placeId) {
  const next = db.touch(workout, { place_id: placeId || null });
  await db.put('workouts', next);
  // You're usually back at the same gym, so make it the default next time.
  if (placeId) await db.setMeta('last_place_id', placeId);
  return next;
}

/* ---------- exercises ---------- */

export async function listExercises() {
  const all = await db.getAll('exercises');
  return all
    .filter(db.isLive)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function findExercise(name) {
  const matches = await db.getAllByIndex('exercises', 'by_key', nameKey(name));
  return matches.find(db.isLive) || null;
}

export async function createExercise({ name, muscle_group = 'Other', tracks = 'weight_reps' }) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Exercise needs a name');

  const existing = await findExercise(trimmed);
  if (existing) return existing;

  const record = db.newRecord({
    name: trimmed,
    name_key: nameKey(trimmed),
    muscle_group,
    tracks,
    is_custom: 1,
  });
  await db.put('exercises', record);
  return record;
}

export async function updateExercise(exercise, changes) {
  const next = db.touch(exercise, changes);
  if (changes.name) next.name_key = nameKey(changes.name);
  await db.put('exercises', next);
  return next;
}

export async function deleteExercise(exercise) {
  const next = db.touch(exercise, { deleted: 1 });
  await db.put('exercises', next);
  return next;
}

/* ---------- workouts ---------- */

export async function getActiveWorkout() {
  const all = await db.getAll('workouts');
  const open = all.filter((w) => db.isLive(w) && !w.ended_at);
  // Newest wins if something ever went sideways and left two open.
  open.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return open[0] || null;
}

export async function startWorkout() {
  const existing = await getActiveWorkout();
  if (existing) return existing;

  const record = db.newRecord({
    started_at: db.nowISO(),
    ended_at: null,
    place_id: await db.getMeta('last_place_id', null),
    template_id: null,
    notes: '',
  });
  await db.put('workouts', record);
  return record;
}

export async function finishWorkout(workout) {
  const next = db.touch(workout, { ended_at: db.nowISO() });
  await db.put('workouts', next);
  return next;
}

export async function discardWorkout(workout) {
  const sets = await setsForWorkout(workout.id);
  if (sets.length) {
    await db.putMany('sets', sets.map((s) => db.touch(s, { deleted: 1 })));
  }
  const next = db.touch(workout, { deleted: 1 });
  await db.put('workouts', next);
  return next;
}

export async function recentWorkouts(limit = 20) {
  const all = await db.getAll('workouts');
  return all
    .filter((w) => db.isLive(w) && w.ended_at)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit);
}

/* ---------- sets ---------- */

export async function setsForWorkout(workoutId) {
  const rows = await db.getAllByIndex('sets', 'by_workout', workoutId);
  // Display order comes from created_at, never from set_index — deleting a set
  // must not renumber the ones around it. Tie-break so two sets logged inside
  // the same millisecond still have a stable, repeatable order.
  return rows.filter(db.isLive).sort((a, b) =>
    a.created_at.localeCompare(b.created_at) ||
    (a.set_index - b.set_index) ||
    a.id.localeCompare(b.id));
}

export async function addSet({
  workout_id, exercise_id, weight, reps, seconds,
  rpe, failed, is_warmup, is_dropset,
}) {
  const siblings = await db.getAllByIndex('sets', 'by_workout', workout_id);
  const forExercise = siblings.filter((s) => db.isLive(s) && s.exercise_id === exercise_id);

  let set_index;
  if (is_dropset && forExercise.length) {
    // A drop continues the set it hangs off, so it shares that set's number
    // rather than claiming one of its own.
    const parent = forExercise.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    set_index = parent.set_index;
  } else {
    // Only top sets are numbered, so drops never inflate the count.
    set_index = forExercise.filter((s) => !s.is_dropset).length + 1;
  }

  const record = db.newRecord({
    workout_id,
    exercise_id,
    set_index,
    weight: weight ?? null,
    reps: reps ?? null,
    seconds: seconds ?? null,
    rpe: failed ? null : (rpe ?? null),   // a failed set has no RPE
    failed: failed ? 1 : 0,
    is_warmup: is_warmup ? 1 : 0,
    is_dropset: is_dropset ? 1 : 0,
  });
  await db.put('sets', record);
  return record;
}

/* ---------- per-exercise session notes ----------
   One note per (workout, exercise). Place is NOT copied onto the note: it is
   joined through the workout at read time, so changing a session's location
   can never leave a note pointing at the wrong gym. */

export async function getNote(workoutId, exerciseId) {
  const rows = await db.getAllByIndex('exercise_notes', 'by_workout', workoutId);
  return rows.find((n) => db.isLive(n) && n.exercise_id === exerciseId) || null;
}

export async function saveNote({ workout_id, exercise_id, body }) {
  const text = String(body ?? '');
  const existing = await getNote(workout_id, exercise_id);

  if (existing) {
    const next = db.touch(existing, { body: text });
    await db.put('exercise_notes', next);
    return next;
  }

  const record = db.newRecord({ workout_id, exercise_id, body: text });
  await db.put('exercise_notes', record);
  return record;
}

/* The note you wrote last time you did this exercise, preferring the one from
   this same location. Returns the note, the workout it came from, its place,
   and whether that place matches where you are now. */
export async function lastNoteFor(exerciseId, { placeId = null, excludeWorkoutId = null } = {}) {
  const rows = await db.getAllByIndex('exercise_notes', 'by_exercise', exerciseId);
  const candidates = rows.filter((n) =>
    db.isLive(n) && n.body.trim() && n.workout_id !== excludeWorkoutId);
  if (!candidates.length) return null;

  const workouts = new Map(
    (await db.getAll('workouts')).filter(db.isLive).map((w) => [w.id, w]));
  const places = new Map(
    (await db.getAll('places')).filter(db.isLive).map((p) => [p.id, p]));

  const enriched = candidates
    .map((note) => {
      const workout = workouts.get(note.workout_id);
      if (!workout) return null;
      return {
        note,
        workout,
        place: workout.place_id ? places.get(workout.place_id) || null : null,
        sameLocation: Boolean(placeId) && workout.place_id === placeId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.workout.started_at.localeCompare(a.workout.started_at));

  // Prefer this location; otherwise fall back to the most recent anywhere and
  // let the UI say where it came from.
  return enriched.find((e) => e.sameLocation) || enriched[0];
}

export async function updateSet(set, changes) {
  const next = db.touch(set, changes);
  await db.put('sets', next);
  return next;
}

export async function deleteSet(set) {
  const next = db.touch(set, { deleted: 1 });
  await db.put('sets', next);
  return next;
}

/* Most recent live set for an exercise, for prefilling. Includes sets logged
   earlier in the current workout — "same as last time" is usually what you want
   between sets. */
export async function lastSetFor(exerciseId) {
  const rows = await db.getAllByIndex('sets', 'by_exercise', exerciseId);
  const live = rows.filter(db.isLive);
  if (!live.length) return null;
  live.sort((a, b) =>
    b.created_at.localeCompare(a.created_at) ||
    (b.set_index - a.set_index) ||
    b.id.localeCompare(a.id));
  return live[0];
}

/* The last set that counts as a working set, used as the baseline for the
   "is that weight a typo?" check. Warmups, drop sets and failures are all
   excluded: comparing a work set against a warmup would prompt every time you
   finish warming up, and a failed 245 should not make 250 look reasonable.
   Sets from the current session are included, so a within-session 185 -> 195
   compares against the 185 you just did. */
export async function lastWorkSetFor(exerciseId) {
  const rows = await db.getAllByIndex('sets', 'by_exercise', exerciseId);
  const working = rows.filter((s) =>
    db.isLive(s) && !s.is_warmup && !s.is_dropset && !s.failed);
  if (!working.length) return null;
  working.sort((a, b) =>
    b.created_at.localeCompare(a.created_at) ||
    (b.set_index - a.set_index) ||
    b.id.localeCompare(a.id));
  return working[0];
}

/* Exercise ids ordered by how recently you've used them, for the picker. */
export async function exerciseUsage() {
  const rows = await db.getAll('sets');
  const lastUsed = new Map();
  for (const row of rows) {
    if (!db.isLive(row)) continue;
    const prev = lastUsed.get(row.exercise_id);
    if (!prev || row.created_at > prev) lastUsed.set(row.exercise_id, row.created_at);
  }
  return lastUsed;
}
