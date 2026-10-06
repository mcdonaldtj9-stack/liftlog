/* Weight view: log a weigh-in, see the trend.

   The number you see first is the TREND, corrected for the difference between
   your scales, never the latest raw reading. Raw readings are still plotted as
   dots so the correction stays honest and visible. */

import * as store from './store.js';
import * as photos from './photos.js';
import { analyse, trendAt } from './trend.js';
import {
  goalStatus, goalPath, goalLineAt, localDate, isValidGoal,
  DEFAULT_GOAL, STALL_RATE, FAST_RATE, MIN_RATE_DAYS,
} from './goal.js';
import { DAY, escapeHTML, dayStart, shortDate, longDate, niceStep } from './chart.js';

/* Categorical slots, dark steps, validated against the chart surface #171c24
   (all-pairs, CVD and contrast). A fourth scale onward folds into neutral —
   past three, hue stops being a reliable way to tell them apart. */
const SCALE_COLORS = ['#3987e5', '#d95926', '#199e70'];
const FOLDED_COLOR = '#898781';
const TREND_COLOR = '#e8edf4';
/* The goal line: a fourth hue, validated against the three scale colours on
   the chart surface. Dashed as well, so it never depends on colour alone. */
const GOAL_COLOR = '#8b6ff0';

/* A reading this far from the last one on the same scale gets a second look.
   Scales are compared only to themselves: two scales legitimately disagree. */
const CONFIRM_DELTA_LBS = 5;
const WEEKLY_TARGET = 3;
const OVERDUE_DAYS = 7;

const RANGES = [
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All', days: null },
  { key: 'goal', label: 'Goal', days: null },   // start date to goal date
];

let root = null;
let main = null;     // everything but the photos
let gallery = null;  // the photos, painted only when they change

const state = {
  readings: [],
  places: [],           // every place, for naming old readings
  scales: [],           // the ones you weigh at — the chips
  scaleId: null,        // selected scale for the next entry; null = other
  draft: '',
  date: '',             // yyyy-mm-dd, '' = now
  pendingConfirm: null,
  range: '90',
  inspect: null,        // day timestamp under the crosshair
  goal: DEFAULT_GOAL,   // replaced by the saved setting once loaded
};

/* ---------- helpers ---------- */

const fmt = (n) => (n == null ? '—' : Number(n).toFixed(1));
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1);

