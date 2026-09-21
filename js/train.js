/* Train view: start a session, add exercises, log sets with RPE.
   Optimised for the thing you actually do — standing up, one thumb, thirty
   seconds into a rest period. */

import * as store from './store.js';
import * as rest from './rest.js';
import { checkSet, suggestWeight, DEFAULT_TARGET_RPE } from './rules.js';
import * as geo from './geo.js';

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
  sheet: null,      // null | {type:'picker'|'log'|'place'|'template', ...}
  confirmFinish: false,
  recent: [],
  templates: [],
  template: null,        // the routine this session was started from
  templateDraft: null,   // survives the picker opening on top of the editor
  lastPlaceId: null,
  // Location detection. Kept in memory only: it describes this session on this
  // phone, and is meaningless after a restart.
  placePickedManually: false,  // a tap on the location beats anything GPS says
  placeDetected: false,        // the current location came from GPS
  placeSuggestion: null,       // GPS disagrees with an explicit choice: offer, don't apply
  geoStatus: null,             // readout for the Locations sheet
  geoBusy: null,               // place id being captured, or 'detect'
  targets: new Map(),    // exercise id -> {sets, reps} from the routine
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

/* What the confirm button restates — the whole set, so the second look is at
   the actual numbers rather than at the word "OK". */
function describeDraft(draft, exercise) {
  if (exercise?.tracks === 'time') return formatDuration(draft.seconds || 0);
  const weight = exercise?.tracks === 'bodyweight_reps' && !draft.weight
    ? 'BW'
    : formatWeight(draft.weight ?? 0);
  return `${weight} × ${draft.reps ?? 0}`;
}

function describeIssue(issue) {
  if (issue.kind === 'weight') {
    return `<li><strong>${formatWeight(issue.value)} lbs</strong> — that's
      ${issue.percent}% over your last working set of
      ${formatWeight(issue.previous)}.</li>`;
  }
  if (issue.reason === 'implausible') {
    return `<li><strong>${issue.value} reps</strong> — that's a lot. Sure?</li>`;
  }
  return `<li><strong>${issue.value} reps</strong> — your last working set was
    ${issue.previous}.</li>`;
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
  state.templates = await store.listTemplates();
  const weighIns = state.workout ? [] : await store.listWeights();
  state.weighInDays = weighIns.length
    ? Math.round((Date.now() - new Date(weighIns[weighIns.length - 1].weighed_at).getTime()) / 86400000)
    : null;
  state.lastPlaceId = await store.lastPlaceId();
  state.targets = await store.targetsForWorkout(state.workout);
  state.template = state.workout?.template_id
    ? state.templates.find((t) => t.id === state.workout.template_id) || null
    : null;
  state.place = state.workout?.place_id
    ? state.places.find((p) => p.id === state.workout.place_id) || null
    : null;
}

/* ---------- rendering ---------- */

function placeName(placeId) {
  return state.places.find((p) => p.id === placeId)?.name || null;
}

/* Routines you'd use where you trained last come first, then the ones that
   aren't tied to a gym, then everything else. */
function sortedTemplates() {
  const rank = (template) => {
    if (template.place_id && template.place_id === state.lastPlaceId) return 0;
    if (!template.place_id) return 1;
    return 2;
  };
  return [...state.templates].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.position ?? 0) - (b.position ?? 0) ||
    a.name.localeCompare(b.name));
}

