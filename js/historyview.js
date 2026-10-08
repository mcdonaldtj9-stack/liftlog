/* History view: what you've done, and whether you're getting stronger.

   Three screens, navigated as a small stack:
     root      weekly sets by region, then every exercise you've trained
     exercise  last session first (it's what you check between sets), then
               strength over time, rep maxes, and every session with its note
     session   one workout in full — reached from Recent sessions on Train */

import * as store from './store.js';
import * as exeditor from './exeditor.js';
import {
  REGIONS, OTHER_REGION, filterByPlace, weeklySets, e1rmPerSession, bestByReps,
  meaningfulRepMaxes, e1rmChange, sessionsForExercise, exerciseSummaries,
  placesForExercise, isWorkingSet, progressSeries, seriesChange, relativeSeries,
} from './history.js';
import { analyse } from './trend.js';
import {
  DAY, INK, escapeHTML, shortDate, longDate, tightDomain, roundedTopRect, yGrid,
} from './chart.js';

/* Region colours: dark categorical steps in this order were run through the
   palette validator against the chart surface for adjacent stacked segments.
   "Other" is neutral, as a fold always is. */
const REGION_COLORS = {
  Chest: '#3987e5',
  Back: '#d95926',
  Shoulders: '#199e70',
  Arms: '#c98500',
  Legs: '#d55181',
  Core: '#9085e9',
  [OTHER_REGION]: '#5b6574',
};
const STRENGTH_COLOR = '#3987e5';
/* Same ink as the Weight tab's trend line, so bodyweight reads as bodyweight
   wherever it appears. Its own chart, never a second axis on this one. */
const BODYWEIGHT_COLOR = '#e8edf4';
const STACK_ORDER = [...REGIONS, OTHER_REGION];

const RANGES = [
  { key: '84', label: '12 weeks', days: 84 },
  { key: 'all', label: 'All', days: null },
];

let root = null;

const state = {
  stack: [{ view: 'root' }],
  data: null,
  query: '',
  placeFilter: null,     // exercise detail: null = all places
  range: '84',
  metric: null,          // exercise detail: which progress chart; null = the first
  inspectWeek: null,
  inspectSession: null,
  exDraft: null,         // exercise being edited
  setEdit: null,         // { id, draft, confirmDelete } for a past set
};

const top = () => state.stack[state.stack.length - 1];

/* ---------- data ---------- */

async function load() {
  const [sets, workouts, notes, exercises, places, templates, weights] = await Promise.all([
    store.allSets(), store.allWorkouts(), store.allNotes(),
    store.listExercises(), store.listPlaces(), store.allTemplates(), store.listWeights(),
  ]);
  // The same scale-corrected trend the Weight tab draws, computed once.
  const { trend } = analyse(weights.map((r) => ({
    t: new Date(r.weighed_at).getTime(), lbs: r.lbs, scale: r.place_id || 'other',
  })));
  state.data = {
    sets,
    notes,
    workoutsById: new Map(workouts.map((w) => [w.id, w])),
    exercisesById: new Map(exercises.map((e) => [e.id, e])),
    exercises,
    places,
    templatesById: new Map(templates.map((t) => [t.id, t])),
    bodyweightTrend: trend,
  };
}

/* ---------- formatting ---------- */

const w = (n) => (Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(1))));

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Compact set notation, e.g. "185×8@8", "↳135×12", "245×1 F". */
function compactSet(set, exercise) {
  let body;
  if (exercise?.tracks === 'time') body = mmss(set.seconds);
  else if (exercise?.tracks === 'bodyweight_reps') {
    body = `${set.weight ? `BW+${w(set.weight)}` : 'BW'}×${set.reps ?? 0}`;
  } else body = `${w(set.weight ?? 0)}×${set.reps ?? 0}`;

  if (set.failed) body += ' F';
  else if (set.rpe != null) body += `@${w(set.rpe)}`;
  if (set.is_dropset) body = `↳${body}`;
  return body;
}

function setChips(sets, exercise, { editable = false } = {}) {
  return sets.map((set) => {
    const cls = set.failed ? 'is-fail' : set.is_warmup ? 'is-warm' : set.is_dropset ? 'is-drop' : '';
    const label = `${escapeHTML(compactSet(set, exercise))}${set.is_pr ? ' <b class="hs-pr">PR</b>' : ''}`;
    const on = state.setEdit?.id === set.id ? ' is-on' : '';
    return editable
      ? `<button class="hs-set hs-set-btn ${cls}${on}" data-act="hs-edit-set" data-id="${set.id}"
                 aria-label="Edit this set">${label}</button>`
      : `<span class="hs-set ${cls}">${label}</span>`;
  }).join('');
}

