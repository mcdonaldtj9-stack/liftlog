/* Goal math against synthetic trends whose right answer is known. The cases
   that matter most are the thin ones — zero, one and two weigh-ins — because
   that's what the card will actually be rendering on day one. */

import {
  localDate, isValidGoal, validateGoal, goalLineAt, plannedRate, goalPath,
  trendRate, goalStatus, DEFAULT_GOAL, MIN_RATE_DAYS,
} from '../js/goal.js';
import { emaTrend } from '../js/trend.js';

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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/* A goal starting June 1 (local), 140 days long: 188 -> 174, exactly 0.1 lb a
   day, 0.7 lb a week. Trend points sit at midnight so they line up with the
   line's own anchors and the arithmetic below is exact. */
const START = new Date(2026, 5, 1).getTime();
const at = (day) => START + day * DAY;
const goal = {
  start_date: ymd(START), start_lbs: 188,
  goal_date: ymd(START + 140 * DAY), goal_lbs: 174,
  band_lbs: 2,
};

/* A trend that is exactly `value(day)` on each of the given days. Points are
   fed straight in, not smoothed, so the tests reason about known values. */
const line = (days, value) => days.map((d) => ({ t: at(d), value: value(d) }));

// ---------- dates ----------

const sept26 = new Date(localDate('2026-09-26'));
check('a goal date is local midnight, not UTC',
  sept26.getDate() === 26 && sept26.getMonth() === 8 && sept26.getHours() === 0);
check('garbage is NaN, not a date', Number.isNaN(localDate('soon')) && Number.isNaN(localDate('')));

// ---------- validity ----------

check('the built-in default is a valid goal', isValidGoal(DEFAULT_GOAL));
check('the default plans about 1.05 lb a week', near(plannedRate(DEFAULT_GOAL), -1.045, 0.01),
  `got ${plannedRate(DEFAULT_GOAL)}`);
check('a goal date before the start is invalid',
  !isValidGoal({ ...goal, goal_date: '2026-01-01' }));
check('a missing weight is invalid', !isValidGoal({ ...goal, goal_lbs: NaN }));

const cleaned = validateGoal({
  start_date: ' 2026-09-26 ', start_lbs: '188.04', goal_date: '2027-02-27', goal_lbs: '165', band_lbs: '2',
});
check('form text is cleaned into numbers', cleaned.problems.length === 0
  && cleaned.goal.start_lbs === 188 && cleaned.goal.goal_lbs === 165 && cleaned.goal.start_date === '2026-09-26');
const broken = validateGoal({ start_date: '2027-01-01', start_lbs: '', goal_date: '2026-01-01', goal_lbs: '165', band_lbs: '-1' });
check('every problem is named', broken.problems.length === 3, broken.problems.join(' | '));

// ---------- the line ----------

check('the line starts at the start weight', goalLineAt(goal, at(0)) === 188);
check('and ends at the goal weight', goalLineAt(goal, localDate(goal.goal_date)) === 174);
check('halfway is halfway', near(goalLineAt(goal, START + 70 * DAY), 181, 1e-9));
check('flat before the start', goalLineAt(goal, START - 30 * DAY) === 188);
check('flat after the goal date', goalLineAt(goal, START + 400 * DAY) === 174);

const path = goalPath(goal, START - 10 * DAY, START + 200 * DAY);
check('a wide window draws both corners', path.length === 4
  && path[1].t === START && path[2].t === START + 140 * DAY
  && path[0].value === 188 && path[3].value === 174);
const inner = goalPath(goal, START + 10 * DAY, START + 20 * DAY);
check('a window inside the slope is a plain segment', inner.length === 2
  && near(inner[0].value, 187, 1e-9) && near(inner[1].value, 186, 1e-9));

// ---------- rate ----------

const steady = line([...Array(31).keys()], (d) => 190 - 0.1 * d);
const r = trendRate(steady, at(30));
check('0.1 lb a day reads as 0.7 lb a week', near(r.rate, -0.7, 1e-9), `got ${r?.rate}`);
check('over the full window', r.days === 14 && r.full);

const sparse = line([0, 5, 12, 19, 26, 30], (d) => 190 - 0.1 * d);
const rs = trendRate(sparse, at(30));
check('three-a-week weigh-ins still cover the window', rs.days >= 14 && rs.full && near(rs.rate, -0.7, 1e-9),
  `days ${rs?.days}`);

const shortHistory = trendRate(line([0, 3, 6], (d) => 190 - 0.1 * d), at(6));
check('short history reports the span it has', shortHistory.days === 6 && !shortHistory.full);
check('one point has no rate', trendRate(line([0], () => 190), at(0)) === null);
check('no points, no rate', trendRate([], at(0)) === null);

// ---------- status: thin data ----------

const empty = goalStatus(goal, [], at(3));
check('no weigh-ins: the line still says where you should be',
  near(empty.expected, 187.7, 1e-9) && empty.current === null && empty.diff === null);