function renderIdle() {
  const recent = state.recent.map((workout) => `
    <li>
      <button class="row row-button" data-act="open-session" data-id="${workout.id}">
        <span class="row-main">${escapeHTML(formatDate(workout.started_at))}</span>
        <span class="row-sub">${workout.ended_at
          ? formatDuration((new Date(workout.ended_at) - new Date(workout.started_at)) / 1000)
          : ''} ›</span>
      </button>
    </li>`).join('');

  const templates = sortedTemplates().map((template) => {
    const where = placeName(template.place_id);
    const here = template.place_id && template.place_id === state.lastPlaceId;
    return `
      <li class="routine">
        <button class="routine-go" data-act="start-template" data-template="${template.id}">
          <span class="routine-name">${escapeHTML(template.name)}</span>
          <span class="routine-where ${here ? 'here' : ''}">
            ${where ? escapeHTML(where) : 'any location'}
          </span>
        </button>
        <button class="routine-edit" data-act="edit-template" data-template="${template.id}"
                aria-label="Edit routine">Edit</button>
      </li>`;
  }).join('');

  // The weekly weigh-in reminder: shown here too, since this is the screen you
  // actually open.
  const nudge = state.weighInDays !== null && state.weighInDays >= 7 ? `
    <button class="weigh-nudge" data-act="go-weight">
      Last weigh-in was ${state.weighInDays} days ago — log one
    </button>` : '';

  return `
    ${nudge}
    ${state.templates.length ? `
      <h3 class="section-label">Routines</h3>
      <ul class="routine-list">${templates}</ul>` : `
      <p class="hint center">Group your exercises into routines — a Push day, a
         Pull day — and start one in a tap. You can also finish a session and
         save it as a routine.</p>`}

    <button class="btn btn-block" data-act="start">Start empty workout</button>
    <button class="btn btn-quiet btn-block" data-act="new-template">+ New routine</button>
    <button class="btn-link" data-act="place">Locations</button>

    ${state.recent.length ? `
      <h3 class="section-label">Recent sessions</h3>
      <ul class="card-list">${recent}</ul>` : ''}
  `;
}

