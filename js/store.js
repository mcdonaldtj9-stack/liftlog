/* Domain operations on top of db.js.
   Everything here writes to IndexedDB before the UI updates — iOS suspends
   standalone web apps aggressively, so nothing important lives in memory only. */

import * as db from './db.js';
import { SEED_EXERCISES, SEED_PLACES } from './seed.js';
import { bestE1RM, modeOf } from './rules.js';

/* Collapse a name to a comparison key so "Incline  Bench" and "incline bench"
   are recognised as the same exercise. */
export function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ---------- setup ---------- */

export async function init() {
  await db.open();
  await seedPlaces();
  await sweepOrphanNotes();

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

/* Builds before this one discarded a session's sets but not its notes. Tidy
   any strays so they stop occupying the server. Cheap enough to run on every
   start, and a no-op once there is nothing to find. */
async function sweepOrphanNotes() {
  const notes = (await db.getAll('exercise_notes')).filter(db.isLive);
  if (!notes.length) return 0;

  const workouts = new Map((await db.getAll('workouts')).map((w) => [w.id, w]));
  const orphans = notes.filter((n) => workouts.get(n.workout_id)?.deleted);
  if (orphans.length) {
    await db.putMany('exercise_notes', orphans.map((n) => db.touch(n, { deleted: 1 })));
  }
  return orphans.length;
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

export function lastPlaceId() {
  return db.getMeta('last_place_id', null);
}

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

/* ---------- templates ----------
   A template is a named exercise list — your Push day, your Pull day. It can
   belong to a location, because the same day is a different list of exercises
   at a commercial gym than it is in a garage. */

export async function listTemplates() {
  const all = await db.getAll('templates');
  return all.filter(db.isLive).sort((a, b) =>
    (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
}

export async function getTemplate(id) {
  const row = await db.get('templates', id);
  return db.isLive(row) ? row : null;
}

/* Ordered exercises for a template, with any since-deleted exercise dropped
   rather than rendering as a blank row. */
export async function templateExercises(templateId) {
  const rows = (await db.getAllByIndex('template_exercises', 'by_template', templateId))
    .filter(db.isLive)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const exercises = new Map((await listExercises()).map((e) => [e.id, e]));
  return rows
    .map((row) => ({ row, exercise: exercises.get(row.exercise_id) || null }))
    .filter((entry) => entry.exercise);
}

/* Accepts either bare exercise ids or {exercise_id, target_sets, target_reps}
   objects, so callers that don't care about targets stay simple. */
export async function setTemplateExercises(templateId, entries) {
  const seen = new Set();
  const wanted = [];
  for (const entry of entries) {
    const item = typeof entry === 'string' ? { exercise_id: entry } : entry;
    if (!item?.exercise_id || seen.has(item.exercise_id)) continue;
    seen.add(item.exercise_id);
    wanted.push({
      exercise_id: item.exercise_id,
      target_sets: item.target_sets ?? null,
      target_reps: item.target_reps ?? null,
    });
  }

  const existing = (await db.getAllByIndex('template_exercises', 'by_template', templateId))
    .filter(db.isLive);
  const byExercise = new Map(existing.map((row) => [row.exercise_id, row]));

  const writes = [];
  wanted.forEach((item, position) => {
    const row = byExercise.get(item.exercise_id);
    const fields = {
      position,
      target_sets: item.target_sets,
      target_reps: item.target_reps,
    };
    if (row) {
      writes.push(db.touch(row, fields));
      byExercise.delete(item.exercise_id);
    } else {
      writes.push(db.newRecord({
        template_id: templateId,
        exercise_id: item.exercise_id,
        ...fields,
      }));
    }
  });
  // Whatever is left was removed from the template.
  for (const orphan of byExercise.values()) writes.push(db.touch(orphan, { deleted: 1 }));

  if (writes.length) await db.putMany('template_exercises', writes);
  return wanted;
}

export async function createTemplate({ name, place_id = null, exerciseIds = [], exercises = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Template needs a name');

  const siblings = await listTemplates();
  const record = db.newRecord({
    name: trimmed,
    place_id: place_id || null,
    position: siblings.length,
  });
  await db.put('templates', record);
  await setTemplateExercises(record.id, exercises || exerciseIds);
  return record;
}

export async function updateTemplate(template, changes) {
  const next = db.touch(template, changes);
  await db.put('templates', next);
  return next;
}

export async function deleteTemplate(template) {
  const rows = (await db.getAllByIndex('template_exercises', 'by_template', template.id))
    .filter(db.isLive);
  if (rows.length) {
    await db.putMany('template_exercises', rows.map((r) => db.touch(r, { deleted: 1 })));
  }
  const next = db.touch(template, { deleted: 1 });
  await db.put('templates', next);
  return next;
}

/* Build a template out of a session you've already done — far quicker than
   assembling one by hand, and the order is the order you actually trained in. */
export async function createTemplateFromWorkout(workout, name) {
  const sets = await setsForWorkout(workout.id);
  const fromSets = [...new Set(sets.map((s) => s.exercise_id))];
  // plan order wins where it exists; anything logged outside it is appended.
  const planned = (workout.plan || []).filter((id) => fromSets.includes(id));
  const extra = fromSets.filter((id) => !planned.includes(id));

  // Targets come from what you actually did: how many working sets, and the
  // rep count you hit most often. A session of 8, 8, 7 becomes a 3 x 8 target.
  const exercises = [...planned, ...extra].map((exercise_id) => {
    const working = sets.filter((s) =>
      s.exercise_id === exercise_id && !s.is_warmup && !s.is_dropset);
    return {
      exercise_id,
      target_sets: working.length || null,
      target_reps: modeOf(working.map((s) => s.reps).filter((r) => r > 0)),
    };
  });

  return createTemplate({ name, place_id: workout.place_id || null, exercises });
}

/* ---------- bodyweight ----------
   Each reading remembers which scale it came from, because scales disagree and
   the trend corrects for it. The scale is a place id, or null for "somewhere
   else". */

export async function listWeights() {
  const all = await db.getAll('bodyweights');
  return all.filter(db.isLive).sort((a, b) => a.weighed_at.localeCompare(b.weighed_at));
}

export async function addWeight({ lbs, place_id = null, weighed_at = db.nowISO() }) {
  const value = Number(lbs);
  if (!(value > 0)) throw new Error('Weight needs to be a positive number');
  const record = db.newRecord({ lbs: value, place_id: place_id || null, weighed_at });
  await db.put('bodyweights', record);
  await db.setMeta('last_scale_id', place_id || 'other');
  return record;
}

export async function deleteWeight(reading) {
  const next = db.touch(reading, { deleted: 1 });
  await db.put('bodyweights', next);
  return next;
}

/* Most recent reading on one particular scale — prefill comes from here, not
   from the last reading overall, since the two scales read differently. */
export async function lastWeightOn(placeId) {
  const readings = await listWeights();
  const wanted = placeId || null;
  for (let i = readings.length - 1; i >= 0; i--) {
    if ((readings[i].place_id || null) === wanted) return readings[i];
  }
  return null;
}

export async function lastScaleId() {
  const value = await db.getMeta('last_scale_id', null);
  return value === 'other' ? null : value;
}

/* ---------- strength estimates ---------- */

/* Best recent estimated 1RM for an exercise, or null when nothing in the
   window qualifies. */
export async function bestE1RMFor(exerciseId) {
  const rows = await db.getAllByIndex('sets', 'by_exercise', exerciseId);
  return bestE1RM(rows.filter(db.isLive));
}

/* Targets for every exercise in this session's routine, keyed by exercise. */
export async function targetsForWorkout(workout) {
  const targets = new Map();
  if (!workout?.template_id) return targets;

  for (const { row, exercise } of await templateExercises(workout.template_id)) {
    if (row.target_sets || row.target_reps) {
      targets.set(exercise.id, { sets: row.target_sets, reps: row.target_reps });
    }
  }
  return targets;
}

/* ---------- the session's exercise list ---------- */

export async function addToPlan(workout, exerciseId) {
  const plan = workout.plan || [];
  if (plan.includes(exerciseId)) return workout;
  const next = db.touch(workout, { plan: [...plan, exerciseId] });
  await db.put('workouts', next);
  return next;
}

export async function removeFromPlan(workout, exerciseId) {
  const plan = workout.plan || [];
  if (!plan.includes(exerciseId)) return workout;
  const next = db.touch(workout, { plan: plan.filter((id) => id !== exerciseId) });
  await db.put('workouts', next);
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

export async function startWorkout({ templateId = null } = {}) {
  const existing = await getActiveWorkout();
  if (existing) return existing;

  let plan = [];
  let template = null;
  if (templateId) {
    template = await getTemplate(templateId);
    if (template) {
      plan = (await templateExercises(templateId)).map((entry) => entry.exercise.id);
    }
  }

  const record = db.newRecord({
    started_at: db.nowISO(),
    ended_at: null,
    // A template that belongs to a gym sets the location too, so starting the
    // day is one tap rather than two.
    place_id: template?.place_id || await db.getMeta('last_place_id', null),
    template_id: template?.id || null,
    plan,
    notes: '',
  });
  await db.put('workouts', record);
  if (record.place_id) await db.setMeta('last_place_id', record.place_id);
  return record;
}

export async function finishWorkout(workout) {
  if (!workout) return null;
  const next = db.touch(workout, { ended_at: db.nowISO() });
  await db.put('workouts', next);
  return next;
}

export async function discardWorkout(workout) {
  if (!workout) return null;
  const sets = await setsForWorkout(workout.id);
  if (sets.length) {
    await db.putMany('sets', sets.map((s) => db.touch(s, { deleted: 1 })));
  }
  // Notes belong to the session too. Leaving them live would strand them on
  // the server forever, attached to a workout that no longer exists.
  const notes = (await db.getAllByIndex('exercise_notes', 'by_workout', workout.id))
    .filter(db.isLive);
  if (notes.length) {
    await db.putMany('exercise_notes', notes.map((n) => db.touch(n, { deleted: 1 })));
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
