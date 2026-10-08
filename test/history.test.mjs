/* History aggregates against hand-built data with known answers. */

import {
  regionOf, isWorkingSet, weekStart, filterByPlace, weeklySets,
  e1rmPerSession, bestByReps, meaningfulRepMaxes, e1rmChange,
  sessionsForExercise, exerciseSummaries, placesForExercise, progressSeries, seriesChange,
  bodyweightOn, relativeSeries,
} from '../js/history.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const DAY = 86400000;
// Wednesday 16 Sep 2026, local noon.
const NOW = new Date(2026, 8, 16, 12, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const daysBefore = (n, hour = 18) => {
  const d = new Date(NOW - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

let serial = 0;
const set = (extra) => ({
  id: `s${++serial}`, workout_id: 'w1', exercise_id: 'bench',
  weight: 185, reps: 8, rpe: 8, failed: 0, is_warmup: 0, is_dropset: 0, deleted: 0,
  created_at: iso(NOW), ...extra,
});

const exercises = new Map([
  ['bench', { id: 'bench', name: 'Barbell Bench Press', muscle_group: 'Chest' }],
  ['curl', { id: 'curl', name: 'Dumbbell Curl', muscle_group: 'Biceps' }],
  ['pushdown', { id: 'pushdown', name: 'Tricep Pushdown', muscle_group: 'Triceps' }],
  ['legpress', { id: 'legpress', name: 'Leg Press', muscle_group: 'Quads' }],
  ['odd', { id: 'odd', name: 'Mystery', muscle_group: 'Other' }],
]);

// ---------- basics ----------

check('biceps and triceps both count as arms',
  regionOf('Biceps') === 'Arms' && regionOf('Triceps') === 'Arms');
check('every leg muscle counts as legs',
  ['Quads', 'Hamstrings', 'Glutes', 'Calves'].every((m) => regionOf(m) === 'Legs'));
check('an unknown group falls into other', regionOf('Neck') === 'Other');

check('a normal set is a working set', isWorkingSet(set({})));
check('a warmup is not', !isWorkingSet(set({ is_warmup: 1 })));
check('a drop set is not', !isWorkingSet(set({ is_dropset: 1 })));
check('a failed set is not', !isWorkingSet(set({ failed: 1 })));
check('a deleted set is not', !isWorkingSet(set({ deleted: 1 })));

const monday = weekStart(NOW);
check('weeks start on Monday', new Date(monday).getDay() === 1);
check('at local midnight', new Date(monday).getHours() === 0);
check('Sunday belongs to the week before it',
  weekStart(new Date(2026, 8, 13, 20).getTime()) === new Date(2026, 8, 7).getTime());

// ---------- place filter ----------

const workouts = new Map([
  ['w1', { id: 'w1', place_id: 'pf', started_at: iso(daysBefore(0)), deleted: 0 }],
  ['w2', { id: 'w2', place_id: 'garage', started_at: iso(daysBefore(7)), deleted: 0 }],
  ['w3', { id: 'w3', place_id: 'pf', started_at: iso(daysBefore(14)), deleted: 1 }],
]);
const mixed = [set({ workout_id: 'w1' }), set({ workout_id: 'w2' }), set({ workout_id: 'w3' })];
check('all places keeps every live session', filterByPlace(mixed, workouts, null).length === 2);
check('one place keeps only its own', filterByPlace(mixed, workouts, 'garage').length === 1);
check('a discarded session never counts', !filterByPlace(mixed, workouts, 'pf')
  .some((s) => s.workout_id === 'w3'));

// ---------- weekly sets ----------

const weekSets = [
  set({ created_at: iso(daysBefore(0)) }),                                   // this week, chest
  set({ created_at: iso(daysBefore(1)), exercise_id: 'curl' }),              // this week, arms
  set({ created_at: iso(daysBefore(1)), exercise_id: 'pushdown' }),          // this week, arms
  set({ created_at: iso(daysBefore(1)), is_warmup: 1 }),                     // not counted
  set({ created_at: iso(daysBefore(1)), is_dropset: 1 }),                    // not counted
  set({ created_at: iso(daysBefore(8)), exercise_id: 'legpress' }),          // last week
  set({ created_at: iso(daysBefore(8)), exercise_id: 'odd' }),               // last week, other
  set({ created_at: iso(daysBefore(200)) }),                                 // outside window
];
const weeks = weeklySets(weekSets, exercises, { weeks: 8, now: NOW });
const thisWeek = weeks[weeks.length - 1];
const lastWeek = weeks[weeks.length - 2];

check('eight weeks, oldest first', weeks.length === 8 && weeks[0].weekStart < thisWeek.weekStart);
check('only the current week is partial',
  thisWeek.partial && weeks.slice(0, -1).every((w) => !w.partial));
check('warmups and drops are not counted', thisWeek.total === 3, `got ${thisWeek.total}`);
check('sets are grouped by region', thisWeek.byRegion.get('Arms') === 2
  && thisWeek.byRegion.get('Chest') === 1);
check('and still broken out by muscle', thisWeek.byMuscle.get('Biceps') === 1
  && thisWeek.byMuscle.get('Triceps') === 1);
check('last week has its own sets', lastWeek.total === 2
  && lastWeek.byRegion.get('Legs') === 1 && lastWeek.byRegion.get('Other') === 1);
check('anything older than the window is ignored',
  weeks.reduce((n, w) => n + w.total, 0) === 5);

// Minor muscles earn half a set each, without inflating the totals.
const pulldownMap = new Map([...exercises, ['pulldown', {
  id: 'pulldown', muscle_group: 'Back', secondary_muscles: ['Biceps', 'Back', 'Nonsense', 'Biceps'],
}]]);
const pulldownWeeks = weeklySets([
  set({ created_at: iso(daysBefore(0)), exercise_id: 'pulldown' }),
  set({ created_at: iso(daysBefore(0)), exercise_id: 'pulldown' }),
  set({ created_at: iso(daysBefore(0)), exercise_id: 'pulldown', is_warmup: 1 }),
  set({ created_at: iso(daysBefore(0)), exercise_id: 'curl' }),
], pulldownMap, { weeks: 2, now: NOW });
const pw = pulldownWeeks[pulldownWeeks.length - 1];
check('a minor muscle earns half a set per set', pw.byMuscle.get('Biceps') === 2,
  `got ${pw.byMuscle.get('Biceps')}`);
check('the major muscle still gets the full set', pw.byMuscle.get('Back') === 2);
check('the bars count each set once', pw.total === 3 && pw.byRegion.get('Back') === 2
  && pw.byRegion.get('Arms') === 1);
check('unknown, repeated or major-as-minor entries are ignored',
  !pw.byMuscle.has('Nonsense'));
check('an exercise with no minor muscles behaves as before',
  weeklySets([set({ created_at: iso(daysBefore(0)), exercise_id: 'curl' })], exercises,
    { weeks: 1, now: NOW })[0].byMuscle.get('Biceps') === 1);

// ---------- progress series ----------

const pWorkouts = new Map([
  ['p1', { id: 'p1', started_at: iso(daysBefore(20)), deleted: 0 }],
  ['p2', { id: 'p2', started_at: iso(daysBefore(10)), deleted: 0 }],
  ['p3', { id: 'p3', started_at: iso(daysBefore(5)), deleted: 0 }],
]);
const pSets = [
  set({ workout_id: 'p1', weight: 95, reps: 10, is_warmup: 1 }),
  set({ workout_id: 'p1', weight: 185, reps: 8 }),
  set({ workout_id: 'p1', weight: 185, reps: 6 }),
  set({ workout_id: 'p2', weight: 195, reps: 5 }),
  set({ workout_id: 'p2', weight: 225, reps: 1, failed: 1 }),
  set({ workout_id: 'p2', weight: 135, reps: 12, is_dropset: 1 }),
  set({ workout_id: 'p3', weight: 190, reps: 8 }),
  set({ workout_id: 'p3', weight: 190, reps: 9 }),
];
const top = progressSeries(pSets, pWorkouts, 'top');
check('top set is the heaviest working set per session, oldest first',
  top.map((p) => p.value).join() === '185,195,190');
check('a tie on weight goes to the set with more reps', top[2].set.reps === 9);
check('failed and drop sets never make the top set', top[1].set.weight === 195);
const vol = progressSeries(pSets, pWorkouts, 'volume');
check('volume adds weight × reps over working sets only',
  vol[0].value === 185 * 14 && vol[1].value === 195 * 5 && vol[0].sets === 2, vol.map((p) => p.value).join());
check('the 1RM series matches the existing estimate',
  progressSeries(pSets, pWorkouts, 'e1rm').length === 3);

const bwSets = [
  set({ workout_id: 'p1', weight: 0, reps: 10 }), set({ workout_id: 'p1', weight: 0, reps: 8 }),
  set({ workout_id: 'p2', weight: 0, reps: 12 }),
];
check('bodyweight best set and total reps',
  progressSeries(bwSets, pWorkouts, 'reps').map((p) => p.value).join() === '10,12'
  && progressSeries(bwSets, pWorkouts, 'totalReps').map((p) => p.value).join() === '18,12');
check('no added weight means no added-weight chart',
  progressSeries(bwSets, pWorkouts, 'top').length === 0);
const holdSets = [
  set({ workout_id: 'p1', weight: null, reps: null, seconds: 45 }),
  set({ workout_id: 'p1', weight: null, reps: null, seconds: 60 }),
  set({ workout_id: 'p3', weight: null, reps: null, seconds: 75 }),
];
check('holds chart the longest set and the total time',
  progressSeries(holdSets, pWorkouts, 'hold').map((p) => p.value).join() === '60,75'
  && progressSeries(holdSets, pWorkouts, 'totalTime').map((p) => p.value).join() === '105,75');
const moved = seriesChange(top, { days: 84, now: NOW });
check('a series reports its change over the window', moved && moved.days === 15, JSON.stringify(moved));

// ---------- strength relative to bodyweight ----------

const bwTrend = [
  { t: daysBefore(15), value: 190 },
  { t: daysBefore(8), value: 186 },
  { t: daysBefore(1), value: 182 },
];
check('bodyweight on a day is the trend at or before it',
  bodyweightOn(bwTrend, daysBefore(5)) === 186 && bodyweightOn(bwTrend, daysBefore(1)) === 182);
check('a session shortly before the first weigh-in borrows it',
  bodyweightOn(bwTrend, daysBefore(20)) === 190);
check('a session long before any weigh-in has none',
  bodyweightOn(bwTrend, daysBefore(60)) === null && bodyweightOn([], NOW) === null);
const rel = relativeSeries([
  { workoutId: 'a', t: daysBefore(60), value: 250 },
  { workoutId: 'b', t: daysBefore(10), value: 247 },
  { workoutId: 'c', t: daysBefore(1), value: 246 },
], bwTrend);
check('relative strength divides the 1RM by bodyweight on the day',
  rel.length === 2 && Math.abs(rel[0].value - 247 / 190) < 1e-9 && rel[1].bodyweight === 182);
check('it climbs on a cut while the 1RM holds', rel[1].value > rel[0].value && rel[1].e1rm < rel[0].e1rm);

// ---------- e1RM per session ----------

const sessionMap = new Map([
  ['a', { id: 'a', started_at: iso(daysBefore(30)), deleted: 0 }],
  ['b', { id: 'b', started_at: iso(daysBefore(20)), deleted: 0 }],
  ['c', { id: 'c', started_at: iso(daysBefore(10)), deleted: 0 }],
  ['d', { id: 'd', started_at: iso(daysBefore(5)), deleted: 1 }],
]);
const perSession = e1rmPerSession([
  set({ workout_id: 'a', weight: 185, reps: 8, rpe: 8 }),     // 246.7
  set({ workout_id: 'a', weight: 185, reps: 6, rpe: 10 }),    // 222.0
  set({ workout_id: 'b', weight: 135, reps: 15, rpe: 7 }),    // 18 effective — ineligible
  set({ workout_id: 'c', weight: 205, reps: 5, rpe: 9 }),     // 246.0
  set({ workout_id: 'c', weight: 225, reps: 3, failed: 1 }),  // failed — ignored
  set({ workout_id: 'd', weight: 300, reps: 1, rpe: 10 }),    // discarded session
], sessionMap);

check('one point per session', perSession.length === 2, `got ${perSession.length}`);
check('taking the best set that day', Math.round(perSession[0].e1rm) === 247);
check('a session with nothing eligible gets no point', !perSession.some((p) => p.workoutId === 'b'));
check('a failed set never becomes the best', Math.round(perSession[1].e1rm) === 246);
check('a discarded session is left out', !perSession.some((p) => p.workoutId === 'd'));
check('oldest first', perSession[0].t < perSession[1].t);

// ---------- rep maxes ----------

const reps = bestByReps([
  set({ weight: 185, reps: 8 }),
  set({ weight: 195, reps: 8 }),
  set({ weight: 205, reps: 5 }),
  set({ weight: 200, reps: 3 }),               // beaten by 205 x 5
  set({ weight: 245, reps: 1, failed: 1 }),    // a miss is not a PR
  set({ weight: 235, reps: 1, is_dropset: 1 }),// nor is a drop
  set({ weight: 225, reps: 1, rpe: null }),    // no RPE still counts
  set({ weight: 95, reps: 20 }),               // beyond the table
]);
check('heaviest weight wins per rep count', reps.get(8).weight === 195);
check('failed and drop sets are excluded', reps.get(1).weight === 225);
check('sets without RPE are included', reps.get(1).rpe === null);
check('high-rep sets are outside the table', !reps.has(20));
check('the table lists only rep counts actually done', [...reps.keys()].join(',') === '1,3,5,8');

const meaningful = meaningfulRepMaxes(reps);
check('a rep max beaten at more reps is hidden', !meaningful.has(3));
check('real rep maxes stay', [...meaningful.keys()].join(',') === '1,5,8');

// ---------- change over the window ----------

const climbing = Array.from({ length: 12 }, (_, i) => ({
  t: NOW - (84 - i * 7) * DAY, e1rm: 240 + i,
}));
const change = e1rmChange(climbing, { days: 84, now: NOW });
check('a steady climb reads as a gain', change.change > 5, `got ${change?.change}`);
check('one bad day at the end cannot erase it', (() => {
  const withDip = [...climbing, { t: NOW, e1rm: 200 }];
  return e1rmChange(withDip, { days: 84, now: NOW }).change > 0;
})());
check('one point is not a trend', e1rmChange([{ t: NOW, e1rm: 200 }], { now: NOW }) === null);

// ---------- sessions ----------

const noteRows = [
  { id: 'n1', workout_id: 'c', exercise_id: 'bench', body: 'go up 10', deleted: 0 },
  { id: 'n2', workout_id: 'a', exercise_id: 'bench', body: '   ', deleted: 0 },
];
const history = sessionsForExercise('bench', [
  set({ workout_id: 'a', created_at: iso(daysBefore(30, 18)) }),
  set({ workout_id: 'c', created_at: iso(daysBefore(10, 18)), weight: 205 }),
  set({ workout_id: 'c', created_at: iso(daysBefore(10, 17)), weight: 195 }),
  set({ workout_id: 'c', exercise_id: 'curl' }),
], sessionMap, noteRows);
check('sessions come newest first', history[0].workout.id === 'c');
check("each lists only this exercise's sets", history[0].sets.length === 2);
check('in the order they were done', history[0].sets[0].weight === 195);
check("and carries that day's note", history[0].note === 'go up 10');
check('a blank note is not shown', history[1].note === null);

// ---------- summaries ----------

const summaryWorkouts = new Map([...sessionMap, ['w1', workouts.get('w1')]]);
const summaries = exerciseSummaries([...exercises.values()], [
  set({ workout_id: 'a', created_at: iso(daysBefore(30)) }),
  set({ workout_id: 'w1', exercise_id: 'curl', weight: 30, reps: 10, created_at: iso(daysBefore(0)) }),
], summaryWorkouts);
check('only trained exercises are listed', summaries.length === 2);
check('most recently trained first', summaries[0].exercise.id === 'curl');
check('with a best estimate where there is one', Math.round(summaries[1].bestE1RM) === 247);

check('places are read from the sessions',
  [...placesForExercise('bench', mixed, workouts)].join(',') === 'pf,garage');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