function fullDate(t) {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const scaleKey = (placeId) => placeId || 'other';

function placeName(key) {
  if (key === 'other') return 'Other scale';
  return state.places.find((p) => p.id === key)?.name || 'Removed location';
}

function shortName(key) {
  return placeName(key).replace('Planet Fitness — ', 'PF ');
}

/* Colour follows the scale, never its rank: order is fixed by when the place
   was created, so filtering the range can't repaint anything. */
function colorFor(key) {
  if (key === 'other') return FOLDED_COLOR;
  // Slots go to the scales in use; readings from anywhere else fold to neutral.
  const ordered = [...scalesInUse()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const index = ordered.findIndex((p) => p.id === key);
  return index >= 0 && index < SCALE_COLORS.length ? SCALE_COLORS[index] : FOLDED_COLOR;
}

function daysAgo(iso) {
  return Math.round((dayStart(Date.now()) - dayStart(new Date(iso).getTime())) / DAY);
}

function ago(iso) {
  const n = daysAgo(iso);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}

function todayInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* The chosen date as a timestamp: now for today, else 7am that morning — the
   usual weigh-in time, and far enough from midnight that a timezone can't
   push it onto the wrong day. */
function weighedAtFor(dateValue) {
  if (!dateValue || dateValue === todayInputValue()) return new Date().toISOString();
  const [y, m, d] = dateValue.split('-').map(Number);
  return new Date(y, m - 1, d, 7, 0).toISOString();
}

function asTrendReadings() {
  return state.readings.map((r) => ({
    t: new Date(r.weighed_at).getTime(),
    lbs: r.lbs,
    scale: scaleKey(r.place_id),
  }));
}

/* ---------- data ---------- */

async function refresh() {
  state.readings = await store.listWeights();
  state.places = await store.listPlaces();
  state.scales = await store.listScales();
  state.goal = await store.getSetting('weight_goal', DEFAULT_GOAL);
}

/* The chips: the places flagged for weighing, or every place if none are. */
function scalesInUse() {
  return state.scales.length ? state.scales : state.places;
}

const goalOn = () => isValidGoal(state.goal);

async function prefillFromScale() {
  const last = await store.lastWeightOn(state.scaleId);
  state.draft = last ? String(last.lbs) : '';
}

/* ---------- pieces ---------- */

function renderReminder() {
  const last = state.readings[state.readings.length - 1];
  if (!last) {
    return '<p class="wt-reminder">No weigh-ins yet. Log your first below.</p>';
  }

  const since = daysAgo(last.weighed_at);
  const weekStart = dayStart(Date.now()) - 6 * DAY;
  const thisWeek = state.readings.filter((r) => new Date(r.weighed_at).getTime() >= weekStart).length;

  return `
    <p class="wt-reminder ${since >= OVERDUE_DAYS ? 'is-overdue' : ''}">
      Last weigh-in ${escapeHTML(ago(last.weighed_at))}
      · ${thisWeek} of ${WEEKLY_TARGET} in the last 7 days
    </p>`;
}

function renderHero(analysis) {
  const { trend, delta, reference, offsets, excluded } = analysis;
  if (!trend.length) return '';

  const current = trend[trend.length - 1].value;
  const multiScale = offsets.size > 1;

  let deltaLine = 'Needs a couple more weigh-ins to show a direction.';
  if (delta && delta.days >= 3) {
    const size = Math.abs(delta.change);
    const span = delta.days >= 26 && delta.days <= 30 ? '4 weeks' : `${delta.days} days`;
    deltaLine = size < 0.3
      ? `Holding steady over ${span}`
      : `${delta.change < 0 ? '↓' : '↑'} ${size.toFixed(1)} lbs over ${span}`;
  }

  const offsetLines = [...offsets.entries()]
    .filter(([key, info]) => key !== reference && info.offset !== null)
    .map(([key, info]) => {
      const sign = info.offset >= 0 ? '+' : '−';
      return `<li><span class="wt-key" style="background:${colorFor(key)}"></span>
        ${escapeHTML(shortName(key))} reads ${sign}${Math.abs(info.offset).toFixed(1)} vs
        ${escapeHTML(shortName(reference))}
        <span class="wt-muted">(${info.pairs} paired weigh-ins)</span></li>`;
    }).join('');

  const excludedLines = excluded.map(({ scale, pairs }) => `
    <li class="wt-muted">
      <span class="wt-key" style="background:${colorFor(scale)}"></span>
      ${escapeHTML(shortName(scale))} isn't in the trend yet — weigh on it and on
      ${escapeHTML(shortName(reference))} within a few days of each other
      (${pairs} of 3 paired weigh-ins so far).
    </li>`).join('');

  return `
    <section class="wt-hero">
      <p class="wt-hero-label">Trend weight</p>
      <p class="wt-hero-value">${fmt(current)}<span> lbs</span></p>
      <p class="wt-hero-delta">${escapeHTML(deltaLine)}</p>
      ${multiScale ? `
        <p class="wt-hero-note">Scales corrected to read like
          ${escapeHTML(shortName(reference))}, so switching scales doesn't move the line.</p>` : ''}
      ${offsetLines || excludedLines ? `<ul class="wt-offsets">${offsetLines}${excludedLines}</ul>` : ''}
    </section>`;
}

/* Where you stand against the plan. Every figure comes off the trend line,
   never a raw reading, and is taken at the trend's last point: a weigh-in from
   three days ago is compared with the line three days ago. */
function renderGoal(analysis) {
  if (!goalOn()) return '';
  const goal = state.goal;
  const s = goalStatus(goal, analysis.trend);

  const badges = [];
  if (s.position === 'on') badges.push(['is-on', 'On track']);
  if (s.position === 'above') badges.push(['is-behind', `Behind by ${fmt(s.diff)}`]);
  if (s.position === 'below') badges.push(['is-ahead', `Ahead by ${fmt(-s.diff)}`]);
  if (s.pace === 'stalled') badges.push(['is-behind', 'Stalled']);
  if (s.pace === 'fast') badges.push(['is-fast', 'Too fast']);
  const badgeHTML = badges.map(([cls, text]) => `<span class="wt-badge ${cls}">${escapeHTML(text)}</span>`).join('');

  const rateText = !s.rate ? '—' : `${signed(s.rate.rate)}<span> /wk</span>`;
  const rateLabel = !s.rate ? 'Rate'
    : s.rate.full ? `Last ${s.rate.days} days` : `Last ${s.rate.days} day${s.rate.days === 1 ? '' : 's'} so far`;

  let outlook;
  if (s.current == null) {
    outlook = 'Log a weigh-in to see where you stand.';
  } else if (!s.rate) {
    outlook = 'One more weigh-in and the rate of loss shows here.';
  } else if (!s.rate.full && s.projection.kind !== 'reached') {
    // A date extrapolated from two days of trend would swing wildly.
    outlook = `A projected date shows once the trend covers ${MIN_RATE_DAYS} days (${s.rate.days} so far).`;
  } else if (s.projection.kind === 'reached') {
    outlook = `The trend is at or under ${fmt(goal.goal_lbs)}. Goal reached — now hold it.`;
  } else if (s.projection.kind === 'none') {
    outlook = s.rate.rate >= 0
      ? 'The trend isn\'t falling right now, so there\'s no date to project.'
      : 'At this rate the goal is more than two years out.';
  } else {
    const vs = s.projection.vsGoalDays;
    const weeks = Math.round(Math.abs(vs) / 7);
    const span = weeks < 1 ? `${Math.abs(vs)} days` : `${weeks} week${weeks === 1 ? '' : 's'}`;
    const timing = Math.abs(vs) <= 3 ? 'right on the goal date'
      : `${span} ${vs > 0 ? 'after' : 'before'} the goal date`;
    outlook = `At this rate you'd reach ${fmt(goal.goal_lbs)} around <strong>${escapeHTML(fullDate(s.projection.t))}</strong>, ${timing}.`;
  }

  const notes = [];
  if (s.pace === 'stalled') notes.push(`Under ${STALL_RATE} lb a week for two weeks running.`);
  if (s.pace === 'fast') notes.push(`Over ${FAST_RATE} lb a week — some of that is likely water or muscle, not fat.`);
  if (s.current != null && dayStart(s.asOf) !== dayStart(Date.now())) {
    notes.push(`As of ${longDate(s.asOf)}, your last weigh-in.`);
  }
  if (!s.started) notes.push(`The plan starts ${fullDate(localDate(goal.start_date))}.`);

  return `
    <section class="wt-goal">
      <div class="wt-goal-head">
        <p class="wt-hero-label">Goal · ${fmt(goal.goal_lbs)} lbs by ${escapeHTML(fullDate(localDate(goal.goal_date)))}</p>
        ${badgeHTML ? `<div class="wt-badges">${badgeHTML}</div>` : ''}
      </div>
      <dl class="wt-goal-grid">
        <div><dt>Trend now</dt><dd>${fmt(s.current)}</dd></div>
        <div><dt>Plan says</dt><dd>${fmt(s.expected)}</dd></div>
        <div><dt>Difference</dt><dd>${s.diff == null ? '—' : signed(s.diff)}</dd></div>
        <div><dt>${escapeHTML(rateLabel)}</dt><dd>${rateText}</dd></div>
      </dl>
      <p class="wt-goal-outlook">${outlook}</p>
      <p class="wt-hero-note">
        Plan: ${Math.abs(s.planned).toFixed(2)} lb a week, ±${fmt(goal.band_lbs)} lb counts as on track.
        ${notes.map(escapeHTML).join(' ')}
      </p>
      <button class="btn-link wt-goal-edit" data-act="wt-goal-edit">Edit goal</button>
    </section>`;
}

function renderEntry() {
  const chips = [
    ...scalesInUse().map((p) => ({ key: p.id, label: shortName(p.id) })),
    { key: 'other', label: 'Other' },
  ].map(({ key, label }) => `
    <button class="chip ${scaleKey(state.scaleId) === key ? 'is-on' : ''}"
            data-act="wt-scale" data-scale="${key}">
      <span class="wt-key" style="background:${colorFor(key)}"></span>${escapeHTML(label)}
    </button>`).join('');

  const confirm = state.pendingConfirm ? `
    <div class="weight-confirm">
      <p class="weight-confirm-lead">
        <strong>${fmt(state.pendingConfirm.lbs)} lbs</strong> — that's
        ${fmt(Math.abs(state.pendingConfirm.lbs - state.pendingConfirm.previous))} lbs
        ${state.pendingConfirm.lbs > state.pendingConfirm.previous ? 'more' : 'less'} than
        your last reading on this scale (${fmt(state.pendingConfirm.previous)}).
      </p>
      <div class="confirm-actions">
        <button class="btn btn-quiet" data-act="wt-cancel">Back</button>
        <button class="btn btn-danger" data-act="wt-confirm">Log ${fmt(state.pendingConfirm.lbs)}</button>
      </div>
    </div>` : `
    <button class="btn btn-block btn-log" data-act="wt-log">Log weight</button>`;

  return `
    <section class="wt-entry">
      <div class="field">
        <label for="wtValue">Weight (lbs)</label>
        <input id="wtValue" class="num" type="text" inputmode="decimal"
               autocomplete="off" placeholder="0.0" value="${escapeHTML(state.draft)}">
      </div>
      <div class="field">
        <label>Scale</label>
        <div class="chips chips-wrap">${chips}</div>
      </div>
      <div class="field wt-date">
        <label for="wtDate">Date</label>
        <input id="wtDate" class="search" type="date" max="${todayInputValue()}"
               value="${escapeHTML(state.date || todayInputValue())}">
      </div>
      ${confirm}
    </section>`;
}

/* ---------- the chart ---------- */

function renderChart(analysis) {
  const range = RANGES.find((r) => r.key === state.range) || RANGES[1];
  const all = asTrendReadings();
  const withGoal = goalOn();
  if (all.length < (withGoal ? 1 : 2)) return '';

  let end = dayStart(Date.now()) + DAY;
  let start;
  if (range.key === 'goal') {
    start = localDate(state.goal.start_date);
    end = Math.max(end, localDate(state.goal.goal_date) + DAY);
  } else if (range.days) {
    start = end - range.days * DAY;
  } else {
    start = dayStart(Math.min(...all.map((r) => r.t)));
  }
  const dots = all.filter((r) => r.t >= start && r.t < end);
  const line = analysis.trend.filter((p) => p.t >= start && p.t < end);
  if (!dots.length && !withGoal) {
    return `<p class="hint center">No weigh-ins in the last ${range.days} days.</p>`;
  }

  // The plan across the visible window, with its tolerance either side.
  const goal = withGoal ? goalPath(state.goal, start, end - DAY) : [];
  const band = withGoal ? state.goal.band_lbs : 0;

  const width = Math.max(280, (root?.clientWidth || 360));
  const height = 200;
  const pad = { top: 12, right: 12, bottom: 26, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Tight to the data, never from zero: a 3 lb change is the whole story.
  // The band edges count as data, so the plan is always in view.
  const values = [
    ...dots.map((d) => d.lbs),
    ...line.map((p) => p.value),
    ...goal.flatMap((p) => [p.value - band, p.value + band]),
  ];
  const step = niceStep(Math.max(...values) - Math.min(...values) + 2);
  const lo = Math.floor((Math.min(...values) - 1) / step) * step;
  const hi = Math.ceil((Math.max(...values) + 1) / step) * step;

  const x = (t) => pad.left + ((t - start) / (end - start)) * plotW;
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const pt = (t, v) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`;

  const grid = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid.push(`
      <line class="wt-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="wt-tick" x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }

  const xTicks = [];
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const t = start + ((end - start - DAY) * i) / tickCount;
    xTicks.push(`<text class="wt-tick" x="${x(t)}" y="${height - 8}"
      text-anchor="${i === 0 ? 'start' : i === tickCount ? 'end' : 'middle'}">${shortDate(t)}</text>`);
  }

  // The band is a wash under everything else; the line itself is dashed so it
  // reads as "the plan", not as another measurement.
  let plan = '';
  if (goal.length) {
    const upper = goal.map((p) => pt(p.t, p.value + band));
    const lower = [...goal].reverse().map((p) => pt(p.t, p.value - band));
    plan = `
      <polygon class="wt-band" points="${[...upper, ...lower].join(' ')}" fill="${GOAL_COLOR}"/>
      <polyline class="wt-goal-line" points="${goal.map((p) => pt(p.t, p.value)).join(' ')}"
                stroke="${GOAL_COLOR}"/>`;
  }

  const path = line.map((p, i) => `${i ? 'L' : 'M'}${pt(p.t, p.value)}`).join(' ');

  const marks = dots.map((d) => `
    <circle class="wt-dot" cx="${x(d.t).toFixed(1)}" cy="${y(d.lbs).toFixed(1)}" r="4.5"
            fill="${colorFor(d.scale)}"/>`).join('');

  // Crosshair on the day being inspected, through that day's dots.
  let crosshair = '';
  const inspected = dots.filter((d) => dayStart(d.t) === state.inspect);
  if (inspected.length) {
    const cx = x(inspected.reduce((sum, d) => sum + d.t, 0) / inspected.length).toFixed(1);
    crosshair = `<line class="wt-cross" x1="${cx}" x2="${cx}" y1="${pad.top}" y2="${height - pad.bottom}"/>`;
  }

  const scalesShown = [...new Set(dots.map((d) => d.scale))];
  const legend = scalesShown.length >= 2 || goal.length ? `
    <div class="wt-legend">
      ${scalesShown.map((key) => `<span><i class="wt-key" style="background:${colorFor(key)}"></i>${escapeHTML(shortName(key))}</span>`).join('')}
      <span><i class="wt-line-key"></i>Trend (corrected)</span>
      ${goal.length ? `
        <span><i class="wt-dash-key" style="border-color:${GOAL_COLOR}"></i>Goal</span>
        <span><i class="wt-band-key" style="background:${GOAL_COLOR}"></i>±${fmt(band)} lb</span>` : ''}
    </div>` : '';

  return `
    <div class="wt-ranges">
      ${RANGES.filter((r) => r.key !== 'goal' || withGoal).map((r) => `<button class="chip ${state.range === r.key ? 'is-on' : ''}"
        data-act="wt-range" data-range="${r.key}">${r.label}</button>`).join('')}
    </div>
    <p class="wt-readout" id="wtReadout" aria-live="polite">${renderReadout(analysis)}</p>
    <svg class="wt-chart" id="wtChart" width="${width}" height="${height}"
         viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Bodyweight trend chart with the goal line; every reading is listed below"
         data-start="${start}" data-end="${end}" data-left="${pad.left}" data-plot="${plotW}">
      ${grid.join('')}
      ${xTicks.join('')}
      <line class="wt-axis" x1="${pad.left}" x2="${width - pad.right}"
            y1="${height - pad.bottom}" y2="${height - pad.bottom}"/>
      ${plan}
      ${crosshair}
      ${marks}
      ${path ? `<path class="wt-trend" d="${path}" stroke="${TREND_COLOR}"/>` : ''}
    </svg>
    ${legend}`;
}

/* Values lead, labels follow. Everything here is also in the list below. */
function renderReadout(analysis) {
  if (state.inspect === null) return 'Tap the chart to read a day.';

  const day = state.inspect;
  const onDay = asTrendReadings().filter((r) => dayStart(r.t) === day);
  const trend = trendAt(analysis.trend, day + DAY - 1);

  const parts = [`<strong>${escapeHTML(longDate(day))}</strong>`];
  if (trend) parts.push(`trend <strong>${fmt(trend.value)}</strong>`);
  if (goalOn()) parts.push(`plan <strong>${fmt(goalLineAt(state.goal, day + DAY - 1))}</strong>`);
  for (const r of onDay) parts.push(`${escapeHTML(shortName(r.scale))} <strong>${fmt(r.lbs)}</strong>`);
  if (!onDay.length) parts.push('<span class="wt-muted">no weigh-in</span>');
  return parts.join(' · ');
}

function renderList() {
  if (!state.readings.length) return '';
  const rows = [...state.readings].reverse().slice(0, 60).map((r) => {
    const key = scaleKey(r.place_id);
    return `
      <li class="wt-row">
        <span class="wt-row-date">${escapeHTML(longDate(new Date(r.weighed_at).getTime()))}</span>
        <span class="wt-row-scale"><i class="wt-key" style="background:${colorFor(key)}"></i>${escapeHTML(shortName(key))}</span>
        <span class="wt-row-lbs">${fmt(r.lbs)}</span>
        <button class="set-del" data-act="wt-del" data-id="${r.id}" aria-label="Delete reading">×</button>
      </li>`;
  }).join('');

  return `
    <h3 class="section-label">Weigh-ins</h3>
    <ul class="wt-list">${rows}</ul>`;
}

/* ---------- render ---------- */

/* The bodyweight trend on a day, for the photo captions. */
function trendLbsAt(analysis) {
  return (t) => trendAt(analysis.trend, t)?.value ?? null;
}

/* Repaints the weight half only. The photo grid lives in its own container
   so a drag across the chart doesn't rebuild forty thumbnails. */
export function render() {
  if (!root) return;
  const analysis = analyse(asTrendReadings());

  main.innerHTML = `
    ${renderReminder()}
    ${renderHero(analysis)}
    ${renderGoal(analysis)}
    ${renderEntry()}
    ${renderChart(analysis)}
    ${renderList()}`;
  photos.setTrend(trendLbsAt(analysis));
}

/* ---------- events ---------- */

function readInputs() {
  const value = root.querySelector('#wtValue');
  if (value) state.draft = value.value.trim();
  const date = root.querySelector('#wtDate');
  if (date) state.date = date.value;
}

async function logReading({ confirmed = false } = {}) {
  readInputs();
  const lbs = Number(state.draft);
  if (!(lbs > 0)) {
    root.querySelector('#wtValue')?.focus();
    return;
  }

  if (!confirmed) {
    const previous = await store.lastWeightOn(state.scaleId);
    if (previous && Math.abs(lbs - previous.lbs) > CONFIRM_DELTA_LBS) {
      state.pendingConfirm = { lbs, previous: previous.lbs };
      return render();
    }
  }

  await store.addWeight({
    lbs: Math.round(lbs * 10) / 10,   // scales show one decimal
    place_id: state.scaleId,
    weighed_at: weighedAtFor(state.date),
  });

  state.pendingConfirm = null;
  state.date = '';
  await refresh();
  await prefillFromScale();
  render();
}

async function onClick(event) {
  if (await photos.onClick(event)) return;
  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;
  const { act } = trigger.dataset;

  if (act !== 'wt-confirm' && act !== 'wt-cancel') state.pendingConfirm = null;

  switch (act) {
    case 'wt-scale':
      readInputs();
      state.scaleId = trigger.dataset.scale === 'other' ? null : trigger.dataset.scale;
      await prefillFromScale();
      return render();

    case 'wt-log':
      return logReading();

    case 'wt-confirm':
      return logReading({ confirmed: true });

    case 'wt-cancel':
      state.pendingConfirm = null;
      return render();

    case 'wt-range':
      readInputs();
      state.range = trigger.dataset.range;
      state.inspect = null;
      return render();

    case 'wt-goal-edit':
      // The form lives on the Settings tab; the shell does the switching.
      document.dispatchEvent(new CustomEvent('liftlog:open-settings', { detail: { section: 'goal' } }));
      return;

    case 'wt-del': {
      const reading = state.readings.find((r) => r.id === trigger.dataset.id);
      if (!reading) return;
      await store.deleteWeight(reading);
      await refresh();
      return render();
    }
  }
}

function onInput(event) {
  if (photos.onInput(event)) return;
  if (event.target.id === 'wtValue') {
    state.draft = event.target.value;
    if (state.pendingConfirm) {
      state.pendingConfirm = null;
      readInputs();
      render();
      root.querySelector('#wtValue')?.focus();
    }
  }
  if (event.target.id === 'wtDate') state.date = event.target.value;
}

/* The crosshair snaps to the nearest day with anything on it, so a thumb
   doesn't have to land on a 9px dot. */
function onPointer(event) {
  const svg = event.target.closest('#wtChart');
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const start = Number(svg.dataset.start);
  const end = Number(svg.dataset.end);
  const left = Number(svg.dataset.left);
  const plot = Number(svg.dataset.plot);
  const t = start + ((event.clientX - rect.left - left) / plot) * (end - start);

  const days = [...new Set(asTrendReadings().map((r) => dayStart(r.t)))].filter((d) => d >= start);
  if (!days.length) return;
  const nearest = days.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));

  if (nearest !== state.inspect) {
    state.inspect = nearest;
    readInputs();
    render();
  }
}

