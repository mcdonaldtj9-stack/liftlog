/* Bodyweight trend math against synthetic data whose right answer is known. */

import {
  median, referenceAt, pickReference, estimateOffsets,
  emaTrend, trendDelta, analyse, TREND_TAU_DAYS,
} from '../js/trend.js';

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

const DAY = 86400000;
const START = new Date(2026, 5, 1, 7, 0).getTime();   // local 7am, June 1
const at = (day, hour = 7) => START + day * DAY + (hour - 7) * 3600000;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* A body losing 0.1 lb/day, weighed alternately on two scales, the garage
   reading exactly 2 lbs heavy. Day-to-day noise is deterministic so the test
   is repeatable. */
function twoScales({ bias = 2, days = 60, noise = true } = {}) {
  const readings = [];
  for (let d = 0; d < days; d++) {
    const truth = 190 - 0.1 * d;
    const wobble = noise ? Math.sin(d * 1.7) * 0.8 : 0;
    if (d % 2 === 0) readings.push({ t: at(d), lbs: truth + wobble, scale: 'gym' });
    else readings.push({ t: at(d), lbs: truth + wobble + bias, scale: 'garage' });
  }
  return readings;
}

// ---------- median ----------

check('median of odd', median([3, 1, 2]) === 2);
check('median of even', median([1, 2, 3, 4]) === 2.5);
check('median of nothing', median([]) === null);
check('median shrugs off an outlier', median([2, 2.1, 1.9, 12]) === 2.05);

// ---------- reference interpolation ----------

const ref = [{ t: at(0), lbs: 180 }, { t: at(4), lbs: 184 }];
check('interpolates between close neighbours', near(referenceAt(ref, at(2)), 182, 1e-9));
check('exact hit returns the reading', referenceAt(ref, at(0)) === 180);

const sparse = [{ t: at(0), lbs: 180 }, { t: at(30), lbs: 170 }];
check('does not interpolate across a month gap', referenceAt(sparse, at(15)) === null);
check('uses the nearest reading when close', referenceAt(sparse, at(2)) === 180);
check('gives up when nothing is close', referenceAt([{ t: at(0), lbs: 180 }], at(10)) === null);

// ---------- choosing the reference ----------

check('reference is the most-used scale',
  pickReference([
    { t: at(0), lbs: 1, scale: 'a' }, { t: at(1), lbs: 1, scale: 'b' },
    { t: at(2), lbs: 1, scale: 'b' },
  ]) === 'b');
check('a tie goes to the most recently used',
  pickReference([
    { t: at(0), lbs: 1, scale: 'a' }, { t: at(5), lbs: 1, scale: 'b' },
  ]) === 'b');

// ---------- offsets ----------

const { reference, offsets } = estimateOffsets(twoScales({ bias: 2 }));
const garage = offsets.get('garage');
const gymOrGarageRef = reference === 'gym' ? garage.offset : -offsets.get('gym').offset;
check('a known +2.0 lb bias is recovered within 0.2',
  near(gymOrGarageRef, 2, 0.2), `got ${gymOrGarageRef}`);
check('and is backed by plenty of pairs', Math.max(garage.pairs, offsets.get('gym').pairs) >= 20);

const withOutlier = twoScales({ bias: 2, noise: false });
withOutlier.push({ t: at(31, 20), lbs: 190 - 3.1 + 12, scale: 'garage' });   // a very heavy evening
const outlierResult = estimateOffsets(withOutlier);
const outlierOffset = outlierResult.reference === 'gym'
  ? outlierResult.offsets.get('garage').offset
  : -outlierResult.offsets.get('gym').offset;
check('one 12 lb outlier does not move the offset', near(outlierOffset, 2, 0.1),
  `got ${outlierOffset}`);

const tooFew = estimateOffsets([
  { t: at(0), lbs: 180, scale: 'gym' }, { t: at(2), lbs: 180, scale: 'gym' },
  { t: at(4), lbs: 180, scale: 'gym' }, { t: at(6), lbs: 180, scale: 'gym' },
  { t: at(1), lbs: 182, scale: 'garage' }, { t: at(3), lbs: 182, scale: 'garage' },
]);
check('two paired readings are not enough to trust an offset',
  tooFew.offsets.get('garage').offset === null);
check('but the pair count is still reported', tooFew.offsets.get('garage').pairs === 2);

