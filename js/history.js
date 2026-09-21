/* History aggregates. Pure functions over plain arrays — no DOM, no database —
   so the numbers can be tested, and so nothing is ever computed at sync time
   and cached where it could go stale. Everything derives on render.

   The recurring rule: a WORKING set is one that counts as evidence of what you
   can do. Warmups are deliberately light, drop sets are done fatigued, and a
   failed set is by definition not something you did. */

import { estimate1RM } from './rules.js';

const DAY = 24 * 60 * 60 * 1000;

/* Fixed training regions. Colour follows the region, never its rank, so the
   chart can't repaint itself when one week's mix changes. These also line up
   with a push / pull / legs split. */
export const REGIONS = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core'];
export const OTHER_REGION = 'Other';

const REGION_OF = {
  Chest: 'Chest',
  Back: 'Back',
  Shoulders: 'Shoulders',
  Biceps: 'Arms',
  Triceps: 'Arms',
  Quads: 'Legs',
  Hamstrings: 'Legs',
  Glutes: 'Legs',
  Calves: 'Legs',
  Core: 'Core',
};

export function regionOf(muscleGroup) {
  return REGION_OF[muscleGroup] || OTHER_REGION;
}

export function isWorkingSet(set) {
  return Boolean(set) && !set.deleted && !set.is_warmup && !set.is_dropset && !set.failed;
}

/* Local midnight on the Monday of the week containing t. */
export function weekStart(t) {
  const d = new Date(t);
  const offset = (d.getDay() + 6) % 7;          // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
}

function timeOf(set) {
  return new Date(set.created_at).getTime();
}

/* ---------- filtering ---------- */

/* Keep only sets from workouts at one place. `null` means everywhere. Sets
   whose workout is gone (discarded) are dropped regardless. */
export function filterByPlace(sets, workoutsById, placeId = null) {
  return sets.filter((set) => {
    const workout = workoutsById.get(set.workout_id);
    if (!workout || workout.deleted) return false;
    return placeId === null || workout.place_id === placeId;
  });
}

/* ---------- weekly volume ---------- */

/* Working sets per week, split by region AND by individual muscle, over the
   last `weeks` weeks ending with the current one. The current week is flagged
   partial: comparing six sets by Tuesday against last week's eighteen is a
   false alarm. */
export function weeklySets(sets, exercisesById, { weeks = 8, now = Date.now() } = {}) {
  const current = weekStart(now);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i--) {
    // Step by calendar days rather than 7 * DAY so a DST change can't drift it.
    const d = new Date(current);
    starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i * 7).getTime());
  }

  const buckets = new Map(starts.map((s) => [s, {
    weekStart: s,
    partial: s === current,
    total: 0,
    byRegion: new Map(),
    byMuscle: new Map(),
  }]));

  for (const set of sets) {
    if (!isWorkingSet(set)) continue;
    const bucket = buckets.get(weekStart(timeOf(set)));
    if (!bucket) continue;

    const muscle = exercisesById.get(set.exercise_id)?.muscle_group || 'Other';
    const region = regionOf(muscle);
    bucket.total++;
    bucket.byRegion.set(region, (bucket.byRegion.get(region) || 0) + 1);
    bucket.byMuscle.set(muscle, (bucket.byMuscle.get(muscle) || 0) + 1);
  }

  return starts.map((s) => buckets.get(s));
}

/* ---------- strength over time ---------- */

/* One point per session: the best estimated 1RM from any eligible set that
   day. A session where nothing qualifies (all sets of 15, say) gets no point
   at all rather than a misleading one. */
export function e1rmPerSession(sets, workoutsById) {
  const best = new Map();

  for (const set of sets) {
    const estimate = estimate1RM(set);
    if (estimate === null) continue;
    const workout = workoutsById.get(set.workout_id);
    if (!workout || workout.deleted) continue;

    const current = best.get(set.workout_id);
    if (!current || estimate > current.e1rm) {
      best.set(set.workout_id, {
        workoutId: set.workout_id,
        t: new Date(workout.started_at).getTime(),
        e1rm: estimate,
        set,
      });
    }
  }

  return [...best.values()].sort((a, b) => a.t - b.t);
}

