/* Domain operations on top of db.js.
   Everything here writes to IndexedDB before the UI updates — iOS suspends
   standalone web apps aggressively, so nothing important lives in memory only. */

import * as db from './db.js';
import { SEED_EXERCISES } from './seed.js';

/* Collapse a name to a comparison key so "Incline  Bench" and "incline bench"
   are recognised as the same exercise. */
export function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ---------- setup ---------- */

export async function init() {
  await db.open();

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
    place_id: null, // step 3 fills this in; column exists now so it's a UI change
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

export async function addSet({ workout_id, exercise_id, weight, reps, seconds, rpe, is_warmup }) {
  const siblings = await db.getAllByIndex('sets', 'by_workout', workout_id);
  const forExercise = siblings.filter((s) => db.isLive(s) && s.exercise_id === exercise_id);

  const record = db.newRecord({
    workout_id,
    exercise_id,
    set_index: forExercise.length + 1,
    weight: weight ?? null,
    reps: reps ?? null,
    seconds: seconds ?? null,
    rpe: rpe ?? null,
    is_warmup: is_warmup ? 1 : 0,
  });
  await db.put('sets', record);
  return record;
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
