/* Bodyweight goal math. Pure functions, no DOM, no database.

   The goal is a straight line from a start weight on a start date to a goal
   weight on a goal date, with a tolerance band either side of it so a salty
   dinner doesn't read as falling off the plan. Everything here is measured
   against the smoothed TREND from trend.js, never against raw weigh-ins: raw
   readings swing several pounds a day and would flag "off track" constantly.

   A goal is { start_date, start_lbs, goal_date, goal_lbs, band_lbs } with the
   dates as 'yyyy-mm-dd' strings. A trend is [{ t, value }] from trend.js. */

import { trendAt } from './trend.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

export const DEFAULT_GOAL = {
  start_date: '2026-09-26',
  start_lbs: 188,
  goal_date: '2027-02-27',
  goal_lbs: 165,
  band_lbs: 2,
};

/* The rate of loss is read over this many days of trend. */
export const RATE_WINDOW_DAYS = 14;

/* Fewer real days than this inside the window and the rate is a guess, so no
   flag is raised from it. The rate itself is still shown, labelled with the
   span it covers. */
export const MIN_RATE_DAYS = 10;

/* Losing slower than this (lb/week) for STALL_WEEKS consecutive weekly checks
   is a stall. Losing faster than FAST_RATE is too fast to be mostly fat. */
export const STALL_RATE = 0.25;
export const STALL_WEEKS = 2;
export const FAST_RATE = 1.5;

/* A projection further out than this is noise, not a date. */
export const MAX_PROJECTION_DAYS = 730;

/* 'yyyy-mm-dd' as LOCAL midnight. new Date('2026-09-26') is UTC midnight,
   which is the evening of the 25th anywhere in the United States. */
export function localDate(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d).getTime();
}

export function isValidGoal(goal) {
  if (!goal) return false;
  const s = localDate(goal.start_date);
  const e = localDate(goal.goal_date);
  return Number.isFinite(s) && Number.isFinite(e) && e > s
    && goal.start_lbs > 0 && goal.goal_lbs > 0 && goal.band_lbs >= 0;
}

/* Form input -> a clean goal, plus anything wrong with it in plain words. */
export function validateGoal(raw) {
  const tenth = (n) => Math.round(Number(n) * 10) / 10;
  const goal = {
    start_date: String(raw.start_date || '').trim(),
    start_lbs: tenth(raw.start_lbs),
    goal_date: String(raw.goal_date || '').trim(),
    goal_lbs: tenth(raw.goal_lbs),
    band_lbs: tenth(raw.band_lbs),
  };
  const problems = [];
  const s = localDate(goal.start_date);
  const e = localDate(goal.goal_date);
  if (!Number.isFinite(s)) problems.push('A start date is needed.');
  if (!Number.isFinite(e)) problems.push('A goal date is needed.');
  else if (Number.isFinite(s) && e <= s) problems.push('The goal date has to be after the start date.');
  if (!(goal.start_lbs > 0)) problems.push('The start weight needs to be a positive number.');
  if (!(goal.goal_lbs > 0)) problems.push('The goal weight needs to be a positive number.');
  if (!(goal.band_lbs >= 0)) problems.push('The tolerance can be zero, but not negative.');
  return { goal, problems };
}

/* Where the line says you should be at time t. Flat at the start weight before
   the start date and at the goal weight after the goal date: before you began,
   the plan was to be where you started; after you arrive, the plan is to stay. */
export function goalLineAt(goal, t) {
  const s = localDate(goal.start_date);
  const e = localDate(goal.goal_date);
  if (t <= s) return goal.start_lbs;
  if (t >= e) return goal.goal_lbs;
  return goal.start_lbs + ((goal.goal_lbs - goal.start_lbs) * (t - s)) / (e - s);
}

/* The planned rate, lb/week. Negative when losing. */
export function plannedRate(goal) {
  const weeks = (localDate(goal.goal_date) - localDate(goal.start_date)) / WEEK;
  return weeks > 0 ? (goal.goal_lbs - goal.start_lbs) / weeks : 0;
}

