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