function renderActive() {
  const byExercise = new Map();
  for (const set of state.sets) {
    if (!byExercise.has(set.exercise_id)) byExercise.set(set.exercise_id, []);
    byExercise.get(set.exercise_id).push(set);
  }

  // The plan is the running order. Anything logged outside it — an exercise
  // added before this build, or one whose block was removed — still shows.
  const plan = state.workout.plan || [];
  const extras = [...byExercise.keys()].filter((id) => !plan.includes(id));
  const order = [...plan, ...extras];

  const blocks = order.map((exerciseId) => {
    const exercise = exerciseById(exerciseId);
    const sets = byExercise.get(exerciseId) || [];
    const rows = sets.map((set) => `
      <li class="set-row${set.is_dropset ? ' is-drop' : ''}">
        <span class="set-n">${set.is_dropset ? '↳' : set.set_index}</span>
        <span class="set-desc">${escapeHTML(describeSet(set, exercise))}</span>
        ${set.failed ? '<span class="tag tag-fail">fail</span>' : ''}
        ${set.is_warmup ? '<span class="tag">warmup</span>' : ''}
      </li>`).join('');

    return `
      <section class="ex-block${sets.length ? '' : ' is-planned'}">
        <header class="ex-head">
          <h3>${escapeHTML(exercise?.name || 'Unknown exercise')}</h3>
          ${sets.length
            ? `<span class="ex-count">${(() => {
                const target = state.targets.get(exerciseId);
                const working = sets.filter((s) => !s.is_warmup && !s.is_dropset).length;
                if (target?.sets) {
                  return `${working} of ${target.sets} sets${
                    working >= target.sets ? ' ✓' : ''}`;
                }
                return `${sets.length} ${sets.length === 1 ? 'set' : 'sets'}`;
              })()}</span>`
            // Only offer removal while nothing is logged: dropping a block that
            // holds sets is a destructive act, and belongs elsewhere.
            : `<button class="ex-remove" data-act="unplan" data-ex="${exerciseId}"
                       aria-label="Remove from this session">×</button>`}
        </header>
        <ul class="set-list">${rows}</ul>
        ${!sets.length && state.targets.get(exerciseId) ? `
          <p class="ex-target">Target ${[
            state.targets.get(exerciseId).sets,
            state.targets.get(exerciseId).reps,
          ].filter(Boolean).join(' × ')}</p>` : ''}
        <button class="btn btn-quiet btn-block" data-act="log" data-ex="${exerciseId}">
          ${sets.length ? 'Add set' : 'Start this exercise'}
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
      ${state.template ? '' : `
        <div class="save-routine">
          <input class="search" id="routineName" type="text" autocomplete="off"
                 autocapitalize="words" placeholder="Save as a routine, e.g. Push">
          <button class="btn btn-quiet btn-block" data-act="finish-save">
            Finish &amp; save as routine
          </button>
        </div>`}
      <button class="btn-link danger" data-act="discard">Discard session</button>
    </div>` : `
    <button class="btn btn-quiet btn-block" data-act="finish">Finish session</button>`;

  return `
    <div class="session-bar">
      <div class="session-id">
        <span class="session-clock" id="sessionClock">${formatElapsed(state.workout.started_at)}</span>
        ${state.template ? `<span class="session-routine">${escapeHTML(state.template.name)}</span>` : ''}
      </div>
      <button class="place-pick" data-act="place">
        ${state.placeDetected ? '<span class="geo-pin" aria-label="detected">◉</span> ' : ''}${
          state.place ? escapeHTML(state.place.name) : 'Set location'}
      </button>
    </div>
    ${state.placeSuggestion ? `
      <div class="geo-suggest">
        <span>Looks like you're at <strong>${escapeHTML(state.placeSuggestion.name)}</strong></span>
        <button class="btn-link" data-act="geo-accept">Switch</button>
        <button class="btn-link geo-dismiss" data-act="geo-dismiss" aria-label="Dismiss">×</button>
      </div>` : ''}
    ${blocks || '<p class="hint center">Nothing logged yet. Add an exercise to begin.</p>'}
    <button class="btn btn-block" data-act="pick">+ Add exercise</button>
    ${finishArea}
  `;
}

function savedLine(place) {
  if (!geo.hasLocation(place)) return 'No location saved';
  const when = place.located_at
    ? new Date(place.located_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : 'saved';
  const acc = place.accuracy_m != null ? ` · ±${geo.formatDistance(place.accuracy_m)}` : '';
  const rough = place.accuracy_m > geo.ROUGH_CAPTURE_M
    ? ' · rough, retake near a window' : '';
  return `Saved ${when}${acc}${rough}`;
}

function renderPlaceSheet() {
  const inSession = Boolean(state.workout);
  const rows = state.places.map((place) => {
    const current = state.workout?.place_id === place.id;
    const busy = state.geoBusy === place.id;
    return `
      <li class="place-row ${current ? 'is-on' : ''}">
        ${inSession ? `
          <button class="place-choose" data-act="choose-place" data-place="${place.id}">
            <span class="pick-name">${escapeHTML(place.name)}</span>
            <span class="place-saved">${escapeHTML(savedLine(place))}</span>
          </button>` : `
          <div class="place-choose">
            <span class="pick-name">${escapeHTML(place.name)}</span>
            <span class="place-saved">${escapeHTML(savedLine(place))}</span>
          </div>`}
        <button class="btn btn-quiet place-capture" data-act="geo-capture" data-place="${place.id}"
                ${state.geoBusy ? 'disabled' : ''}>
          ${busy ? 'Locating…' : geo.hasLocation(place) ? 'Update' : 'Set to here'}
        </button>
      </li>`;
  }).join('');

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>${inSession ? 'Where are you training?' : 'Locations'}</h2>
        <button class="btn-link" data-act="close">Done</button>
      </header>
      <p class="hint">Stand in a gym and tap <strong>Set to here</strong> once. After
         that, starting a workout there picks it for you. Notes you write come
         back the next time you do that exercise at the same place.</p>
      <button class="btn btn-quiet btn-block" data-act="geo-detect" ${state.geoBusy ? 'disabled' : ''}>
        ${state.geoBusy === 'detect' ? 'Locating…' : 'Where am I?'}
      </button>
      ${state.geoStatus ? `<p class="geo-status ${state.geoStatus.tone || ''}">${
        escapeHTML(state.geoStatus.text)}</p>` : ''}
      <ul class="place-list">${rows}</ul>
      <input class="search" id="newPlace" type="text" autocomplete="off"
             autocapitalize="words" placeholder="Add another location">
      <button class="btn btn-quiet btn-block" data-act="create-place">Add location</button>
    </div>`;
}

function renderTemplateSheet() {
  const draft = state.templateDraft;
  const rows = draft.entries.map((entry, i) => {
    const exercise = exerciseById(entry.exercise_id);
    return `
      <li class="routine-ex">
        <div class="routine-ex-top">
          <span class="routine-ex-name">${escapeHTML(exercise?.name || 'Removed exercise')}</span>
          <button class="routine-ex-btn" data-act="tpl-up" data-i="${i}"
                  ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="routine-ex-btn" data-act="tpl-down" data-i="${i}"
                  ${i === draft.entries.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="routine-ex-btn danger" data-act="tpl-remove" data-i="${i}"
                  aria-label="Remove">×</button>
        </div>
        <div class="routine-ex-target">
          <input class="mini" type="text" inputmode="numeric" data-tpl="sets" data-i="${i}"
                 placeholder="3" value="${entry.target_sets ?? ''}" aria-label="Target sets">
          <span class="routine-ex-x">×</span>
          <input class="mini" type="text" inputmode="numeric" data-tpl="reps" data-i="${i}"
                 placeholder="8" value="${entry.target_reps ?? ''}" aria-label="Target reps">
          <span class="routine-ex-hint">sets × reps</span>
        </div>
      </li>`;
  }).join('');

  const placeChips = [
    `<button class="chip ${!draft.placeId ? 'is-on' : ''}" data-act="tpl-place" data-place="">
       Any</button>`,
    ...state.places.map((place) => `
      <button class="chip ${draft.placeId === place.id ? 'is-on' : ''}"
              data-act="tpl-place" data-place="${place.id}">
        ${escapeHTML(place.name.replace('Planet Fitness — ', 'PF '))}
      </button>`),
  ].join('');

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>${draft.id ? 'Edit routine' : 'New routine'}</h2>
        <button class="btn-link" data-act="tpl-cancel">Cancel</button>
      </header>

      <div class="field">
        <label for="tplName">Name</label>
        <input class="search" id="tplName" type="text" autocomplete="off"
               autocapitalize="words" placeholder="Push, Pull, Legs…"
               value="${escapeHTML(draft.name)}">
      </div>

      <div class="field">
        <label>Location <span class="optional">keeps gym-specific versions apart</span></label>
        <div class="chips chips-wrap">${placeChips}</div>
      </div>

      <div class="field">
        <label>Exercises, in order</label>
        ${draft.entries.length
          ? `<ul class="routine-ex-list">${rows}</ul>`
          : '<p class="hint">Nothing added yet.</p>'}
        <button class="btn btn-quiet btn-block" data-act="tpl-add">+ Add exercise</button>
      </div>

      <button class="btn btn-block" data-act="tpl-save">
        ${draft.id ? 'Save changes' : 'Create routine'}
      </button>

      ${draft.id ? (draft.confirmDelete ? `
        <div class="confirm">
          <p>Delete this routine? Your logged sessions aren't affected.</p>
          <div class="confirm-actions">
            <button class="btn btn-quiet" data-act="tpl-delete-cancel">Keep it</button>
            <button class="btn btn-danger" data-act="tpl-delete-confirm">Delete</button>
          </div>
        </div>` : `
        <button class="btn-link danger" data-act="tpl-delete">Delete routine</button>`) : ''}
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

  const { target, e1rm, suggested } = state.sheet;
  const targetText = target
    ? `Target ${[target.sets, target.reps].filter(Boolean).join(' × ')}`
    : '';
  const targetLine = (targetText || suggested) ? `
    <div class="target-line">
      ${targetText ? `<span class="target-text">${escapeHTML(targetText)}</span>` : ''}
      ${suggested ? `
        <button class="suggest-chip" data-act="use-suggested" data-weight="${suggested}">
          Try ${formatWeight(suggested)} lbs
        </button>
        <span class="suggest-why">
          from an estimated 1RM of ${Math.round(e1rm)}, leaving ~2 reps in reserve
        </span>` : ''}
    </div>` : '';

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
      ${targetLine}
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
          <p class="weight-confirm-lead">Worth a second look:</p>
          <ul class="confirm-issues">
            ${state.sheet.pendingConfirm.issues.map(describeIssue).join('')}
          </ul>
          <div class="confirm-actions">
            <button class="btn btn-quiet" data-act="cancel-log">Back</button>
            <button class="btn btn-danger" data-act="confirm-log">
              Log ${escapeHTML(describeDraft(draft, exercise))}
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
  else if (state.sheet?.type === 'template') html = renderTemplateSheet();
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
  const target = state.targets.get(exerciseId) || null;

  // A suggestion only makes sense for weight-based work with recent history.
  const e1rm = exercise?.tracks === 'weight_reps'
    ? await store.bestE1RMFor(exerciseId)
    : null;
  const targetReps = target?.reps ?? null;
  const suggested = suggestWeight(e1rm, targetReps);

  // Has anything been logged for this exercise in this session yet?
  const startedHere = state.sets.some((s) => s.exercise_id === exerciseId);
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
    target,
    e1rm,
    suggested,
    pendingConfirm: null,
    priorNote,
    note: note?.body || '',
    draft: {
      // The suggestion is offered, never imposed: weight prefills from what you
      // actually lifted last time, which is evidence rather than arithmetic.
      weight: last?.weight ?? (exercise?.tracks === 'bodyweight_reps' ? 0 : 45),
      // Reps follow the routine's target until the first set is in, after
      // which they follow what you just did.
      reps: (!startedHere && targetReps) || last?.reps
        || (exercise?.tracks === 'time' ? null : 8),
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

/* The routine editor re-renders on reorder and removal, which would otherwise
   throw away numbers typed but not yet committed. */
function readTemplateInputs() {
  if (state.sheet?.type !== 'template' || !state.templateDraft) return;

  const nameField = root.querySelector('#tplName');
  if (nameField) state.templateDraft.name = nameField.value;

  for (const input of root.querySelectorAll('input[data-tpl]')) {
    const entry = state.templateDraft.entries[Number(input.dataset.i)];
    if (!entry) continue;
    const raw = input.value.trim();
    const value = raw === '' ? null : Number(raw);
    const field = input.dataset.tpl === 'sets' ? 'target_sets' : 'target_reps';
    entry[field] = Number.isFinite(value) && value > 0 ? value : null;
  }
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

  if (target.id === 'tplName') {
    state.templateDraft.name = target.value;
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

  // Anything that looks like a mis-tap gets a second look before it's logged.
  if (!confirmed) {
    const issues = checkSet(
      { weight: draft.weight, reps: draft.reps, isWarmup: draft.is_warmup, isDrop },
      state.sheet.reference,
      exercise,
    );
    if (issues.length) {
      state.sheet.pendingConfirm = { issues, isDrop };
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
      resetDetection();
      await refresh();
      state.sheet = { type: 'picker', query: '' };
      render();
      detectForSession({ explicit: false });
      return;

    case 'pick':
      state.sheet = { type: 'picker', query: '' };
      return render();

    case 'place':
      state.sheet = { type: 'place' };
      return render();

    case 'open-session':
      document.dispatchEvent(new CustomEvent('liftlog:open-session', {
        detail: { id: trigger.dataset.id },
      }));
      return;

    case 'go-weight':
      document.querySelector('.tab[data-view="weight"]')?.click();
      return;

    case 'choose-place':
      state.workout = await store.setWorkoutPlace(state.workout, trigger.dataset.place);
      state.placePickedManually = true;
      state.placeDetected = false;
      state.placeSuggestion = null;
      await refresh();
      state.sheet = null;
      return render();

    case 'geo-accept':
      if (!state.placeSuggestion || !state.workout) return;
      state.workout = await store.setWorkoutPlace(state.workout, state.placeSuggestion.id);
      state.placeSuggestion = null;
      state.placeDetected = true;
      await refresh();
      return render();

    case 'geo-dismiss':
      state.placeSuggestion = null;
      return render();

    case 'geo-detect':
      return detectNow();

    case 'geo-capture':
      return capturePlace(trigger.dataset.place);

    case 'create-place': {
      const input = root.querySelector('#newPlace');
      const name = input?.value.trim();
      if (!name) return;
      const place = await store.createPlace(name);
      if (state.workout) {
        state.workout = await store.setWorkoutPlace(state.workout, place.id);
        state.placePickedManually = true;
        state.placeDetected = false;
        state.sheet = null;
      }
      await refresh();
      return render();
    }

    case 'close':
      // Cancelling the picker while building a routine returns to the editor
      // rather than throwing away what's been assembled.
      if (state.sheet?.mode === 'template') {
        state.sheet = { type: 'template' };
        return render();
      }
      if (state.sheet?.type === 'log') {
        readSheetInputs();
        await saveNoteNow();
      }
      state.sheet = null;
      await refresh();
      return render();

    case 'choose': {
      const id = trigger.dataset.ex;
      if (state.sheet.mode === 'template') {
        if (!state.templateDraft.entries.some((e) => e.exercise_id === id)) {
          state.templateDraft.entries.push({
            exercise_id: id, target_sets: null, target_reps: null,
          });
        }
        state.sheet = { type: 'template' };
        return render();
      }
      state.workout = await store.addToPlan(state.workout, id);
      return openLogSheet(id);
    }

    case 'create': {
      const name = (state.sheet.query || '').trim();
      if (!name) return;
      const exercise = await store.createExercise({ name });
      state.exercises = await store.listExercises();

      if (state.sheet.mode === 'template') {
        if (!state.templateDraft.entries.some((e) => e.exercise_id === exercise.id)) {
          state.templateDraft.entries.push({
            exercise_id: exercise.id, target_sets: null, target_reps: null,
          });
        }
        state.sheet = { type: 'template' };
        return render();
      }
      state.workout = await store.addToPlan(state.workout, exercise.id);
      return openLogSheet(exercise.id);
    }

    /* ---------- routines ---------- */

    case 'start-template': {
      state.workout = await store.startWorkout({ templateId: trigger.dataset.template });
      resetDetection();
      await refresh();
      render();
      // A routine tied to a gym is an explicit choice: GPS may suggest, not override.
      detectForSession({ explicit: Boolean(state.workout.template_id && state.workout.place_id) });
      return;
    }

    case 'new-template':
      state.templateDraft = {
        id: null, name: '', placeId: state.lastPlaceId, entries: [], confirmDelete: false,
      };
      state.sheet = { type: 'template' };
      return render();

    case 'edit-template': {
      const template = state.templates.find((t) => t.id === trigger.dataset.template);
      if (!template) return;
      const entries = await store.templateExercises(template.id);
      state.templateDraft = {
        id: template.id,
        name: template.name,
        placeId: template.place_id,
        entries: entries.map(({ row, exercise }) => ({
          exercise_id: exercise.id,
          target_sets: row.target_sets ?? null,
          target_reps: row.target_reps ?? null,
        })),
        confirmDelete: false,
      };
      state.sheet = { type: 'template' };
      return render();
    }

    case 'tpl-add':
      readTemplateInputs();
      state.sheet = { type: 'picker', query: '', mode: 'template' };
      return render();

    case 'tpl-place':
      readTemplateInputs();
      state.templateDraft.placeId = trigger.dataset.place || null;
      return render();

    case 'tpl-up':
    case 'tpl-down': {
      readTemplateInputs();
      const i = Number(trigger.dataset.i);
      const to = act === 'tpl-up' ? i - 1 : i + 1;
      const entries = state.templateDraft.entries;
      if (to < 0 || to >= entries.length) return;
      [entries[i], entries[to]] = [entries[to], entries[i]];
      return render();
    }

    case 'tpl-remove':
      readTemplateInputs();
      state.templateDraft.entries.splice(Number(trigger.dataset.i), 1);
      return render();

    case 'tpl-save': {
      readTemplateInputs();
      const name = state.templateDraft.name.trim();
      if (!name) {
        root.querySelector('#tplName')?.focus();
        return;
      }
      const { id, placeId, entries } = state.templateDraft;
      if (id) {
        const template = state.templates.find((t) => t.id === id);
        await store.updateTemplate(template, { name, place_id: placeId });
        await store.setTemplateExercises(id, entries);
      } else {
        await store.createTemplate({ name, place_id: placeId, exercises: entries });
      }
      state.templateDraft = null;
      state.sheet = null;
      await refresh();
      return render();
    }

    case 'tpl-cancel':
      state.templateDraft = null;
      state.sheet = null;
      await refresh();
      return render();

    case 'tpl-delete':
      state.templateDraft.confirmDelete = true;
      return render();

    case 'tpl-delete-cancel':
      state.templateDraft.confirmDelete = false;
      return render();

    case 'tpl-delete-confirm': {
      const template = state.templates.find((t) => t.id === state.templateDraft.id);
      if (template) await store.deleteTemplate(template);
      state.templateDraft = null;
      state.sheet = null;
      await refresh();
      return render();
    }

    case 'unplan': {
      state.workout = await store.removeFromPlan(state.workout, trigger.dataset.ex);
      await refresh();
      return render();
    }

    case 'finish-save': {
      const field = root.querySelector('#routineName');
      const name = field?.value.trim();
      if (!name) {
        field?.focus();
        return;
      }
      await store.createTemplateFromWorkout(state.workout, name);
      await store.finishWorkout(state.workout);
      await rest.stop();
      state.rest.endsAt = null;
      state.confirmFinish = false;
      state.sheet = null;
      await refresh();
      return render();
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

    case 'use-suggested':
      state.sheet.draft.weight = Number(trigger.dataset.weight);
      return render();

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

/* Re-read everything and repaint. Called after a sync pulls new data, and a
   no-op while a sheet is open — repainting under a half-entered set is exactly
   the kind of thing this app is supposed to not do. */
export async function reload() {
  if (!root || state.sheet) return false;
  await refresh();
  render();
  return true;
}

/* ---------- location ---------- */

function resetDetection() {
  state.placePickedManually = false;
  state.placeDetected = false;
  state.placeSuggestion = null;
}

/* Only repaint when nothing is open: a sheet may hold a half-entered set. */
function renderIfIdle() {
  if (!state.sheet || state.sheet.type === 'picker') render();
}

/* Runs after a session starts and never blocks it. Indoor fixes are slow and
   often vague; if nothing useful comes back, nothing happens.

   Applied silently only when the current location was a guess — the default
   carried over from last time — and you haven't touched it or logged anything.
   Otherwise, if GPS disagrees, it's offered as a one-tap suggestion. */
async function detectForSession({ explicit }) {
  const sessionId = state.workout?.id;
  let fix;
  try {
    fix = await geo.currentFix({ timeout: 15000, maximumAge: 60000 });
  } catch {
    return;
  }

  // The world may have moved on while we waited.
  if (!state.workout || state.workout.id !== sessionId || state.workout.ended_at) return;

  const match = geo.matchPlace(state.places, fix);
  if (!match || match.place.id === state.workout.place_id) {
    if (match) state.placeDetected = true;
    return renderIfIdle();
  }

  const canApply = !explicit && !state.placePickedManually
    && !match.ambiguous && state.sets.length === 0;

  if (canApply) {
    state.workout = await store.setWorkoutPlace(state.workout, match.place.id);
    state.placeDetected = true;
    const sheetOpen = state.sheet && state.sheet.type !== 'picker';
    if (!sheetOpen) await refresh();
  } else {
    state.placeSuggestion = match.place;
  }
  renderIfIdle();
}

/* The "Where am I?" button: the diagnostics readout for this feature. */
async function detectNow() {
  state.geoBusy = 'detect';
  state.geoStatus = null;
  render();
  try {
    const fix = await geo.currentFix();
    const match = geo.matchPlace(state.places, fix);
    const nearest = geo.nearestPlace(state.places, fix);
    const acc = geo.formatDistance(fix.accuracy);

    if (fix.accuracy > geo.MAX_USEFUL_ACCURACY_M) {
      state.geoStatus = { tone: 'warn', text: `Location too vague to use (±${acc}). Try near a window.` };
    } else if (match) {
      state.geoStatus = {
        tone: 'good',
        text: `${geo.formatDistance(match.distance)} from ${match.place.name} (±${acc})`
          + (match.ambiguous ? ' — another saved place is also this close' : ''),
      };
    } else if (nearest) {
      state.geoStatus = {
        text: `Not at a saved place. Nearest is ${nearest.place.name}, `
          + `${geo.formatDistance(nearest.distance)} away (±${acc}).`,
      };
    } else {
      state.geoStatus = { text: `Got a fix (±${acc}), but no places have a location saved yet.` };
    }
  } catch (error) {
    state.geoStatus = { tone: 'warn', text: error.message };
  }
  state.geoBusy = null;
  render();
}

/* "Set to here": take a fresh fix and save it as this place's location. */
async function capturePlace(placeId) {
  const place = state.places.find((p) => p.id === placeId);
  if (!place) return;

  state.geoBusy = placeId;
  state.geoStatus = null;
  render();
  try {
    const fix = await geo.currentFix({ timeout: 20000, maximumAge: 0 });
    await store.setPlaceLocation(place, fix);
    state.places = await store.listPlaces();
    state.geoStatus = fix.accuracy > geo.ROUGH_CAPTURE_M
      ? { tone: 'warn', text: `Saved ${place.name}, but the fix was rough (±${geo.formatDistance(fix.accuracy)}). It'll still tell your gyms apart; retake near a window for a better one.` }
      : { tone: 'good', text: `Saved ${place.name} (±${geo.formatDistance(fix.accuracy)}).` };
  } catch (error) {
    state.geoStatus = { tone: 'warn', text: error.message };
  }
  state.geoBusy = null;
  render();
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
