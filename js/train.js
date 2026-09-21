/* Train view: start a session, add exercises, log sets with RPE.
   Optimised for the thing you actually do — standing up, one thumb, thirty
   seconds into a rest period. */

import * as store from './store.js';
import * as rest from './rest.js';
import { shouldConfirmWeight } from './rules.js';

const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

let root = null;
let tickTimer = null;
let noteSaveTimer = null;

const state = {
  workout: null,
  place: null,
  places: [],
  sets: [],
  exercises: [],
  usage: new Map(),
  sheet: null,      // null | {type:'picker'|'log'|'place', ...}
  confirmFinish: false,
  recent: [],
  rest: { endsAt: null, duration: rest.DEFAULT_REST },
  restDone: false,  // fired this cycle, so we only alert once
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
  const grade = set.failed ? ' F' : (set.rpe != null ? ` @ ${set.rpe}` : '');

  if (exercise?.tracks === 'time') {
    return `${formatDuration(set.seconds || 0)}${grade}`;
  }
  if (exercise?.tracks === 'bodyweight_reps') {
    const added = set.weight ? `BW+${formatWeight(set.weight)}` : 'BW';
    return `${added} × ${set.reps ?? 0}${grade}`;
  }
  return `${formatWeight(set.weight ?? 0)} × ${set.reps ?? 0}${grade}`;
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
  state.places = await store.listPlaces();
  state.usage = await store.exerciseUsage();
  state.sets = state.workout ? await store.setsForWorkout(state.workout.id) : [];
  state.recent = state.workout ? [] : await store.recentWorkouts(10);
  state.rest = await rest.load();
  state.place = state.workout?.place_id
    ? state.places.find((p) => p.id === state.workout.place_id) || null
    : null;
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
    const rows = sets.map((set) => `
      <li class="set-row${set.is_dropset ? ' is-drop' : ''}">
        <span class="set-n">${set.is_dropset ? '↳' : set.set_index}</span>
        <span class="set-desc">${escapeHTML(describeSet(set, exercise))}</span>
        ${set.failed ? '<span class="tag tag-fail">fail</span>' : ''}
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
      <button class="place-pick" data-act="place">
        ${state.place ? escapeHTML(state.place.name) : 'Set location'}
      </button>
    </div>
    ${blocks || '<p class="hint center">Nothing logged yet. Add an exercise to begin.</p>'}
    <button class="btn btn-block" data-act="pick">+ Add exercise</button>
    ${finishArea}
  `;
}

function renderPlaceSheet() {
  const rows = state.places.map((place) => `
    <li>
      <button class="pick-row ${state.workout?.place_id === place.id ? 'is-on' : ''}"
              data-act="choose-place" data-place="${place.id}">
        <span class="pick-name">${escapeHTML(place.name)}</span>
        ${state.workout?.place_id === place.id ? '<span class="pick-group">current</span>' : ''}
      </button>
    </li>`).join('');

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>Where are you training?</h2>
        <button class="btn-link" data-act="close">Done</button>
      </header>
      <p class="hint">Notes you write are shown back to you the next time you do
         that exercise here.</p>
      <ul class="pick-list">${rows}</ul>
      <input class="search" id="newPlace" type="text" autocomplete="off"
             autocapitalize="words" placeholder="Add another location">
      <button class="btn btn-quiet btn-block" data-act="create-place">Add location</button>
    </div>`;
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

function renderRestBar() {
  const left = rest.remaining(state.rest.endsAt);

  if (left === null) {
    return `
      <div class="rest-bar">
        <span class="rest-label">Rest</span>
        <div class="rest-presets">
          ${rest.PRESETS.map((s) => `
            <button class="chip" data-act="rest-start" data-secs="${s}">
              ${rest.format(s)}
            </button>`).join('')}
        </div>
      </div>`;
  }

  return `
    <div class="rest-bar ${left === 0 ? 'is-done' : 'is-running'}">
      <span class="rest-clock" id="restClock">${rest.format(left)}</span>
      <span class="rest-label">${left === 0 ? 'Rest is up' : 'resting'}</span>
      <button class="btn-link" data-act="rest-stop">${left === 0 ? 'Clear' : 'Skip'}</button>
    </div>`;
}

function renderLogSheet() {
  const exercise = exerciseById(state.sheet.exerciseId);
  if (!exercise) return '';

  const draft = state.sheet.draft;
  const isTime = exercise.tracks === 'time';
  const isBodyweight = exercise.tracks === 'bodyweight_reps';

  const logged = state.sets.filter((s) => s.exercise_id === exercise.id);
  const loggedRows = logged.map((set) => `
    <li class="set-row${set.is_dropset ? ' is-drop' : ''}">
      <span class="set-n">${set.is_dropset ? '↳' : set.set_index}</span>
      <span class="set-desc">${escapeHTML(describeSet(set, exercise))}</span>
      <button class="set-del" data-act="del-set" data-set="${set.id}" aria-label="Delete set">×</button>
    </li>`).join('');

  const lastLine = state.sheet.last
    ? `Last time: ${escapeHTML(describeSet(state.sheet.last, exercise))}`
    : 'First time logging this one.';

  const prior = state.sheet.priorNote;
  const priorNote = prior ? `
    <div class="prior-note">
      <div class="prior-head">
        <span>Note from ${escapeHTML(formatDate(prior.workout.started_at))}</span>
        <span class="prior-where ${prior.sameLocation ? 'same' : 'other'}">
          ${prior.place
            ? escapeHTML(prior.place.name) + (prior.sameLocation ? '' : ' — different gym')
            : 'no location set'}
        </span>
      </div>
      <p>${escapeHTML(prior.note.body)}</p>
    </div>` : '';

  const rpeChips = (values) => values.map((value) => `
    <button class="chip ${draft.rpe === value && !draft.failed ? 'is-on' : ''}"
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

  const canDrop = logged.length > 0 && !isTime;

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>${escapeHTML(exercise.name)}</h2>
        <button class="btn-link" data-act="close">Done</button>
      </header>

      ${renderRestBar()}
      ${priorNote}
      <p class="last-line">${lastLine}</p>

      ${weightField}
      ${repsField}

      <div class="field">
        <label>RPE <span class="optional">tap again to clear</span></label>
        <div class="chips">${rpeChips(RPE_VALUES.slice(0, 5))}</div>
        <div class="chips">
          ${rpeChips(RPE_VALUES.slice(5))}
          <button class="chip fail ${draft.failed ? 'is-on' : ''}"
                  data-act="fail" title="Failed set">F</button>
        </div>
      </div>

      <label class="warmup">
        <input type="checkbox" data-act="warmup" ${draft.is_warmup ? 'checked' : ''}>
        <span>Warmup set</span>
      </label>

      ${state.sheet.pendingConfirm ? `
        <div class="weight-confirm">
          <p class="weight-confirm-lead">
            <strong>${formatWeight(state.sheet.pendingConfirm.weight)} lbs</strong>
            — that's ${state.sheet.pendingConfirm.percent}% over your last working
            set of ${formatWeight(state.sheet.pendingConfirm.previous)}.
          </p>
          <div class="confirm-actions">
            <button class="btn btn-quiet" data-act="cancel-log">Back</button>
            <button class="btn btn-danger" data-act="confirm-log">
              Log ${formatWeight(state.sheet.pendingConfirm.weight)}
            </button>
          </div>
        </div>` : `
        <div class="log-actions">
          <button class="btn btn-log" data-act="log-set">Log set</button>
          <button class="btn btn-quiet btn-drop" data-act="drop-set" ${canDrop ? '' : 'disabled'}>
            + Drop
          </button>
        </div>`}

      <div class="field notes-field">
        <label for="fNote">Notes for this exercise today</label>
        <textarea id="fNote" class="note-input" rows="3"
                  placeholder="e.g. way too light, go up 10 next time"
                  >${escapeHTML(state.sheet.note || '')}</textarea>
      </div>

      ${logged.length ? `
        <h3 class="section-label">This session</h3>
        <ul class="set-list">${loggedRows}</ul>` : ''}
    </div>`;
}

export function render() {
  if (!root) return;

  let html;
  if (state.sheet?.type === 'picker') html = renderPicker();
  else if (state.sheet?.type === 'place') html = renderPlaceSheet();
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

/* One interval drives both the session clock and the rest countdown, updating
   text in place so a re-render never steals focus from an input. */
function startClock() {
  clearInterval(tickTimer);
  tickTimer = null;
  if (!state.workout) return;

  tickTimer = setInterval(tick, 1000);
}

function tick() {
  const clock = root.querySelector('#sessionClock');
  if (clock && state.workout) {
    clock.textContent = formatElapsed(state.workout.started_at);
  }

  if (!state.rest.endsAt) return;

  const left = rest.remaining(state.rest.endsAt);
  const restClock = root.querySelector('#restClock');
  if (restClock) restClock.textContent = rest.format(left);

  if (left === 0 && !state.restDone) {
    state.restDone = true;
    rest.fireAlert();
    render();  // swap the bar into its "Rest is up" state
  }
}

/* iOS freezes timers while the app is backgrounded, so the deadline may well
   have passed by the time we're looked at again. */
function onVisible() {
  if (document.visibilityState !== 'visible') return;
  if (!state.rest.endsAt) return;

  const left = rest.remaining(state.rest.endsAt);
  if (left === 0 && !state.restDone) {
    state.restDone = true;
    rest.fireAlert();
  }
  render();
}

/* ---------- draft handling ---------- */

async function openLogSheet(exerciseId) {
  const exercise = exerciseById(exerciseId);
  const last = await store.lastSetFor(exerciseId);
  const reference = await store.lastWorkSetFor(exerciseId);
  const note = await store.getNote(state.workout.id, exerciseId);
  const priorNote = await store.lastNoteFor(exerciseId, {
    placeId: state.workout.place_id,
    excludeWorkoutId: state.workout.id,
  });

  state.sheet = {
    type: 'log',
    exerciseId,
    last,
    reference,
    pendingConfirm: null,
    priorNote,
    note: note?.body || '',
    draft: {
      weight: last?.weight ?? (exercise?.tracks === 'bodyweight_reps' ? 0 : 45),
      reps: last?.reps ?? (exercise?.tracks === 'time' ? null : 8),
      seconds: last?.seconds ?? (exercise?.tracks === 'time' ? 30 : null),
      rpe: last?.rpe ?? null,
      failed: 0,
      is_warmup: 0,
    },
  };
  render();
}

/* Pull every field back out of the DOM before a re-render throws it away. */
function readSheetInputs() {
  if (state.sheet?.type !== 'log') return;

  for (const input of root.querySelectorAll('input[data-field]')) {
    const raw = input.value.trim();
    const value = raw === '' ? null : Number(raw);
    state.sheet.draft[input.dataset.field] = Number.isFinite(value) ? value : null;
  }

  const note = root.querySelector('#fNote');
  if (note) state.sheet.note = note.value;
}

function queueNoteSave() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(saveNoteNow, 600);
}

async function saveNoteNow() {
  clearTimeout(noteSaveTimer);
  if (state.sheet?.type !== 'log' || !state.workout) return;
  await store.saveNote({
    workout_id: state.workout.id,
    exercise_id: state.sheet.exerciseId,
    body: state.sheet.note || '',
  });
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

  // Never re-render on note input; it would drop the caret mid-sentence.
  if (target.id === 'fNote') {
    state.sheet.note = target.value;
    queueNoteSave();
    return;
  }

  if (target.dataset.field) {
    if (state.sheet?.type === 'log') state.sheet.pendingConfirm = null;
    const raw = target.value.trim();
    const value = raw === '' ? null : Number(raw);
    state.sheet.draft[target.dataset.field] = Number.isFinite(value) ? value : null;
    const note = root.querySelector('.field-note');
    if (note) note.textContent = formatDuration(state.sheet.draft.seconds || 0);
  }
}

async function logCurrent({ isDrop, confirmed = false }) {
  readSheetInputs();
  const { draft, exerciseId } = state.sheet;
  const exercise = exerciseById(exerciseId);

  // Guard against logging an empty set by accident.
  if (exercise.tracks === 'time' ? !draft.seconds : !draft.reps) return;

  // An unusually large jump gets a second look before it reaches the log.
  if (!confirmed) {
    const jump = shouldConfirmWeight(
      { weight: draft.weight, isWarmup: draft.is_warmup, isDrop },
      state.sheet.reference,
      exercise,
    );
    if (jump) {
      state.sheet.pendingConfirm = { ...jump, isDrop };
      return render();
    }
  }
  state.sheet.pendingConfirm = null;

  await store.addSet({
    workout_id: state.workout.id,
    exercise_id: exerciseId,
    weight: exercise.tracks === 'time' ? null : draft.weight,
    reps: exercise.tracks === 'time' ? null : draft.reps,
    seconds: exercise.tracks === 'time' ? draft.seconds : null,
    rpe: draft.rpe,
    failed: draft.failed,
    is_warmup: draft.is_warmup,
    is_dropset: isDrop,
  });

  await saveNoteNow();
  state.sets = await store.setsForWorkout(state.workout.id);
  state.sheet.last = await store.lastSetFor(exerciseId);
  state.sheet.reference = await store.lastWorkSetFor(exerciseId);
  state.sheet.draft.is_warmup = 0;
  state.sheet.draft.failed = 0;

  if (isDrop) {
    // Drops run back to back, so no rest and a lighter starting point.
    const dropped = Math.max(0, Math.round(((draft.weight ?? 0) * 0.8) / 5) * 5);
    state.sheet.draft.weight = dropped;
  } else {
    await startRest(state.rest.duration);
  }

  render();
}

async function startRest(seconds) {
  rest.unlockAudio();   // we're inside a tap, which is the only time iOS allows it
  state.rest.endsAt = await rest.start(seconds);
  state.rest.duration = seconds;
  state.restDone = false;
}

async function onClick(event) {
  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;

  const { act } = trigger.dataset;

  // Any action that can change the draft invalidates a pending confirmation,
  // so the panel can never end up confirming a number that's been edited.
  if (state.sheet?.type === 'log' && act !== 'confirm-log' && act !== 'cancel-log') {
    state.sheet.pendingConfirm = null;
  }

  switch (act) {
    case 'start':
      state.workout = await store.startWorkout();
      await refresh();
      state.sheet = { type: 'picker', query: '' };
      return render();

    case 'pick':
      state.sheet = { type: 'picker', query: '' };
      return render();

    case 'place':
      state.sheet = { type: 'place' };
      return render();

    case 'choose-place':
      state.workout = await store.setWorkoutPlace(state.workout, trigger.dataset.place);
      await refresh();
      state.sheet = null;
      return render();

    case 'create-place': {
      const input = root.querySelector('#newPlace');
      const name = input?.value.trim();
      if (!name) return;
      const place = await store.createPlace(name);
      state.workout = await store.setWorkoutPlace(state.workout, place.id);
      await refresh();
      state.sheet = null;
      return render();
    }

    case 'close':
      if (state.sheet?.type === 'log') {
        readSheetInputs();
        await saveNoteNow();
      }
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
      readSheetInputs();
      const field = trigger.dataset.field;
      const by = Number(trigger.dataset.by);
      const current = state.sheet.draft[field] ?? 0;
      state.sheet.draft[field] = Math.max(0, current + by);
      return render();
    }

    case 'rpe': {
      readSheetInputs();
      const value = Number(trigger.dataset.rpe);
      const draft = state.sheet.draft;
      // Tapping the selected value again clears it, so there's no "none" chip.
      draft.rpe = (draft.rpe === value && !draft.failed) ? null : value;
      draft.failed = 0;
      return render();
    }

    case 'fail': {
      readSheetInputs();
      const draft = state.sheet.draft;
      draft.failed = draft.failed ? 0 : 1;
      if (draft.failed) draft.rpe = null;   // a failed set has no RPE
      return render();
    }

    case 'warmup':
      state.sheet.draft.is_warmup = trigger.checked ? 1 : 0;
      return;

    case 'log-set':
      return logCurrent({ isDrop: false });

    case 'confirm-log':
      return logCurrent({ isDrop: state.sheet.pendingConfirm?.isDrop ?? false, confirmed: true });

    case 'cancel-log':
      state.sheet.pendingConfirm = null;
      return render();

    case 'drop-set':
      return logCurrent({ isDrop: true });

    case 'rest-start':
      await startRest(Number(trigger.dataset.secs));
      return render();

    case 'rest-stop':
      await rest.stop();
      state.rest.endsAt = null;
      state.restDone = false;
      return render();

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
      await rest.stop();
      state.rest.endsAt = null;
      state.confirmFinish = false;
      state.sheet = null;
      await refresh();
      return render();

    case 'discard':
      await store.discardWorkout(state.workout);
      await rest.stop();
      state.rest.endsAt = null;
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
  document.addEventListener('visibilitychange', onVisible);
  await store.init();
  await refresh();
  render();
}
