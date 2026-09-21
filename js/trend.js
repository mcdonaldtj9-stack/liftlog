/* Bodyweight trend math. Pure functions, no DOM, no database.

   Two problems are being solved here, and they're easy to confuse:

   1. Scales disagree. A garage scale that reads 2 lbs heavier than the gym's
      turns an alternating weigh-in pattern into a sawtooth that has nothing to
      do with your body. So each scale's bias is estimated against a reference
      scale and taken out before anything is averaged.

   2. Bodies fluctuate. Water, salt and food move the number several pounds
      day to day. A smoothed trend shows the direction underneath that.

   Readings are { t: epoch ms, lbs: number, scale: string }. `scale` is a place
   id, or 'other' for readings with no location. */

const DAY = 24 * 60 * 60 * 1000;

/* How many days the trend takes to substantially catch up with a change.
   Seven smooths out a single salty dinner without hiding a real month-long
   trend. */
export const TREND_TAU_DAYS = 7;

/* Fewer paired readings than this and an offset is a guess, not a
   measurement. */
export const MIN_PAIRS = 3;

/* How far apart a reading on one scale may be from readings on the reference
   for them to count as "the same body at the same time". */
const BRACKET_MAX_DAYS = 8;
const NEAREST_MAX_DAYS = 4;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* What the reference scale "would have read" at time t: interpolated between
   its neighbours when they're close together, else the nearest reading when
   that's close, else nothing. */
export function referenceAt(reference, t) {
  let before = null;
  let after = null;
  for (const reading of reference) {
    if (reading.t <= t && (!before || reading.t > before.t)) before = reading;
    if (reading.t >= t && (!after || reading.t < after.t)) after = reading;
  }

  if (before && after) {
    if (before.t === after.t) return before.lbs;
    if (after.t - before.t <= BRACKET_MAX_DAYS * DAY) {
      const f = (t - before.t) / (after.t - before.t);
      return before.lbs + f * (after.lbs - before.lbs);
    }
  }

  const candidates = [before, after].filter(Boolean)
    .filter((r) => Math.abs(r.t - t) <= NEAREST_MAX_DAYS * DAY)
    .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  return candidates.length ? candidates[0].lbs : null;
}

/* The scale with the most readings is the reference; the trend is expressed in
   its terms. Ties go to the scale weighed on most recently, so it's stable. */
export function pickReference(readings) {
  const counts = new Map();
  const latest = new Map();
  for (const r of readings) {
    counts.set(r.scale, (counts.get(r.scale) || 0) + 1);
    latest.set(r.scale, Math.max(latest.get(r.scale) ?? -Infinity, r.t));
  }
  let best = null;
  for (const scale of counts.keys()) {
    if (best === null
      || counts.get(scale) > counts.get(best)
      || (counts.get(scale) === counts.get(best) && latest.get(scale) > latest.get(best))) {
      best = scale;
    }
  }
  return best;
}

/* Each scale's bias against the reference, as the MEDIAN of paired
   differences: one post-dinner reading shouldn't be able to move it.

   Returns { reference, offsets: Map(scale -> {offset, pairs}) }. A scale with
   too few pairs gets offset null — it isn't aligned, and must not be mixed
   into the trend as though it were. */
export function estimateOffsets(readings) {
  const reference = pickReference(readings);
  const offsets = new Map();
  if (reference === null) return { reference, offsets };

  const byScale = new Map();
  for (const r of readings) {
    if (!byScale.has(r.scale)) byScale.set(r.scale, []);
    byScale.get(r.scale).push(r);
  }

  const refReadings = byScale.get(reference);
  offsets.set(reference, { offset: 0, pairs: refReadings.length });

  for (const [scale, list] of byScale) {
    if (scale === reference) continue;
    const diffs = [];
    for (const r of list) {
      const ref = referenceAt(refReadings, r.t);
      if (ref !== null) diffs.push(r.lbs - ref);
    }
    offsets.set(scale, {
      offset: diffs.length >= MIN_PAIRS ? median(diffs) : null,
      pairs: diffs.length,
    });
  }

  return { reference, offsets };
}

/* Local calendar day, so two readings on the same morning collapse together
   rather than the second one being treated as a separate data point minutes
   later. */
function dayKey(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/* A time-aware exponential moving average over daily means.

   The weight given to a new day depends on how long it's been since the last
   one: alpha = 1 - e^(-gap / tau). Three weigh-ins a week at irregular
   intervals are then treated fairly — a reading after a two-week gap counts
   for far more than the second of two consecutive days.

   Returns [{ t, value }] — one point per day that had a reading. */
export function emaTrend(points, tau = TREND_TAU_DAYS) {
  const days = new Map();
  for (const p of points) {
    const key = dayKey(p.t);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(p.value);
  }

  const series = [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, values]) => ({ t, value: values.reduce((s, v) => s + v, 0) / values.length }));

  const out = [];
  let trend = null;
  let lastT = null;
  for (const { t, value } of series) {
    if (trend === null) {
      trend = value;
    } else {
      const alpha = 1 - Math.exp(-((t - lastT) / DAY) / tau);
      trend += alpha * (value - trend);
    }
    lastT = t;
    out.push({ t, value: trend });
  }
  return out;
}

/* Trend value at time t: the last trend point at or before it. */
export function trendAt(trend, t) {
  let found = null;
  for (const point of trend) {
    if (point.t <= t) found = point;
    else break;
  }
  return found;
}

/* How far the trend has moved over the last `days`, measured on the trend
   line itself, never on raw readings — that's the whole point. If there isn't
   that much history, reports the span that exists. */
export function trendDelta(trend, days = 28) {
  if (trend.length < 2) return null;
  const last = trend[trend.length - 1];
  const from = trendAt(trend, last.t - days * DAY) || trend[0];
  if (from.t === last.t) return null;
  return {
    change: last.value - from.value,
    days: Math.round((last.t - from.t) / DAY),
  };
}

/* The whole pipeline. Scales that can't be aligned are left out of the trend
   rather than mixed in raw, and reported as such so the UI can say why. */
export function analyse(readings) {
  if (!readings.length) {
    return { reference: null, offsets: new Map(), trend: [], delta: null, excluded: [] };
  }

  const { reference, offsets } = estimateOffsets(readings);
  const excluded = [...offsets.entries()]
    .filter(([, info]) => info.offset === null)
    .map(([scale, info]) => ({ scale, pairs: info.pairs }));

  const adjusted = readings
    .filter((r) => offsets.get(r.scale)?.offset != null)
    .map((r) => ({ t: r.t, value: r.lbs - offsets.get(r.scale).offset }));

  const trend = emaTrend(adjusted);
  return { reference, offsets, trend, delta: trendDelta(trend), excluded };
}
