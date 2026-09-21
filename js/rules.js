/* Sanity rules applied before a set is written.
   Pure functions with no DOM and no database, so they can be tested off-device
   — which is the only place the logging UI gets tested at all. */

/* A jump bigger than this over your last working set asks for confirmation.
   Deliberately tight: the cost of a false prompt is one extra tap, the cost of
   a missed typo is a training log you can't trust six months from now. */
export const WEIGHT_JUMP_THRESHOLD = 0.05;

/* Returns null when the set looks fine, or a description of the jump when it
   should be confirmed first.

   The reference is your last *working* set: warmups, drop sets and failures are
   excluded upstream, because comparing a 185 work set against a 135 warmup would
   prompt on every single first work set of the day. */
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

  const ratio = weight / previous;
  if (ratio <= 1 + WEIGHT_JUMP_THRESHOLD) return null;

  return {
    weight,
    previous,
    percent: Math.round((ratio - 1) * 100),
  };
}
