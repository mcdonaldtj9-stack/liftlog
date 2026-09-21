/* Train view: start a session, add exercises, log sets with RPE.
   Optimised for the thing you actually do — standing up, one thumb, thirty
   seconds into a rest period. */

import * as store from './store.js';

const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

let root = null;
let tickTimer = null;

const state = {
  workout: null,
  sets: [],
  exercises: [],
  usage: new Map(),
  sheet: null,      // null | {type:'picker', query} | {type:'log', exerciseId, draft}
  confirmFinish: false,
  recent: [],
};

/* ---------- helpers ---------- */

const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

const exerciseById = (id) => state.exercises.find((e) => e.id === id) || null;

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatElapsed(startedAt) {
  return formatDuration((Date.now() - new Date(startedAt).getTime()) / 1000);
}

function formatWeight(value) {
  if (value == null) return '';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/* One line summarising a set, e.g. "185 × 8 @ 8.5" or "BW+25 × 6". */
function describeSet(set, exercise) {
  const rpe = set.rpe != null ? ` @ ${set.rpe}` : '';

  if (exercise?.tracks === 'time') {
    return `${formatDuration(set.seconds || 0)}${rpe}`;
  }
  if (exercise?.tracks === 'bodyweight_reps') {
    const added = set.weight ? `BW+${formatWeight(set.weight)}` : 'BW';
    return `${added} × ${set.reps ?? 0}${rpe}`;
  }
  return `${formatWeight(set.weight ?? 0)} × ${set.reps ?? 0}${rpe}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/* ---------- data loading ---------- */

async function refresh() {
  state.workout = await store.getActiveWorkout();
  state.exercises = await store.listExercises();
  state.usage = await store.exerciseUsage();
  state.sets = state.workout ? await store.setsForWorkout(state.workout.id) : [];
  state.recent = state.workout ? [] : await store.recentWorkouts(10);
}

/* ---------- rendering ---------- */

function renderIdle() {
  const recent = state.recent.map((workout) => `
    <li class="row">
      <span class="row-main">${escapeHTML(formatDate(workout.started_at))}</span>
      <span class="row-sub">${workout.ended_at
        ? formatDuration((new Date(workout.ended_at) - new Date(workout.started_at)) / 1000)
        : ''}</span>
    </li>`).join('');

  return `
    <button class="btn btn-block" data-act="start">Start workout</button>
    ${state.recent.length ? `
      <h3 class="section-label">Recent sessions</h3>
      <ul class="card-list">${recent}</ul>` : `
      <p class="hint center">No sessions yet. Tap start and add your first exercise.</p>`}
  `;
}

function renderActive() {
  // Group this session's sets by exercise, in the order each first appeared.
  const order = [];
  const byExercise = new Map();
  for (const set of state.sets) {
    if (!byExercise.has(set.exercise_id)) {
      byExercise.set(set.exercise_id, []);
      order.push(set.exercise_id);
    }
    byExercise.get(set.exercise_id).push(set);
  }

  const blocks = order.map((exerciseId) => {
    const exercise = exerciseById(exerciseId);
    const sets = byExercise.get(exerciseId);
    const rows = sets.map((set, i) => `
      <li class="set-row">
        <span class="set-n">${i + 1}</span>
        <span class="set-desc">${escapeHTML(describeSet(set, exercise))}</span>
        ${set.is_warmup ? '<span class="tag">warmup</span>' : ''}
      </li>`).join('');

    return `
      <section class="ex-block">
        <header class="ex-head">
          <h3>${escapeHTML(exercise?.name || 'Unknown exercise')}</h3>
          <span class="ex-count">${sets.length} ${sets.length === 1 ? 'set' : 'sets'}</span>
        </header>
        <ul class="set-list">${rows}</ul>
        <button class="btn btn-quiet btn-block" data-act="log" data-ex="${exerciseId}">
          Add set
        </button>
      </section>`;
  }).join('');

  const finishArea = state.confirmFinish ? `
    <div class="confirm">
      <p>Finish this session?</p>
      <div class="confirm-actions">
        <button class="btn btn-quiet" data-act="cancel-finish">Keep going</button>
        <button class="btn" data-act="confirm-finish">Finish</button>
      </div>
      <button class="btn-link danger" data-act="discard">Discard session</button>
    </div>` : `
    <button class="btn btn-quiet btn-block" data-act="finish">Finish session</button>`;

  return `
    <div class="session-bar">
      <span class="session-clock" id="sessionClock">${formatElapsed(state.workout.started_at)}</span>
      <span class="session-meta">${state.sets.length} ${state.sets.length === 1 ? 'set' : 'sets'} logged</span>
    </div>
    ${blocks || '<p class="hint center">Nothing logged yet. Add an exercise to begin.</p>'}
    <button class="btn btn-block" data-act="pick">+ Add exercise</button>
    ${finishArea}
  `;
}

function renderPicker() {
  const query = state.sheet.query || '';
  const key = store.nameKey(query);

  const matches = state.exercises
    .filter((e) => !query || e.name_key.includes(key))
    .sort((a, b) => {
      const ua = state.usage.get(a.id) || '';
      const ub = state.usage.get(b.id) || '';
      if (ua !== ub) return ub.localeCompare(ua); // most recently used first
      return a.name.localeCompare(b.name);
    })
    .slice(0, 60);

  const exact = state.exercises.some((e) => e.name_key === key);

  const rows = matches.map((e) => `
    <li>
      <button class="pick-row" data-act="choose" data-ex="${e.id}">
        <span class="pick-name">${escapeHTML(e.name)}</span>
        <span class="pick-group">${escapeHTML(e.muscle_group)}</span>
      </button>
    </li>`).join('');

  const createRow = query.trim() && !exact ? `
    <li>
      <button class="pick-row create" data-act="create">
        <span class="pick-name">+ Create “${escapeHTML(query.trim())}”</span>
        <span class="pick-group">new</span>
      </button>
    </li>` : '';

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>Add exercise</h2>
        <button class="btn-link" data-act="close">Cancel</button>
      </header>
      <input class="search" id="exerciseSearch" type="text" autocomplete="off"
             autocapitalize="words" placeholder="Search or type a new name"
             value="${escapeHTML(query)}">
      <ul class="pick-list">
        ${createRow}
        ${rows || (query ? '' : '<li class="hint center">No exercises yet.</li>')}
      </ul>
    </div>`;
}

function renderLogSheet() {
  const exercise = exerciseById(state.sheet.exerciseId);
  if (!exercise) return '';

  const draft = state.sheet.draft;
  const isTime = exercise.tracks === 'time';
  const isBodyweight = exercise.tracks === 'bodyweight_reps';

  const logged = state.sets.filter((s) => s.exercise_id === exercise.id);
  const loggedRows = logged.map((set, i) => `
    <li class="set-row">
      <span class="set-n">${i + 1}</span>
      <span class="set-desc">${escapeHTML(describeSet(set, exercise))}</span>
      <button class="set-del" data-act="del-set" data-set="${set.id}" aria-label="Delete set">×</button>
    </li>`).join('');

  const lastLine = state.sheet.last
    ? `Last time: ${escapeHTML(describeSet(state.sheet.last, exercise))}`
    : 'First time logging this one.';

  const rpeChips = (values) => values.map((value) => `
    <button class="chip ${draft.rpe === value ? 'is-on' : ''}"
            data-act="rpe" data-rpe="${value}">${value}</button>`).join('');

  const weightField = isTime ? '' : `
    <div class="field">
      <label for="fWeight">${isBodyweight ? 'Added weight (lbs)' : 'Weight (lbs)'}</label>
      <div class="stepper">
        <button class="step" data-act="bump" data-field="weight" data-by="-5">−</button>
        <input id="fWeight" class="num" type="text" inputmode="decimal"
               data-field="weight" value="${formatWeight(draft.weight)}">
        <button class="step" data-act="bump" data-field="weight" data-by="5">+</button>
      </div>
    </div>`;

  const repsField = isTime ? `
    <div class="field">
      <label for="fSeconds">Duration (seconds)</label>
      <div class="stepper">
        <button class="step" data-act="bump" data-field="seconds" data-by="-15">−</button>
        <input id="fSeconds" class="num" type="text" inputmode="numeric"
               data-field="seconds" value="${draft.seconds ?? ''}">
        <button class="step" data-act="bump" data-field="seconds" data-by="15">+</button>
      </div>
      <p class="field-note">${formatDuration(draft.seconds || 0)}</p>
    </div>` : `
    <div class="field">
      <label for="fReps">Reps</label>
      <div class="stepper">
        <button class="step" data-act="bump" data-field="reps" data-by="-1">−</button>
        <input id="fReps" class="num" type="text" inputmode="numeric"
               data-field="reps" value="${draft.reps ?? ''}">
        <button class="step" data-act="bump" data-field="reps" data-by="1">+</button>
      </div>
    </div>`;

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>${escapeHTML(exercise.name)}</h2>
        <button class="btn-link" data-act="close">Done</button>
      </header>
      <p class="last-line">${lastLine}</p>

      ${weightField}
      ${repsField}

      <div class="field">
        <label>RPE <span class="optional">optional</span></label>
        <div class="chips">${rpeChips(RPE_VALUES.slice(0, 5))}</div>
        <div class="chips">
          ${rpeChips(RPE_VALUES.slice(5))}
          <button class="chip ${draft.rpe == null ? 'is-on' : ''}" data-act="rpe" data-rpe="">—</button>
        </div>
      </div>

      <label class="warmup">
        <input type="checkbox" data-act="warmup" ${draft.is_warmup ? 'checked' : ''}>
        <span>Warmup set</span>
      </label>

      <button class="btn btn-block btn-log" data-act="log-set">Log set</button>

      ${logged.length ? `
        <h3 class="section-label">This session</h3>
        <ul class="set-list">${loggedRows}</ul>` : ''}
    </div>`;
}

export function render() {
  if (!root) return;

  let html;
  if (state.sheet?.type === 'picker') html = renderPicker();
  else if (state.sheet?.type === 'log') html = renderLogSheet();
  else if (state.workout) html = renderActive();
  else html = renderIdle();

  root.innerHTML = html;

  // Lets the shell know not to reload out from under a half-entered set.
  document.body.classList.toggle('sheet-open', Boolean(state.sheet));

  // Keep the search field focused and the caret at the end while typing.
  if (state.sheet?.type === 'picker') {
    const search = root.querySelector('#exerciseSearch');
    if (search && state.sheet.focus !== false) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  startClock();
}

function startClock() {
  clearInterval(tickTimer);
  tickTimer = null;
  if (!state.workout || state.sheet) return;

  tickTimer = setInterval(() => {
    const clock = root.querySelector('#sessionClock');
    if (!clock || !state.workout) return clearInterval(tickTimer);
    clock.textContent = formatElapsed(state.workout.started_at);
  }, 1000);
}

/* ---------- draft handling ---------- */

async function openLogSheet(exerciseId) {
  const exercise = exerciseById(exerciseId);
  const last = await store.lastSetFor(exerciseId);

  state.sheet = {
    type: 'log',
    exerciseId,
    last,
    draft: {
      weight: last?.weight ?? (exercise?.tracks === 'bodyweight_reps' ? 0 : 45),
      reps: last?.reps ?? (exercise?.tracks === 'time' ? null : 8),
      seconds: last?.seconds ?? (exercise?.tracks === 'time' ? 30 : null),
      rpe: last?.rpe ?? null,
      is_warmup: 0,
    },
  };
  render();
}

function readDraftFromInputs() {
  if (state.sheet?.type !== 'log') return;
  for (const input of root.querySelectorAll('input[data-field]')) {
    const raw = input.value.trim();
    const value = raw === '' ? null : Number(raw);
    state.sheet.draft[input.dataset.field] = Number.isFinite(value) ? value : null;
  }
}

/* ---------- events ---------- */

function onInput(event) {
  const target = event.target;

  if (target.id === 'exerciseSearch') {
    state.sheet.query = target.value;
    state.sheet.focus = true;
    render();
    return;
  }

  if (target.dataset.field) {
    const raw = target.value.trim();
    const value = raw === '' ? null : Number(raw);
    state.sheet.draft[target.dataset.field] = Number.isFinite(value) ? value : null;
    const note = root.querySelector('.field-note');
    if (note) note.textContent = formatDuration(state.sheet.draft.seconds || 0);
  }
}

async function onClick(event) {
  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;

  const { act } = trigger.dataset;

  switch (act) {
    case 'start':
      state.workout = await store.startWorkout();
      await refresh();
      state.sheet = { type: 'picker', query: '' };
      return render();

    case 'pick':
      state.sheet = { type: 'picker', query: '' };
      return render();

    case 'close':
      state.sheet = null;
      await refresh();
      return render();

    case 'choose':
      return openLogSheet(trigger.dataset.ex);

    case 'create': {
      const name = (state.sheet.query || '').trim();
      if (!name) return;
      const exercise = await store.createExercise({ name });
      state.exercises = await store.listExercises();
      return openLogSheet(exercise.id);
    }

    case 'log':
      return openLogSheet(trigger.dataset.ex);

    case 'bump': {
      readDraftFromInputs();
      const field = trigger.dataset.field;
      const by = Number(trigger.dataset.by);
      const floor = field === 'weight' ? 0 : field === 'seconds' ? 0 : 0;
      const current = state.sheet.draft[field] ?? 0;
      state.sheet.draft[field] = Math.max(floor, current + by);
      return render();
    }

    case 'rpe': {
      readDraftFromInputs();
      const raw = trigger.dataset.rpe;
      state.sheet.draft.rpe = raw === '' ? null : Number(raw);
      return render();
    }

    case 'warmup':
      state.sheet.draft.is_warmup = trigger.checked ? 1 : 0;
      return;

    case 'log-set': {
      readDraftFromInputs();
      const { draft, exerciseId } = state.sheet;
      const exercise = exerciseById(exerciseId);

      // Guard against logging an empty set by accident.
      if (exercise.tracks === 'time' ? !draft.seconds : !draft.reps) return;

      await store.addSet({
        workout_id: state.workout.id,
        exercise_id: exerciseId,
        weight: exercise.tracks === 'time' ? null : draft.weight,
        reps: exercise.tracks === 'time' ? null : draft.reps,
        seconds: exercise.tracks === 'time' ? draft.seconds : null,
        rpe: draft.rpe,
        is_warmup: draft.is_warmup,
      });

      state.sets = await store.setsForWorkout(state.workout.id);
      state.sheet.last = await store.lastSetFor(exerciseId);
      state.sheet.draft.is_warmup = 0;
      return render();
    }

    case 'del-set': {
      const set = state.sets.find((s) => s.id === trigger.dataset.set);
      if (!set) return;
      await store.deleteSet(set);
      state.sets = await store.setsForWorkout(state.workout.id);
      return render();
    }

    case 'finish':
      state.confirmFinish = true;
      return render();

    case 'cancel-finish':
      state.confirmFinish = false;
      return render();

    case 'confirm-finish':
      await store.finishWorkout(state.workout);
      state.confirmFinish = false;
      state.sheet = null;
      await refresh();
      return render();

    case 'discard':
      await store.discardWorkout(state.workout);
      state.confirmFinish = false;
      state.sheet = null;
      await refresh();
      return render();
  }
}

/* ---------- mount ---------- */

export async function mount(element) {
  root = element;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  await store.init();
  await refresh();
  render();
}