const noOverlap = estimateOffsets([
  ...[0, 1, 2, 3, 4].map((d) => ({ t: at(d), lbs: 180, scale: 'gym' })),
  ...[40, 41, 42, 43].map((d) => ({ t: at(d), lbs: 182, scale: 'garage' })),
]);
check('scales used in different months cannot be aligned',
  noOverlap.offsets.get('garage').offset === null);
check('the reference always aligns with itself',
  noOverlap.offsets.get(noOverlap.reference).offset === 0);

// ---------- the trend ----------

const daily = [0, 1, 2].map((d) => ({ t: at(d), value: [180, 181, 179][d] }));
const ema = emaTrend(daily);
const a = 1 - Math.exp(-1 / TREND_TAU_DAYS);
const expected1 = 180 + a * (181 - 180);
const expected2 = expected1 + a * (179 - expected1);
check('daily readings match a classic EMA', near(ema[1].value, expected1, 1e-9)
  && near(ema[2].value, expected2, 1e-9));

const gap = emaTrend([{ t: at(0), value: 180 }, { t: at(14), value: 190 }]);
const weight = (gap[1].value - 180) / 10;
check('a reading after two weeks away counts for ~86%',
  near(weight, 1 - Math.exp(-14 / TREND_TAU_DAYS), 1e-9) && near(weight, 0.865, 0.01),
  `got ${weight}`);

const sameDay = emaTrend([
  { t: at(0, 7), value: 180 }, { t: at(0, 18), value: 184 }, { t: at(1), value: 182 },
]);
check('two readings on one day collapse to their mean', sameDay.length === 2
  && near(sameDay[0].value, 182, 1e-9));

check('an empty series has no trend', emaTrend([]).length === 0);

// ---------- delta ----------

const ramp = emaTrend(
  Array.from({ length: 90 }, (_, d) => ({ t: at(d), value: 200 - 0.1 * d })));
const delta = trendDelta(ramp, 28);
check('a 0.1 lb/day decline reads as -2.8 over 28 days', near(delta.change, -2.8, 0.05),
  `got ${delta?.change}`);
check('over the full window', delta.days === 28);

const short = trendDelta(emaTrend([{ t: at(0), value: 180 }, { t: at(5), value: 179 }]), 28);
check('short history reports the span it actually has', short.days === 5);
check('a single reading has no delta', trendDelta(emaTrend([{ t: at(0), value: 1 }])) === null);

// ---------- end to end ----------

/* The case that motivated all this: a steady 0.1 lb/day loss, weighed on
   alternating scales that disagree by 2 lbs. Raw, it's a sawtooth. */
const story = analyse(twoScales({ bias: 2, noise: false, days: 60 }));
const storyDelta = story.delta;
check('the adjusted trend finds the real loss', near(storyDelta.change, -2.8, 0.2),
  `got ${storyDelta?.change}`);

const smooth = story.trend.slice(20);
const jumps = smooth.slice(1).map((p, i) => Math.abs(p.value - smooth[i].value));
check('and it no longer zigzags between scales', Math.max(...jumps) < 0.3,
  `largest day-to-day move ${Math.max(...jumps).toFixed(2)}`);

/* For contrast: what the same data looks like if you just average everything
   together, which is what a naive app would do. */
const naive = emaTrend(twoScales({ bias: 2, noise: false, days: 60 })
  .map((r) => ({ t: r.t, value: r.lbs })));
const naiveJumps = naive.slice(21).map((p, i) => Math.abs(p.value - naive[20 + i].value));
check('whereas mixing scales raw swings by far more',
  Math.max(...naiveJumps) > Math.max(...jumps) * 2);

const excludedCase = analyse([
  ...[0, 1, 2, 3, 4, 5].map((d) => ({ t: at(d), lbs: 180, scale: 'gym' })),
  { t: at(50), lbs: 175, scale: 'garage' },
]);
check('an unaligned scale is reported, not silently mixed in',
  excludedCase.excluded.length === 1 && excludedCase.excluded[0].scale === 'garage');
check('and stays out of the trend',
  excludedCase.trend.every((p) => p.value === 180));

const oneScale = analyse([0, 2, 4].map((d) => ({ t: at(d), lbs: 180 - d * 0.5, scale: 'gym' })));
check('a single scale needs no alignment', oneScale.excluded.length === 0
  && oneScale.trend.length === 3);

check('no readings, no trend', analyse([]).trend.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