/* ---------- lifecycle ---------- */

export async function mount(element) {
  root = element;
  main = document.createElement('div');
  gallery = document.createElement('div');
  gallery.className = 'ph-section';
  root.replaceChildren(main, gallery);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', (e) => { photos.onChange(e); });
  root.addEventListener('pointerdown', onPointer);
  root.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') onPointer(e); });

  await refresh();
  // Nothing in the weight half depends on the photos, so adding or deleting
  // one leaves it alone — and a weight typed but not yet logged stays put.
  await photos.mount(gallery, { trendAt: trendLbsAt(analyse(asTrendReadings())) });
  state.scaleId = await store.lastScaleId();
  // The remembered scale may be a gym from before the home scales existed,
  // or nothing at all on a fresh install: either way, start on a real scale.
  if (!scalesInUse().some((p) => p.id === state.scaleId)) {
    state.scaleId = scalesInUse()[0]?.id ?? null;
  }
  await prefillFromScale();
  render();
}

/* Re-render when the tab becomes visible, since the chart measures its own
   width and a hidden section measures as zero. Also called after a sync. */
export async function reload() {
  if (!root) return;
  readInputs();
  await refresh();
  render();
  await photos.reload();
}

/* For the Train tab's idle screen: how overdue the next weigh-in is. */
export async function daysSinceLastWeighIn() {
  const readings = await store.listWeights();
  if (!readings.length) return null;
  return daysAgo(readings[readings.length - 1].weighed_at);
}

export { OVERDUE_DAYS };