/* The line as points for drawing, clipped to [from, to]. At most four points:
   the two ends of the window and the two corners where the slope begins and
   ends, whichever fall inside. */
export function goalPath(goal, from, to) {
  const corners = [localDate(goal.start_date), localDate(goal.goal_date)]
    .filter((t) => t > from && t < to);
  return [from, ...corners, to].map((t) => ({ t, value: goalLineAt(goal, t) }));
}

/* Rate of change of the trend, lb/week, over the window ending at `endT`.
   Measured from the last trend point at or before endT back to the last point
   at or before the window's start — or the first point there is, when history
   is shorter. `days` is the span actually covered, so the UI can say "over 9
   days" honestly when that's all it has. Null with fewer than two points. */
export function trendRate(trend, endT, windowDays = RATE_WINDOW_DAYS) {
  if (!trend.length) return null;
  const to = trendAt(trend, endT ?? trend[trend.length - 1].t);
  if (!to) return null;
  const from = trendAt(trend, to.t - windowDays * DAY) || trend[0];
  if (from.t >= to.t) return null;
  const days = (to.t - from.t) / DAY;
  return {
    rate: ((to.value - from.value) / days) * 7,
    days: Math.round(days),
    full: days >= MIN_RATE_DAYS,
    from,
    to,
  };
}

/* Everything the status card shows. All figures are anchored at the trend's
   last point rather than at the clock: a weigh-in three days ago is compared
   with where the line was three days ago, not where it is today. `asOf` says
   which day that was. Every field degrades to null rather than NaN, because
   on day one there is at most one weigh-in. */
export function goalStatus(goal, trend, now = Date.now()) {
  const valid = isValidGoal(goal);
  const last = trend.length ? trend[trend.length - 1] : null;
  const asOf = last ? last.t : now;
  const current = last ? last.value : null;
  const started = valid && asOf >= localDate(goal.start_date);

  const expected = valid ? goalLineAt(goal, asOf) : null;
  const diff = current != null && expected != null ? current - expected : null;

  let position = null;                     // 'on' | 'above' | 'below'
  if (diff != null) {
    position = Math.abs(diff) <= goal.band_lbs ? 'on' : diff > 0 ? 'above' : 'below';
  }

  const rate = trendRate(trend, asOf);

  // Pace flags need a full window, and only mean anything once the plan has
  // begun. "Stalled" needs two consecutive weekly windows that both show less
  // than STALL_RATE of loss, so one flat week isn't a verdict.
  let pace = null;                         // 'fast' | 'stalled'
  if (started && rate?.full) {
    if (-rate.rate > FAST_RATE) {
      pace = 'fast';
    } else {
      const weeks = Array.from({ length: STALL_WEEKS }, (_, k) => trendRate(trend, asOf - k * WEEK));
      const distinct = weeks.every((w, i) => w && (i === 0 || w.to.t < weeks[i - 1].to.t));
      if (distinct && weeks.every((w) => w.full && -w.rate < STALL_RATE)) pace = 'stalled';
    }
  }

  // Where this rate lands you. Only ever a date when you're actually losing
  // and the answer is within reason.
  let projection = null;                   // { kind: 'date', t, vsGoalDays } | { kind: 'reached' } | { kind: 'none' }
  if (valid && current != null && rate) {
    if (current <= goal.goal_lbs) {
      projection = { kind: 'reached' };
    } else if (rate.rate >= 0) {
      projection = { kind: 'none' };
    } else {
      const days = (current - goal.goal_lbs) / (-rate.rate / 7);
      projection = days > MAX_PROJECTION_DAYS
        ? { kind: 'none' }
        : {
          kind: 'date',
          t: asOf + days * DAY,
          vsGoalDays: Math.round((asOf + days * DAY - localDate(goal.goal_date)) / DAY),
        };
    }
  }

  return {
    valid,
    started,
    asOf,
    current,
    expected,
    diff,
    position,
    rate,
    pace,
    projection,
    planned: valid ? plannedRate(goal) : null,
    remaining: current != null ? current - goal.goal_lbs : null,
  };
}