check('and nothing is flagged', empty.position === null && empty.pace === null && empty.projection === null);
check('nothing is NaN', Object.values(empty).every((v) => !(typeof v === 'number' && Number.isNaN(v))));

const one = goalStatus(goal, line([1], () => 191), at(1));
check('one weigh-in: a difference but no rate', near(one.diff, 191 - 187.9, 1e-9)
  && one.rate === null && one.projection === null && one.pace === null);
check('and it is above the band', one.position === 'above');

const two = goalStatus(goal, line([0, 2], (d) => 188 - 0.5 * d), at(2));
check('two weigh-ins: a rate over the days between them', two.rate.days === 2 && !two.rate.full
  && near(two.rate.rate, -3.5, 1e-9));
check('too few days to call it too fast', two.pace === null);
check('but a projection is offered', two.projection.kind === 'date');

// ---------- status: position ----------

const onLine = goalStatus(goal, line([...Array(29).keys()], (d) => 188 - 0.1 * d), at(28));
check('exactly on the line is on track', onLine.position === 'on' && near(onLine.diff, 0, 1e-9));
check('and losing at the planned rate is neither stalled nor fast', onLine.pace === null);
check('with a projection landing on the goal date',
  onLine.projection.kind === 'date' && Math.abs(onLine.projection.vsGoalDays) <= 1,
  `vs goal ${onLine.projection?.vsGoalDays}`);

const high = goalStatus(goal, line([...Array(29).keys()], (d) => 191 - 0.1 * d), at(28));
check('3 lb above with a 2 lb band is behind', high.position === 'above' && near(high.diff, 3, 1e-9));
const inside = goalStatus(goal, line([...Array(29).keys()], (d) => 189.5 - 0.1 * d), at(28));
check('1.5 lb above is inside the band', inside.position === 'on');
const low = goalStatus(goal, line([...Array(29).keys()], (d) => 185 - 0.1 * d), at(28));
check('3 lb below is ahead', low.position === 'below');

// ---------- status: pace ----------

const flat = goalStatus(goal, line([...Array(29).keys()], () => 186), at(28));
check('four flat weeks is a stall', flat.pace === 'stalled');
check('a stall has no projected date', flat.projection.kind === 'none');

const flatWeek = goalStatus(goal, line([...Array(11).keys()].map((d) => d + 18), () => 186), at(28));
check('one flat week is not yet a stall', flatWeek.pace === null);

const gaining = goalStatus(goal, line([...Array(29).keys()], (d) => 186 + 0.05 * d), at(28));
check('gaining counts as stalled', gaining.pace === 'stalled' && gaining.projection.kind === 'none');

const crawl = goalStatus(goal, line([...Array(29).keys()], (d) => 186 - 0.02 * d), at(28));
check('losing 0.14 lb a week for two weeks is a stall', crawl.pace === 'stalled');

const fast = goalStatus(goal, line([...Array(29).keys()], (d) => 190 - 0.3 * d), at(28));
check('2.1 lb a week is too fast', fast.pace === 'fast');
const brisk = goalStatus(goal, line([...Array(29).keys()], (d) => 190 - 0.2 * d), at(28));
check('1.4 lb a week is not', brisk.pace === null);

const early = goalStatus(goal, line([...Array(29).keys()].map((d) => d - 40), () => 190), at(-12));
check('before the start date, flat is not a stall', !early.started && early.pace === null);

// ---------- status: projection ----------

const proj = goalStatus(goal, line([...Array(29).keys()], (d) => 186.8 - 0.1 * d), at(28));
// 184 lb, losing 0.1/day, 10 lb to go: 100 days from day 28.
check('the projected date follows from the rate',
  proj.projection.kind === 'date' && near(proj.projection.t, at(128), DAY / 2),
  `got ${new Date(proj.projection?.t)}`);
check('and is compared with the goal date', proj.projection.vsGoalDays === 128 - 140);

const done = goalStatus(goal, line([...Array(29).keys()], (d) => 175 - 0.1 * d), at(28));
check('at or under the goal weight reads as reached', done.projection.kind === 'reached');

const glacial = goalStatus(goal, line([...Array(29).keys()], (d) => 186 - 0.001 * d), at(28));
check('a date centuries out is no date at all', glacial.projection.kind === 'none');

// ---------- status: through the real pipeline ----------

const smoothed = emaTrend(
  Array.from({ length: 40 }, (_, d) => ({ t: at(d), value: 188 - 0.1 * d + Math.sin(d * 1.7) * 0.8 })));
const real = goalStatus(goal, smoothed, at(39));
check('a noisy but steady loss through the EMA stays on track', real.position === 'on'
  && real.pace === null && real.projection.kind === 'date', `position ${real.position} pace ${real.pace}`);
check('the rate window needs at least this many real days', MIN_RATE_DAYS >= 7 && MIN_RATE_DAYS <= 14);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
