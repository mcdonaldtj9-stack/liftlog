/* History view: what you've done, and whether you're getting stronger.

   Three screens, navigated as a small stack:
     root      weekly sets by region, then every exercise you've trained
     exercise  last session first (it's what you check between sets), then
               strength over time, rep maxes, and every session with its note
     session   one workout in full — reached from Recent sessions on Train */

import * as store from './store.js';
import {
  REGIONS, OTHER_REGION, filterByPlace, weeklySets, e1rmPerSession, bestByReps,
  meaningfulRepMaxes, e1rmChange, sessionsForExercise, exerciseSummaries,
  placesForExercise, isWorkingSet,
} from './history.js';
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
  inspectWeek: null,
  inspectSession: null,
};

const top = () => state.stack[state.stack.length - 1];

/* ---------- data ---------- */

async function load() {
  const [sets, workouts, notes, exercises, places, templates] = await Promise.all([
    store.allSets(), store.allWorkouts(), store.allNotes(),
    store.listExercises(), store.listPlaces(), store.allTemplates(),
  ]);
  state.data = {
    sets,
    notes,
    workoutsById: new Map(workouts.map((w) => [w.id, w])),
    exercisesById: new Map(exercises.map((e) => [e.id, e])),
    exercises,
    places,
    templatesById: new Map(templates.map((t) => [t.id, t])),
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

function setChips(sets, exercise) {
  return sets.map((set) => {
    const cls = set.failed ? 'is-fail' : set.is_warmup ? 'is-warm' : set.is_dropset ? 'is-drop' : '';
    return `<span class="hs-set ${cls}">${escapeHTML(compactSet(set, exercise))}</span>`;
  }).join('');
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
      <p class="hs-sub">By primary muscle — a bench press counts as chest only.
         This week is still in progress.</p>
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

  const rows = muscles.map((m) => `
    <tr><th scope="row">${escapeHTML(m)}</th>
        <td>${now.byMuscle.get(m) || '—'}</td>
        <td>${prev.byMuscle.get(m) || '—'}</td></tr>`).join('');

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

function renderStrengthChart(points, prPoint) {
  const range = RANGES.find((r) => r.key === state.range);
  const now = Date.now();
  const shown = range.days ? points.filter((p) => p.t >= now - range.days * DAY) : points;
  if (shown.length < 2) {
    return `<p class="hint">${shown.length
      ? 'One qualifying session so far — the chart starts at two.'
      : 'No qualifying sets in this range.'}</p>`;
  }

  const width = Math.max(280, root?.clientWidth || 360);
  const height = 180;
  const pad = { top: 12, right: 14, bottom: 24, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const start = shown[0].t;
  const end = Math.max(shown[shown.length - 1].t, start + DAY);
  const { lo, hi, step } = tightDomain(shown.map((p) => p.e1rm), { air: 3 });
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
    <svg class="hs-chart" id="hsStrength" width="${width}" height="${height}"
         viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Estimated one-rep max per session; every session is listed below">
      ${yGrid({ lo, hi, step, y, left: pad.left, right: width - pad.right })}
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

  let strength = '';
  if (isWeighted) {
    const points = e1rmPerSession(sets, workoutsById);
    const prPoint = points.length ? points.reduce((a, b) => (b.e1rm > a.e1rm ? b : a)) : null;
    const change = e1rmChange(points, { days: 84 });
    const reps = meaningfulRepMaxes(bestByReps(sets));

    const changeText = change && change.days >= 14
      ? (Math.abs(change.change) < 2 ? 'holding steady' : `${change.change > 0 ? '↑' : '↓'} ${Math.round(Math.abs(change.change))} over ${Math.round(change.days / 7)} weeks`)
      : '';

    const repRows = [...reps.entries()].map(([n, set]) => `
      <li><span class="hs-rm">${n}RM</span><strong>${w(set.weight)}</strong>
          <span class="hs-when">${escapeHTML(shortDate(new Date(set.created_at).getTime()))}</span></li>`).join('');

    strength = `
      <section class="hs-card">
        <p class="hs-kicker">Estimated 1RM</p>
        <p class="hs-hero">${prPoint ? Math.round(prPoint.e1rm) : '—'}<span> lbs best</span></p>
        ${changeText ? `<p class="hs-change">${escapeHTML(changeText)}</p>` : ''}
        <div class="hs-filter hs-range">
          ${RANGES.map((r) => `<button class="chip ${state.range === r.key ? 'is-on' : ''}"
            data-act="hs-range" data-range="${r.key}">${r.label}</button>`).join('')}
        </div>
        <p class="hs-readout">${renderSessionReadout(points, exercise)}</p>
        ${renderStrengthChart(points, prPoint)}
        <p class="hs-sub">From sets of up to 12 reps counting RPE; warmups, drops
           and F sets are left out. The ringed point is your best.</p>
        ${repRows ? `<h3 class="section-label">Rep maxes</h3><ul class="hs-rms">${repRows}</ul>` : ''}
      </section>`;
  }

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
    ${renderBack(exercise.name)}
    ${filter}
    ${latestCard}
    ${strength}
    ${older ? `<h3 class="section-label">Earlier sessions</h3><ul class="hs-sessions">${older}</ul>` : ''}`;
}

function renderSessionReadout(points, exercise) {
  const point = points.find((p) => p.workoutId === state.inspectSession);
  if (!point) return 'Tap a point to see that session.';
  return `<strong>${escapeHTML(longDate(point.t))}</strong> · e1RM <strong>${Math.round(point.e1rm)}</strong>
    · from ${escapeHTML(compactSet(point.set, exercise))}`;
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
        <div class="hs-sets">${setChips(sets.filter((s) => s.exercise_id === exerciseId), exercise)}</div>
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
    ${blocks ? `<ul class="hs-sessions">${blocks}</ul>` : '<p class="hint">No sets were logged.</p>'}`;
}

function renderBack(title) {
  return `
    <header class="sheet-head">
      <h2>${escapeHTML(title)}</h2>
      <button class="btn-link" data-act="hs-back">Back</button>
    </header>`;
}

/* ---------- render ---------- */

export function render() {
  if (!root || !state.data) return;
  const view = top();
  let html;
  if (view.view === 'exercise') html = renderExercise(view.id);
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

  switch (trigger.dataset.act) {
    case 'hs-exercise':
      state.placeFilter = null;
      push({ view: 'exercise', id: trigger.dataset.id });
      return render();
    case 'hs-session':
      push({ view: 'session', id: trigger.dataset.id });
      return render();
    case 'hs-back':
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