/* Heaviest working weight for each rep count from 1 to 12, plus the set that
   did it. Only rep counts actually performed appear. */
export function bestByReps(sets, maxReps = 12) {
  const best = new Map();
  for (const set of sets) {
    if (!isWorkingSet(set)) continue;
    if (!(set.weight > 0) || !(set.reps > 0) || set.reps > maxReps) continue;
    const current = best.get(set.reps);
    if (!current || set.weight > current.weight
      || (set.weight === current.weight && set.created_at < current.created_at)) {
      best.set(set.reps, set);
    }
  }
  return new Map([...best.entries()].sort((a, b) => a[0] - b[0]));
}

/* Rep maxes that aren't beaten by a heavier weight at MORE reps. If you've
   done 205 for 5, a 200 x 3 isn't really a 3-rep max worth showing. */
export function meaningfulRepMaxes(best) {
  const entries = [...best.entries()];
  return new Map(entries.filter(([reps, set]) =>
    !entries.some(([otherReps, other]) => otherReps > reps && other.weight >= set.weight)));
}

/* Change across the last `days`, measured between the best session in the
   first and last few weeks of the window rather than two single points, so one
   off day at either end can't manufacture a trend. */
export function e1rmChange(points, { days = 84, now = Date.now() } = {}) {
  const from = now - days * DAY;
  const inWindow = points.filter((p) => p.t >= from);
  if (inWindow.length < 2) return null;

  const span = Math.min(21 * DAY, (inWindow[inWindow.length - 1].t - inWindow[0].t) / 2);
  const early = inWindow.filter((p) => p.t <= inWindow[0].t + span);
  const late = inWindow.filter((p) => p.t >= inWindow[inWindow.length - 1].t - span);
  const peak = (list) => Math.max(...list.map((p) => p.e1rm));
  return {
    change: peak(late) - peak(early),
    days: Math.round((inWindow[inWindow.length - 1].t - inWindow[0].t) / DAY),
  };
}

/* ---------- sessions ---------- */

/* Every session containing this exercise, newest first, with that day's sets
   in the order they were done and any note written against it. */
export function sessionsForExercise(exerciseId, sets, workoutsById, notes = []) {
  const byWorkout = new Map();
  for (const set of sets) {
    if (set.deleted || set.exercise_id !== exerciseId) continue;
    const workout = workoutsById.get(set.workout_id);
    if (!workout || workout.deleted) continue;
    if (!byWorkout.has(workout.id)) byWorkout.set(workout.id, { workout, sets: [], note: null });
    byWorkout.get(workout.id).sets.push(set);
  }

  for (const note of notes) {
    if (note.deleted || note.exercise_id !== exerciseId || !note.body?.trim()) continue;
    const entry = byWorkout.get(note.workout_id);
    if (entry) entry.note = note.body;
  }

  const out = [...byWorkout.values()];
  for (const entry of out) {
    entry.sets.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return out.sort((a, b) => b.workout.started_at.localeCompare(a.workout.started_at));
}

/* One row per exercise you've actually trained, most recent first. */
export function exerciseSummaries(exercises, sets, workoutsById) {
  const live = filterByPlace(sets.filter((s) => !s.deleted), workoutsById, null);
  const rows = [];

  for (const exercise of exercises) {
    const mine = live.filter((s) => s.exercise_id === exercise.id);
    if (!mine.length) continue;
    const last = mine.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const points = e1rmPerSession(mine, workoutsById);
    rows.push({
      exercise,
      lastAt: last.created_at,
      sessions: new Set(mine.map((s) => s.workout_id)).size,
      bestE1RM: points.length ? Math.max(...points.map((p) => p.e1rm)) : null,
    });
  }

  return rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/* Which places this exercise has actually been done at — the filter row only
   offers locations that would show something. */
export function placesForExercise(exerciseId, sets, workoutsById) {
  const seen = new Set();
  for (const set of sets) {
    if (set.deleted || set.exercise_id !== exerciseId) continue;
    const workout = workoutsById.get(set.workout_id);
    if (workout && !workout.deleted && workout.place_id) seen.add(workout.place_id);
  }
  return seen;
}