/* A compact editor for a set from a finished session. */
function renderSetEditor(set, exercise) {
  const d = state.setEdit.draft;
  const isTime = exercise?.tracks === 'time';
  const rpeOptions = ['', 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((v) =>
    `<option value="${v}" ${String(d.rpe ?? '') === String(v) ? 'selected' : ''}>${v === '' ? '—' : v}</option>`).join('');

  return `
    <div class="hs-edit">
      <div class="hs-edit-row">
        ${isTime ? '' : `
          <label>Weight<input class="num hs-num" id="heWeight" type="text" inputmode="decimal"
                 value="${d.weight ?? ''}"></label>`}
        <label>${isTime ? 'Seconds' : 'Reps'}<input class="num hs-num" id="heReps" type="text"
               inputmode="numeric" value="${(isTime ? d.seconds : d.reps) ?? ''}"></label>
        <label>RPE<select class="hs-select" id="heRpe" ${d.failed ? 'disabled' : ''}>${rpeOptions}</select></label>
      </div>
      <div class="hs-edit-row">
        <label class="warmup"><input type="checkbox" id="heFailed" ${d.failed ? 'checked' : ''}><span>Failed</span></label>
        <label class="warmup"><input type="checkbox" id="heWarmup" ${d.is_warmup ? 'checked' : ''}><span>Warmup</span></label>
      </div>
      ${state.setEdit.confirmDelete ? `
        <div class="confirm-actions">
          <button class="btn btn-quiet" data-act="hs-set-keep">Keep it</button>
          <button class="btn btn-danger" data-act="hs-set-delete-confirm">Delete set</button>
        </div>` : `
        <div class="confirm-actions">
          <button class="btn btn-quiet" data-act="hs-set-cancel">Cancel</button>
          <button class="btn" data-act="hs-set-save">Save</button>
        </div>
        <button class="btn-link danger" data-act="hs-set-delete">Delete this set</button>`}
    </div>`;
}

function readSetEditor() {
  if (!state.setEdit) return;
  const num = (id) => {
    const el = root.querySelector(id);
    if (!el) return undefined;
    const raw = el.value.trim();
    const v = raw === '' ? null : Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const d = state.setEdit.draft;
  const weight = num('#heWeight');
  if (weight !== undefined) d.weight = weight;
  const reps = num('#heReps');
  if (reps !== undefined) {
    if (d.tracksTime) d.seconds = reps; else d.reps = reps;
  }
  const rpe = root.querySelector('#heRpe');
  if (rpe) d.rpe = rpe.value === '' ? null : Number(rpe.value);
  const failed = root.querySelector('#heFailed');
  if (failed) d.failed = failed.checked ? 1 : 0;
  const warm = root.querySelector('#heWarmup');
  if (warm) d.is_warmup = warm.checked ? 1 : 0;
}

function placeName(id) {
  if (!id) return 'No location';
  return state.data.places.find((p) => p.id === id)?.name.replace('Planet Fitness — ', 'PF ')
    || 'Removed location';
}

function dateAgo(iso) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return shortDate(new Date(iso).getTime());
}

/* ---------- root: weekly sets ---------- */

function renderWeeklyChart() {
  const weeks = weeklySets(state.data.sets, state.data.exercisesById, { weeks: 8 });
  const any = weeks.some((wk) => wk.total > 0);
  if (!any) return '';

  const width = Math.max(280, root?.clientWidth || 360);
  const height = 190;
  const pad = { top: 20, right: 8, bottom: 24, left: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxTotal = Math.max(...weeks.map((wk) => wk.total), 4);
  const step = maxTotal <= 10 ? 2 : maxTotal <= 25 ? 5 : 10;
  const hi = Math.ceil(maxTotal / step) * step;
  const y = (v) => pad.top + (1 - v / hi) * plotH;

  const band = plotW / weeks.length;
  const barW = Math.min(24, band * 0.6);
  const GAP = 2;

  const bars = weeks.map((wk, i) => {
    const x = pad.left + band * i + (band - barW) / 2;
    const present = STACK_ORDER.filter((r) => wk.byRegion.get(r));
    let base = 0;
    const segments = present.map((region, index) => {
      const count = wk.byRegion.get(region);
      const y0 = y(base);
      const y1 = y(base + count);
      base += count;
      // 2px surface gap between segments; only the topmost gets rounded ends.
      const h = Math.max(1, y0 - y1 - (index < present.length - 1 ? GAP : 0));
      const top = y1 + (index < present.length - 1 ? GAP : 0);
      const isTop = index === present.length - 1;
      return isTop
        ? `<path d="${roundedTopRect(x, y1, barW, y0 - y1)}" fill="${REGION_COLORS[region]}"/>`
        : `<rect x="${x}" y="${top}" width="${barW}" height="${h}" fill="${REGION_COLORS[region]}"/>`;
    }).join('');

    const label = wk.total
      ? `<text class="ch-total" x="${x + barW / 2}" y="${y(wk.total) - 6}" text-anchor="middle">${wk.total}</text>`
      : '';
    const selected = state.inspectWeek === wk.weekStart;
    return `
      <g class="hs-week ${wk.partial ? 'is-partial' : ''} ${selected ? 'is-on' : ''}">
        ${segments}${label}
        <rect class="hs-hit" data-week="${wk.weekStart}" x="${pad.left + band * i}" y="${pad.top}"
              width="${band}" height="${plotH + pad.bottom}" fill="transparent"/>
        <text class="ch-tick" x="${x + barW / 2}" y="${height - 6}" text-anchor="middle">${
          wk.partial ? 'now' : shortDate(wk.weekStart).replace(/ /, ' ')}</text>
      </g>`;
  }).join('');

  const shown = STACK_ORDER.filter((r) => weeks.some((wk) => wk.byRegion.get(r)));
  const legend = shown.map((r) => `
    <span><i class="hs-swatch" style="background:${REGION_COLORS[r]}"></i>${escapeHTML(r)}</span>`).join('');

  return `
    <section class="hs-card">
      <h3 class="hs-title">Working sets per week</h3>
      <p class="hs-sub">Bars count each set once, by its major muscle. The table
         adds half a set for every minor muscle. This week is still in progress.</p>
      <p class="hs-readout">${renderWeekReadout(weeks)}</p>
      <svg class="hs-chart" id="hsWeekly" width="${width}" height="${height}"
           viewBox="0 0 ${width} ${height}" role="img"
           aria-label="Working sets per week by region; the table below lists every muscle">
        ${yGrid({ lo: 0, hi, step, y, left: pad.left, right: width - pad.right })}
        <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"
              stroke="${INK.axis}" stroke-width="1"/>
        ${bars}
      </svg>
      <div class="hs-legend">${legend}</div>
      ${renderMuscleTable(weeks)}
    </section>`;
}

function renderWeekReadout(weeks) {
  const wk = weeks.find((x) => x.weekStart === state.inspectWeek);
  if (!wk) return 'Tap a week for its breakdown.';
  const parts = STACK_ORDER.filter((r) => wk.byRegion.get(r))
    .map((r) => `${escapeHTML(r)} <strong>${wk.byRegion.get(r)}</strong>`);
  return `<strong>${wk.partial ? 'This week so far' : `Week of ${shortDate(wk.weekStart)}`}</strong>
    · <strong>${wk.total}</strong> sets${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

/* The table twin: every individual muscle, this week against last. */
function renderMuscleTable(weeks) {
  const now = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const muscles = [...new Set([...now.byMuscle.keys(), ...prev.byMuscle.keys()])]
    .sort((a, b) => (now.byMuscle.get(b) || 0) - (now.byMuscle.get(a) || 0)
      || (prev.byMuscle.get(b) || 0) - (prev.byMuscle.get(a) || 0));
  if (!muscles.length) return '';

  // Minor muscles earn half sets, so a count can end in .5.
  const cell = (n) => (n ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : '—');
  const rows = muscles.map((m) => `
    <tr><th scope="row">${escapeHTML(m)}</th>
        <td>${cell(now.byMuscle.get(m))}</td>
        <td>${cell(prev.byMuscle.get(m))}</td></tr>`).join('');

  return `
    <table class="hs-table">
      <thead><tr><th></th><th>This week</th><th>Last week</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------- root: exercise list ---------- */

function renderExerciseList() {
  const rows = exerciseSummaries(state.data.exercises, state.data.sets, state.data.workoutsById);
  if (!rows.length) {
    return `<div class="empty"><div class="empty-icon">📈</div><h2>Nothing yet</h2>
      <p>Finish a session and your exercises, rep maxes and strength trend show up here.</p></div>`;
  }

  const q = state.query.trim().toLowerCase();
  const matches = rows.filter((r) => !q || r.exercise.name.toLowerCase().includes(q));

  const list = matches.map((r) => `
    <li>
      <button class="pick-row" data-act="hs-exercise" data-id="${r.exercise.id}">
        <span class="hs-ex-main">
          <span class="pick-name">${escapeHTML(r.exercise.name)}</span>
          <span class="hs-ex-meta">${escapeHTML(dateAgo(r.lastAt))} · ${r.sessions}
            ${r.sessions === 1 ? 'session' : 'sessions'}</span>
        </span>
        <span class="hs-ex-best">${r.bestE1RM ? `${Math.round(r.bestE1RM)}<small>e1RM</small>` : ''}</span>
      </button>
    </li>`).join('');

  return `
    <h3 class="section-label">Exercises</h3>
    <input class="search" id="hsSearch" type="text" autocomplete="off"
           placeholder="Search your exercises" value="${escapeHTML(state.query)}">
    <ul class="pick-list">${list || '<li class="hint center">No match.</li>'}</ul>`;
}

/* ---------- exercise detail ---------- */

/* ---------- progress charts ----------
   Every exercise gets charts, chosen by how it's tracked. Peaks are lines on
   a tight scale, because the change is the story; totals are bars from zero,
   because a bar's length is its value. */

const lbs = (v) => `${w(Math.round(v))} lbs`;
const bigLbs = (v) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k lbs` : `${Math.round(v).toLocaleString()} lbs`);
const kTick = (v) => (v >= 1000 ? `${w(v / 1000)}k` : String(v));

const METRICS = {
  weight_reps: [
    { key: 'e1rm', label: 'Est. 1RM', form: 'line', fmt: lbs,
      sub: 'Best estimated one-rep max each session, from sets of up to 12 reps counting RPE.' },
    { key: 'top', label: 'Top set', form: 'line', fmt: lbs,
      sub: 'The heaviest working set each session.' },
    { key: 'volume', label: 'Volume', form: 'bar', fmt: bigLbs, tick: kTick,
      sub: 'Weight × reps added up across every working set, per session.' },
    { key: 'relative', label: 'Relative', form: 'line', exact: true, needsBodyweight: true,
      fmt: (v) => `${v.toFixed(2)}× BW`, tick: (v) => `${v.toFixed(2)}×`, domain: ratioDomain,
      steady: 0.02,
      sub: 'Estimated 1RM divided by your bodyweight trend on the day. On a cut, this climbs even while the 1RM holds.' },
  ],
  bodyweight_reps: [
    { key: 'reps', label: 'Best set', form: 'line', fmt: (v) => `${v} reps`,
      sub: 'The most reps in one working set each session.' },
    { key: 'totalReps', label: 'Total reps', form: 'bar', fmt: (v) => `${v} reps`,
      sub: 'Reps across every working set, per session.' },
    { key: 'top', label: 'Most added', form: 'line', fmt: lbs, optional: true,
      sub: 'The most weight added to bodyweight each session.' },
  ],
  time: [
    { key: 'hold', label: 'Longest', form: 'line', fmt: mmss, tick: mmss,
      sub: 'The longest working set each session.' },
    { key: 'totalTime', label: 'Total time', form: 'bar', fmt: mmss, tick: mmss, step: timeStep,
      sub: 'Time across every working set, per session.' },
  ],
};

/* A gridline step for a bar scale from zero: 1, 2 or 5 times a power of ten,
   aiming for about four lines whatever the size (12 reps or 18,000 lbs). */
function barStep(max) {
  const raw = Math.max(max, 1) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/* Gridlines for a ratio like 1.38× bodyweight: hundredths-sized steps that
   still land on round numbers, about four lines across. */
function ratioDomain(values) {
  const min = Math.min(...values) - 0.02;
  const max = Math.max(...values) + 0.02;
  const step = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1].find((s) => (max - min) / s <= 5) || 1;
  return {
    lo: Math.floor(min / step) * step,
    hi: Math.ceil(max / step) * step,
    step,
  };
}

/* Clock-friendly gridlines for seconds: 0:30, 1:00, 2:00, never 0:50. */
function timeStep(max) {
  return [15, 30, 60, 120, 300, 600, 1200, 1800, 3600].find((s) => max / s <= 5) || 3600;
}

function inRange(points) {
  const range = RANGES.find((r) => r.key === state.range);
  return range.days ? points.filter((p) => p.t >= Date.now() - range.days * DAY) : points;
}

function renderProgressChart(points, metric, bestPoint) {
  const shown = inRange(points);
  if (shown.length < 2) {
    return `<p class="hint">${shown.length
      ? 'One session so far — the chart starts at two.'
      : 'No qualifying sets in this range.'}</p>`;
  }
  return metric.form === 'bar'
    ? renderBarChart(shown, metric, bestPoint)
    : renderLineChart(shown, metric, bestPoint);
}

/* Sessions side by side, evenly spaced: the gaps between sessions aren't the
   point of a per-session total, and bars on a time axis would collide. */
function renderBarChart(shown, metric, bestPoint) {
  const width = Math.max(280, root?.clientWidth || 360);
  const height = 180;
  const pad = { top: 12, right: 10, bottom: 24, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const step = (metric.step || barStep)(Math.max(...shown.map((p) => p.value)));
  const hi = Math.ceil(Math.max(...shown.map((p) => p.value)) / step) * step;
  const y = (v) => pad.top + (1 - v / hi) * plotH;
  const band = plotW / shown.length;
  const barW = Math.max(3, Math.min(22, band - 2));   // a 2px gap between bars

  const bars = shown.map((p, i) => {
    const x = pad.left + band * i + (band - barW) / 2;
    const on = state.inspectSession === p.workoutId;
    // Only the tapped session stands out; until then every bar is full.
    const dim = state.inspectSession !== null && !on && shown.some((q) => q.workoutId === state.inspectSession);
    return `
      <path class="hs-bar ${on ? 'is-on' : ''}" d="${roundedTopRect(x, y(p.value), barW, y(0) - y(p.value))}"
            fill="${STRENGTH_COLOR}" opacity="${dim ? 0.45 : 1}"/>
      <rect class="hs-hit" data-session="${p.workoutId}" x="${pad.left + band * i}" y="${pad.top}"
            width="${band}" height="${plotH}" fill="transparent"/>`;
  }).join('');

  return `
    <svg class="hs-chart" id="hsProgress" width="${width}" height="${height}"
         viewBox="0 0 ${width} ${height}" role="img"
         aria-label="${escapeHTML(metric.label)} per session; every session is listed below">
      ${yGrid({ lo: 0, hi, step, y, left: pad.left, right: width - pad.right, format: metric.tick || String })}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"
            stroke="${INK.axis}" stroke-width="1"/>
      ${bars}
      <text class="ch-tick" x="${pad.left}" y="${height - 6}" text-anchor="start">${shortDate(shown[0].t)}</text>
      <text class="ch-tick" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${shortDate(shown[shown.length - 1].t)}</text>
    </svg>`;
}

function renderLineChart(shown, metric, prPoint) {
  const points = shown.map((p) => ({ ...p, e1rm: p.value }));
  return renderStrengthChart(points, prPoint, metric);
}

function renderStrengthChart(shown, prPoint, metric) {

  const width = Math.max(280, root?.clientWidth || 360);
  const height = 180;
  const pad = { top: 12, right: 14, bottom: 24, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const start = shown[0].t;
  const end = Math.max(shown[shown.length - 1].t, start + DAY);
  const { lo, hi, step } = metric?.domain
    ? metric.domain(shown.map((p) => p.e1rm))
    : tightDomain(shown.map((p) => p.e1rm), { air: metric?.key === 'reps' ? 1 : 3 });
  const x = (t) => pad.left + ((t - start) / (end - start)) * plotW;
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

  const path = shown.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.e1rm).toFixed(1)}`).join(' ');
  const dots = shown.map((p) => {
    const isPR = prPoint && p.workoutId === prPoint.workoutId;
    const on = state.inspectSession === p.workoutId;
    return `
      ${isPR ? `<circle cx="${x(p.t)}" cy="${y(p.e1rm)}" r="8" fill="none" stroke="${STRENGTH_COLOR}" stroke-width="2"/>` : ''}
      <circle class="hs-dot ${on ? 'is-on' : ''}" cx="${x(p.t)}" cy="${y(p.e1rm)}" r="${on ? 5.5 : 4.5}"
              fill="${STRENGTH_COLOR}"/>
      <circle class="hs-hit" data-session="${p.workoutId}" cx="${x(p.t)}" cy="${y(p.e1rm)}" r="14" fill="transparent"/>`;
  }).join('');

  return `
    <svg class="hs-chart" id="hsProgress" width="${width}" height="${height}"
         viewBox="0 0 ${width} ${height}" role="img"
         aria-label="${escapeHTML(metric?.label || 'Progress')} per session; every session is listed below">
      ${yGrid({ lo, hi, step, y, left: pad.left, right: width - pad.right, format: metric?.tick || String })}
      <path d="${path}" fill="none" stroke="${STRENGTH_COLOR}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <text class="ch-tick" x="${pad.left}" y="${height - 6}" text-anchor="start">${shortDate(start)}</text>
      <text class="ch-tick" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${shortDate(end)}</text>
    </svg>`;
}

function renderExercise(exerciseId) {
  const exercise = state.data.exercisesById.get(exerciseId);
  if (!exercise) return '<p class="hint">That exercise no longer exists.</p>';

  const { workoutsById, notes } = state.data;
  const mine = state.data.sets.filter((s) => s.exercise_id === exerciseId);
  const sets = filterByPlace(mine, workoutsById, state.placeFilter);
  const sessions = sessionsForExercise(exerciseId, sets, workoutsById, notes);
  const isWeighted = exercise.tracks === 'weight_reps';

  // Location filter: only places this exercise has actually been done at.
  const doneAt = [...placesForExercise(exerciseId, mine, workoutsById)];
  const filter = doneAt.length > 1 ? `
    <div class="hs-filter">
      <button class="chip ${state.placeFilter === null ? 'is-on' : ''}" data-act="hs-place" data-place="">All</button>
      ${doneAt.map((id) => `<button class="chip ${state.placeFilter === id ? 'is-on' : ''}"
        data-act="hs-place" data-place="${id}">${escapeHTML(placeName(id))}</button>`).join('')}
    </div>` : '';

  // The most recent session first: this is the screen you open between sets.
  const latest = sessions[0];
  const latestCard = latest ? `
    <section class="hs-card hs-latest">
      <p class="hs-kicker">Last time · ${escapeHTML(dateAgo(latest.workout.started_at))}
        · ${escapeHTML(placeName(latest.workout.place_id))}</p>
      <div class="hs-sets">${setChips(latest.sets, exercise)}</div>
      ${latest.note ? `<p class="hs-note">“${escapeHTML(latest.note)}”</p>` : ''}
    </section>` : '<p class="hint">Nothing logged here yet.</p>';

  const strength = renderProgress(exercise, sets, workoutsById);

  const older = sessions.slice(1).map((s) => `
    <li class="hs-session">
      <button class="hs-session-head" data-act="hs-session" data-id="${s.workout.id}">
        <span>${escapeHTML(longDate(new Date(s.workout.started_at).getTime()))}</span>
        <span class="hs-when">${escapeHTML(placeName(s.workout.place_id))} ›</span>
      </button>
      <div class="hs-sets">${setChips(s.sets, exercise)}</div>
      ${s.note ? `<p class="hs-note">“${escapeHTML(s.note)}”</p>` : ''}
    </li>`).join('');

  return `
    ${renderBack(exercise.name, { editId: exercise.id })}
    ${filter}
    ${latestCard}
    ${strength}
    ${older ? `<h3 class="section-label">Earlier sessions</h3><ul class="hs-sessions">${older}</ul>` : ''}`;
}

/* The progress card: pick a chart, see your best, how it's moved, and any
   session by tapping it. */
function renderProgress(exercise, sets, workoutsById) {
  const tracks = METRICS[exercise.tracks] ? exercise.tracks : 'weight_reps';
  const trend = state.data.bodyweightTrend;
  const seriesFor = (metric) => (metric.key === 'relative'
    ? relativeSeries(progressSeries(sets, workoutsById, 'e1rm'), trend)
    : progressSeries(sets, workoutsById, metric.key));
  const series = METRICS[tracks]
    .filter((metric) => !metric.needsBodyweight || trend.length)
    .map((metric) => ({ metric, points: seriesFor(metric) }))
    // An optional chart only appears once there's something to draw.
    .filter(({ metric, points }) => !metric.optional || points.length >= 2);
  if (!series.some(({ points }) => points.length)) return '';

  const chosen = series.find((s) => s.metric.key === state.metric) || series[0];
  const { metric, points } = chosen;
  const shown = inRange(points);
  const bestPoint = shown.length ? shown.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const allTimeBest = points.length ? points.reduce((a, b) => (b.value > a.value ? b : a)) : null;

  const round = (v) => (metric.exact ? v : Math.round(v));
  const change = seriesChange(points, { days: 84 });
  const steady = metric.steady ?? (metric.key === 'e1rm' || metric.key === 'top' ? 2 : 0);
  const changeText = change && change.days >= 14
    ? (Math.abs(change.change) <= steady
      ? 'holding steady over 12 weeks'
      : `${change.change > 0 ? '↑' : '↓'} ${metric.fmt(Math.abs(round(change.change)))} over ${Math.round(change.days / 7)} weeks`)
    : '';

  const tabs = series.length > 1 ? `
    <div class="hs-filter hs-metrics" role="tablist">
      ${series.map(({ metric: m }) => `<button class="chip ${m.key === metric.key ? 'is-on' : ''}"
        role="tab" aria-selected="${m.key === metric.key}"
        data-act="hs-metric" data-metric="${m.key}">${escapeHTML(m.label)}</button>`).join('')}
    </div>` : '';

  let repMaxes = '';
  if (exercise.tracks === 'weight_reps') {
    const reps = meaningfulRepMaxes(bestByReps(sets));
    const repRows = [...reps.entries()].map(([n, set]) => `
      <li><span class="hs-rm">${n}RM</span><strong>${w(set.weight)}</strong>
          <span class="hs-when">${escapeHTML(shortDate(new Date(set.created_at).getTime()))}</span></li>`).join('');
    if (repRows) repMaxes = `<h3 class="section-label">Rep maxes</h3><ul class="hs-rms">${repRows}</ul>`;
  }

  return `
    <section class="hs-card">
      ${tabs}
      <p class="hs-kicker">${escapeHTML(metric.label)} · best</p>
      <p class="hs-hero">${allTimeBest ? escapeHTML(metric.fmt(round(allTimeBest.value))) : '—'}</p>
      ${changeText ? `<p class="hs-change">${escapeHTML(changeText)}</p>` : ''}
      <div class="hs-filter hs-range">
        ${RANGES.map((r) => `<button class="chip ${state.range === r.key ? 'is-on' : ''}"
          data-act="hs-range" data-range="${r.key}">${r.label}</button>`).join('')}
      </div>
      <p class="hs-readout">${renderSessionReadout(points, exercise, metric)}</p>
      ${renderProgressChart(points, metric, bestPoint)}
      ${exercise.tracks === 'weight_reps' && metric.form === 'line' ? renderBodyweightStrip(inRange(points), trend) : ''}
      <p class="hs-sub">${escapeHTML(metric.sub)} Warmups, drops and F sets are left out.${
        metric.form === 'line' ? ' The ringed point is the best in view.' : ''}</p>
      ${repMaxes}
    </section>`;
}

function renderSessionReadout(points, exercise, metric) {
  const point = points.find((p) => p.workoutId === state.inspectSession);
  if (!point) return 'Tap a session on the chart to see it.';
  const value = metric.exact ? point.value : Math.round(point.value);
  let detail = point.set
    ? `from ${escapeHTML(compactSet(point.set, exercise))}`
    : `${point.sets} working ${point.sets === 1 ? 'set' : 'sets'}`;
  if (metric.key === 'relative') {
    detail = `e1RM ${Math.round(point.e1rm)} at ${point.bodyweight.toFixed(1)} lbs`;
  } else if (exercise.tracks === 'weight_reps') {
    const bw = relativeSeries([point], state.data.bodyweightTrend)[0]?.bodyweight;
    if (bw) detail += ` · ${bw.toFixed(1)} lbs bodyweight`;
  }
  return `<strong>${escapeHTML(longDate(point.t))}</strong> · ${escapeHTML(metric.label)}
    <strong>${escapeHTML(metric.fmt(value))}</strong> · ${detail}`;
}

/* Bodyweight under the strength chart: same dates, same left and right
   edges, its own scale. Two charts stacked rather than one with two axes, so
   neither line can be made to look like it's chasing the other. */
function renderBodyweightStrip(shown, trend) {
  if (shown.length < 2 || !trend.length) return '';
  const start = shown[0].t;
  const end = Math.max(shown[shown.length - 1].t, start + DAY);
  // The trend inside the window, plus its value at each edge so the line
  // spans the same width as the strength line above it.
  const inside = trend.filter((p) => p.t > start && p.t < end);
  const edge = (t) => {
    const before = [...trend].reverse().find((p) => p.t <= t);
    return before ? { t, value: before.value } : null;
  };
  const line = [edge(start), ...inside, edge(end)].filter(Boolean);
  if (line.length < 2) return '';

  const width = Math.max(280, root?.clientWidth || 360);
  const height = 92;
  const pad = { top: 10, right: 14, bottom: 8, left: 40 };   // matches the chart above
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { lo, hi, step } = tightDomain(line.map((p) => p.value), { air: 1 });
  const x = (t) => pad.left + ((t - start) / (end - start)) * plotW;
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const path = line.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  const first = line[0].value;
  const last = line[line.length - 1].value;
  const moved = last - first;
  const summary = `${first.toFixed(1)} → ${last.toFixed(1)} lbs${
    Math.abs(moved) >= 0.1 ? ` (${moved > 0 ? '+' : '−'}${Math.abs(moved).toFixed(1)})` : ''}`;
  const onPoint = shown.find((p) => p.workoutId === state.inspectSession);

  return `
    <div class="hs-bw">
      <p class="hs-bw-head"><span>Bodyweight trend</span><strong>${escapeHTML(summary)}</strong></p>
      <svg class="hs-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="Bodyweight trend over the same dates, ${escapeHTML(summary)}">
        ${yGrid({ lo, hi, step: Math.max(step, (hi - lo) / 2), y, left: pad.left, right: width - pad.right })}
        ${onPoint ? `<line x1="${x(onPoint.t)}" x2="${x(onPoint.t)}" y1="${pad.top}" y2="${height - pad.bottom}"
              stroke="${INK.cross}" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
        <path d="${path}" fill="none" stroke="${BODYWEIGHT_COLOR}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </div>`;
}

/* ---------- session detail ---------- */

function renderSession(workoutId) {
  const workout = state.data.workoutsById.get(workoutId);
  if (!workout) return `${renderBack('Session')}<p class="hint">That session was discarded.</p>`;

  const sets = state.data.sets
    .filter((s) => s.workout_id === workoutId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const order = [];
  for (const s of sets) if (!order.includes(s.exercise_id)) order.push(s.exercise_id);

  const minutes = workout.ended_at
    ? Math.round((new Date(workout.ended_at) - new Date(workout.started_at)) / 60000)
    : null;
  const routine = workout.template_id ? state.data.templatesById.get(workout.template_id) : null;
  const working = sets.filter(isWorkingSet).length;

  const blocks = order.map((exerciseId) => {
    const exercise = state.data.exercisesById.get(exerciseId);
    const note = state.data.notes.find((n) => n.workout_id === workoutId
      && n.exercise_id === exerciseId && n.body?.trim());
    return `
      <li class="hs-session">
        <button class="hs-session-head" data-act="hs-exercise" data-id="${exerciseId}">
          <span>${escapeHTML(exercise?.name || 'Removed exercise')}</span>
          <span class="hs-when">history ›</span>
        </button>
        <div class="hs-sets">${setChips(sets.filter((s) => s.exercise_id === exerciseId), exercise, { editable: true })}</div>
        ${state.setEdit && sets.some((s) => s.id === state.setEdit.id && s.exercise_id === exerciseId)
          ? renderSetEditor(sets.find((s) => s.id === state.setEdit.id), exercise) : ''}
        ${note ? `<p class="hs-note">“${escapeHTML(note.body)}”</p>` : ''}
      </li>`;
  }).join('');

  return `
    ${renderBack(longDate(new Date(workout.started_at).getTime()))}
    <section class="hs-card">
      <p class="hs-kicker">${escapeHTML(placeName(workout.place_id))}${routine ? ` · ${escapeHTML(routine.name)}` : ''}</p>
      <p class="hs-summary">${minutes !== null ? `<strong>${minutes}</strong> min · ` : ''}<strong>${working}</strong>
        working ${working === 1 ? 'set' : 'sets'} · <strong>${order.length}</strong>
        ${order.length === 1 ? 'exercise' : 'exercises'}</p>
    </section>
    ${blocks ? `<p class="hs-sub">Tap a set to correct it.</p><ul class="hs-sessions">${blocks}</ul>`
      : '<p class="hint">No sets were logged.</p>'}`;
}

function renderBack(title, { editId = null } = {}) {
  return `
    <header class="sheet-head">
      <h2>${escapeHTML(title)}</h2>
      <div class="sheet-head-actions">
        ${editId ? `<button class="btn-link" data-act="hs-edit-exercise" data-id="${editId}">Edit</button>` : ''}
        <button class="btn-link" data-act="hs-back">Back</button>
      </div>
    </header>`;
}

/* ---------- render ---------- */

export function render() {
  if (!root || !state.data) return;
  const view = top();
  let html;
  if (state.exDraft) html = exeditor.render(state.exDraft);
  else if (view.view === 'exercise') html = renderExercise(view.id);
  else if (view.view === 'session') html = renderSession(view.id);
  else html = `${renderWeeklyChart()}${renderExerciseList()}`;
  root.innerHTML = html;

  if (view.view === 'root' && state.query) {
    const search = root.querySelector('#hsSearch');
    search?.focus();
    search?.setSelectionRange(search.value.length, search.value.length);
  }
}

function push(entry) {
  state.stack.push(entry);
  state.inspectSession = null;
  state.setEdit = null;
  window.scrollTo(0, 0);
}

/* ---------- events ---------- */

async function onClick(event) {
  const hit = event.target.closest('[data-week], [data-session]');
  if (hit?.dataset.week) {
    const week = Number(hit.dataset.week);
    state.inspectWeek = state.inspectWeek === week ? null : week;
    return render();
  }
  if (hit?.dataset.session) {
    state.inspectSession = hit.dataset.session;
    return render();
  }

  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;

  if (state.exDraft) {
    const outcome = await exeditor.handle(trigger.dataset.act, trigger, state.exDraft, root);
    if (outcome === 'changed') return render();
    if (outcome) {
      state.exDraft = null;
      if (outcome === 'deleted' && state.stack.length > 1) state.stack.pop();
      await load();
      return render();
    }
  }

  switch (trigger.dataset.act) {
    case 'hs-edit-exercise': {
      const exercise = state.data.exercisesById.get(trigger.dataset.id);
      if (!exercise) return;
      state.exDraft = await exeditor.draftFor(exercise);
      window.scrollTo(0, 0);
      return render();
    }

    case 'hs-edit-set': {
      const set = state.data.sets.find((s) => s.id === trigger.dataset.id);
      if (!set) return;
      if (state.setEdit?.id === set.id) {
        state.setEdit = null;
        return render();
      }
      const exercise = state.data.exercisesById.get(set.exercise_id);
      state.setEdit = {
        id: set.id,
        confirmDelete: false,
        draft: {
          weight: set.weight, reps: set.reps, seconds: set.seconds, rpe: set.rpe,
          failed: set.failed ? 1 : 0, is_warmup: set.is_warmup ? 1 : 0,
          tracksTime: exercise?.tracks === 'time',
        },
      };
      return render();
    }

    case 'hs-set-cancel':
      state.setEdit = null;
      return render();

    case 'hs-set-save': {
      readSetEditor();
      const set = state.data.sets.find((s) => s.id === state.setEdit?.id);
      if (!set) return;
      const d = state.setEdit.draft;
      const changes = {
        weight: d.tracksTime ? null : d.weight,
        reps: d.tracksTime ? null : d.reps,
        seconds: d.tracksTime ? d.seconds : null,
        rpe: d.failed ? null : d.rpe,
        failed: d.failed,
        is_warmup: d.is_warmup,
      };
      // A set that's now a warmup or a miss can't still be a record.
      if (d.failed || d.is_warmup) changes.is_pr = 0;
      await store.updateSet(set, changes);
      state.setEdit = null;
      await load();
      return render();
    }

    case 'hs-set-delete':
      readSetEditor();
      state.setEdit.confirmDelete = true;
      return render();

    case 'hs-set-keep':
      state.setEdit.confirmDelete = false;
      return render();

    case 'hs-set-delete-confirm': {
      const set = state.data.sets.find((s) => s.id === state.setEdit?.id);
      if (set) await store.deleteSet(set);
      state.setEdit = null;
      await load();
      return render();
    }

    case 'hs-exercise':
      state.placeFilter = null;
      state.metric = null;
      push({ view: 'exercise', id: trigger.dataset.id });
      return render();
    case 'hs-session':
      push({ view: 'session', id: trigger.dataset.id });
      return render();
    case 'hs-back':
      state.setEdit = null;
      if (state.stack.length > 1) state.stack.pop();
      state.inspectSession = null;
      return render();
    case 'hs-place':
      state.placeFilter = trigger.dataset.place || null;
      state.inspectSession = null;
      return render();
    case 'hs-range':
      state.range = trigger.dataset.range;
      return render();
    case 'hs-metric':
      state.metric = trigger.dataset.metric;
      return render();
  }
}

function onInput(event) {
  if (event.target.id === 'hsSearch') {
    state.query = event.target.value;
    render();
  }
}

/* ---------- lifecycle ---------- */

export async function mount(element) {
  root = element;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  await load();
  render();
}

/* Called when the tab is shown and after a sync: re-derive everything. */
export async function reload() {
  if (!root) return;
  await load();
  render();
}

/* Jump straight to one session, e.g. from Recent sessions on the Train tab. */
export async function openSession(workoutId) {
  await load();
  state.stack = [{ view: 'root' }, { view: 'session', id: workoutId }];
  render();
}
