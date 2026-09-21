/* Sanity rules applied before a set is written.
   Pure functions with no DOM and no database, so they can be tested off-device
   — which is the only place the logging UI gets tested at all. */

/* Weight: a jump has to clear BOTH a percentage and an absolute amount.
   The percentage alone is too twitchy on light accessory work, where 20 -> 25
   on a cable stack is a 25% jump and an entirely normal one. Requiring 10 lbs
   as well keeps the check silent there while still catching a real outlier. */
export const WEIGHT_JUMP_THRESHOLD = 0.05;
export const WEIGHT_JUMP_MIN_DELTA = 10;

/* Reps: percentages are the wrong tool. 8 -> 12 is a change of rep scheme, not
   a mistake, while 8 -> 88 is a stuck key. So this looks for the shape of a
   typo instead: a multiple of what you normally do, or a number nobody does. */
export const REP_JUMP_RATIO = 3;
export const REP_JUMP_MIN_DELTA = 10;
export const REP_IMPLAUSIBLE = 50;

/* Returns null when the weight looks fine, or a description of the jump. */
export function shouldConfirmWeight({ weight, isWarmup, isDrop }, reference, exercise) {
  // Time-tracked exercises carry no weight to compare.
  if (exercise?.tracks === 'time') return null;

  // Warmups vary by design, and drop sets go down by construction.
  if (isWarmup || isDrop) return null;

  if (!reference) return null;

  const previous = reference.weight;

  // Bodyweight work often records 0 added weight; 0 -> 25 is not a 2500% error.
  if (!(previous > 0)) return null;
  if (!(weight > 0)) return null;

  const delta = weight - previous;
  if (delta < WEIGHT_JUMP_MIN_DELTA) return null;
  if (weight / previous <= 1 + WEIGHT_JUMP_THRESHOLD) return null;

  return {
    kind: 'weight',
    value: weight,
    previous,
    percent: Math.round((weight / previous - 1) * 100),
  };
}

/* Returns null when the rep count looks fine, or a description of the problem.

   Two separate catches:
     'implausible' — a number beyond what anyone actually performs, which works
                     even on the very first set of an exercise with no history.
     'jump'        — a multiple of your usual working reps, which catches the
                     extra-digit slip while leaving genuine rep changes alone. */
export function shouldConfirmReps({ reps, isWarmup, isDrop }, reference, exercise) {
  if (exercise?.tracks === 'time') return null;
  if (!(reps > 0)) return null;

  // Applies whatever kind of set it is — no warmup runs to 88.
  if (reps > REP_IMPLAUSIBLE) {
    return { kind: 'reps', reason: 'implausible', value: reps, previous: reference?.reps ?? null };
  }

  // Warmups and drops both legitimately run far more reps than a work set,
  // so the comparison would fire constantly on sets that are perfectly fine.
  if (isWarmup || isDrop) return null;

  const previous = reference?.reps;
  if (!(previous > 0)) return null;

  const delta = reps - previous;
  if (delta < REP_JUMP_MIN_DELTA) return null;
  if (reps / previous < REP_JUMP_RATIO) return null;

  return { kind: 'reps', reason: 'jump', value: reps, previous };
}

/* Everything worth a second look about this set, in the order it should be
   shown. Empty means log it without interruption. */
export function checkSet(draft, reference, exercise) {
  return [
    shouldConfirmWeight(draft, reference, exercise),
    shouldConfirmReps(draft, reference, exercise),
  ].filter(Boolean);
}

/* ---------- estimated 1RM ----------

   Epley, adjusted for RPE. A set taken to RPE 8 had about 2 reps left in the
   tank, so it represents more strength than the rep count alone suggests:
   185 x 8 @ 8 is really a 10-rep effort. When no RPE was recorded we assume
   0 reps in reserve, which UNDER-estimates rather than over-estimates — the
   safe direction for anything that ends up as a weight suggestion.

   Above 12 effective reps the formula stops being trustworthy, so it declines
   to answer rather than returning a confident wrong number. */

export const MAX_EFFECTIVE_REPS = 12;
export const RECENT_WINDOW_DAYS = 60;
export const DEFAULT_TARGET_RPE = 8;

export function effectiveReps(set) {
  if (!(set?.reps > 0)) return null;
  const inReserve = set.rpe != null ? Math.max(0, 10 - set.rpe) : 0;
  return set.reps + inReserve;
}

export function estimate1RM(set) {
  if (!set || set.failed || set.is_warmup) return null;
  if (!(set.weight > 0)) return null;

  const reps = effectiveReps(set);
  if (reps === null || reps > MAX_EFFECTIVE_REPS) return null;

  return set.weight * (1 + reps / 30);
}

/* Best estimate from recent work only. A peak from before a long layoff
   should not be recommending today's working weight, so anything outside the
   window is ignored entirely rather than used as a fallback. */
export function bestE1RM(sets, now = Date.now()) {
  const cutoff = now - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  let best = null;

  for (const set of sets) {
    if (new Date(set.created_at).getTime() < cutoff) continue;
    const estimate = estimate1RM(set);
    if (estimate !== null && (best === null || estimate > best)) best = estimate;
  }
  return best;
}

/* 5 lb jumps on real weight, 2.5 on the light stuff where 5 is a big step. */
export function roundWeight(value) {
  if (!(value > 0)) return null;
  const step = value >= 100 ? 5 : 2.5;
  return Math.max(step, Math.round(value / step) * step);
}

/* What to load for `targetReps` reps, leaving 2 in reserve by default — a
   weight you can hit for the prescribed reps across several sets, not one that
   buries you on set one. */
export function suggestWeight(e1rm, targetReps, targetRPE = DEFAULT_TARGET_RPE) {
  if (!(e1rm > 0) || !(targetReps > 0)) return null;
  const reps = targetReps + Math.max(0, 10 - targetRPE);
  return roundWeight(e1rm / (1 + reps / 30));
}

/* The most common value, or null when there isn't a clear winner. Used to
   infer "3 x 8" from a session that actually ran 8, 8, 7. */
export function modeOf(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);

  let best = null;
  let bestCount = 0;
  let tied = false;

  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}
