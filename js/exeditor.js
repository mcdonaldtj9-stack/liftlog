/* The exercise editor, shared by the Train and History tabs so the two can
   never disagree about what an exercise is.

   Rules that protect history:
     - A name can't collide with another exercise (store enforces it).
     - How an exercise is tracked (weight, bodyweight, time) can only change
       while nothing has been logged, or every old set would be nonsense.
     - Deleting removes it from lists and pickers but keeps every logged set. */

import * as store from './store.js';
import { MUSCLE_GROUPS } from './seed.js';
import { PRESETS, format as formatRest } from './rest.js';

const TRACKS = [
  ['weight_reps', 'Weight × reps'],
  ['bodyweight_reps', 'Bodyweight × reps'],
  ['time', 'Time'],
];

const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

export async function draftFor(exercise) {
  return {
    id: exercise.id,
    name: exercise.name,
    muscle_group: exercise.muscle_group || 'Other',
    tracks: exercise.tracks || 'weight_reps',
    rest_seconds: exercise.rest_seconds ?? null,
    setCount: await store.setCountFor(exercise.id),
    confirmDelete: false,
    error: null,
  };
}

export function render(draft) {
  const muscles = MUSCLE_GROUPS.map((m) => `
    <button class="chip ${draft.muscle_group === m ? 'is-on' : ''}" data-act="ex-muscle"
            data-value="${escapeHTML(m)}">${escapeHTML(m)}</button>`).join('');

  const locked = draft.setCount > 0;
  const tracks = TRACKS.map(([key, label]) => `
    <button class="chip ${draft.tracks === key ? 'is-on' : ''}" data-act="ex-tracks"
            data-value="${key}" ${locked && draft.tracks !== key ? 'disabled' : ''}>${label}</button>`).join('');

  const rests = [
    `<button class="chip ${draft.rest_seconds == null ? 'is-on' : ''}" data-act="ex-rest" data-value="">Default</button>`,
    ...PRESETS.map((s) => `
      <button class="chip ${draft.rest_seconds === s ? 'is-on' : ''}" data-act="ex-rest"
              data-value="${s}">${formatRest(s)}</button>`),
  ].join('');

  const deleteArea = draft.confirmDelete ? `
    <div class="confirm">
      <p>Delete ${escapeHTML(draft.name)}?</p>
      <p class="hint center">${draft.setCount
        ? `Your ${draft.setCount} logged ${draft.setCount === 1 ? 'set stays' : 'sets stay'} in past sessions. It just won't appear in pickers or lists.`
        : "It hasn't been logged, so nothing else changes."}</p>
      <div class="confirm-actions">
        <button class="btn btn-quiet" data-act="ex-delete-cancel">Keep it</button>
        <button class="btn btn-danger" data-act="ex-delete-confirm">Delete</button>
      </div>
    </div>` : `
    <button class="btn-link danger" data-act="ex-delete">Delete exercise</button>`;

  return `
    <div class="sheet">
      <header class="sheet-head">
        <h2>Edit exercise</h2>
        <button class="btn-link" data-act="ex-cancel">Cancel</button>
      </header>

      <div class="field">
        <label for="exName">Name</label>
        <input class="search" id="exName" type="text" autocomplete="off"
               autocapitalize="words" value="${escapeHTML(draft.name)}">
      </div>

      <div class="field">
        <label>Muscle group <span class="optional">decides where it counts in weekly volume</span></label>
        <div class="chips chips-wrap">${muscles}</div>
      </div>

      <div class="field">
        <label>Tracked as ${locked ? '<span class="optional">locked once sets are logged</span>' : ''}</label>
        <div class="chips chips-wrap">${tracks}</div>
      </div>

      <div class="field">
        <label>Rest after this exercise</label>
        <div class="chips chips-wrap">${rests}</div>
      </div>

      ${draft.error ? `<p class="hint warn">${escapeHTML(draft.error)}</p>` : ''}
      <button class="btn btn-block" data-act="ex-save">Save</button>
      ${deleteArea}
    </div>`;
}

/* Read the name box before anything re-renders over it. */
export function readInputs(root, draft) {
  const name = root.querySelector('#exName');
  if (name) draft.name = name.value;
}

/* Handle one editor action. Returns what happened, so the host view can decide
   where to go next: 'saved', 'deleted', 'cancelled', 'changed' (re-render), or
   null when the action wasn't the editor's. */
export async function handle(act, trigger, draft, root) {
  if (!act.startsWith('ex-')) return null;
  readInputs(root, draft);
  draft.error = null;

  switch (act) {
    case 'ex-muscle':
      draft.muscle_group = trigger.dataset.value;
      return 'changed';

    case 'ex-tracks':
      if (draft.setCount > 0) return 'changed';
      draft.tracks = trigger.dataset.value;
      return 'changed';

    case 'ex-rest':
      draft.rest_seconds = trigger.dataset.value === '' ? null : Number(trigger.dataset.value);
      return 'changed';

    case 'ex-delete':
      draft.confirmDelete = true;
      return 'changed';

    case 'ex-delete-cancel':
      draft.confirmDelete = false;
      return 'changed';

    case 'ex-delete-confirm': {
      const exercise = (await store.listExercises()).find((e) => e.id === draft.id);
      if (exercise) await store.deleteExercise(exercise);
      return 'deleted';
    }

    case 'ex-cancel':
      return 'cancelled';

    case 'ex-save': {
      const exercise = (await store.listExercises()).find((e) => e.id === draft.id);
      if (!exercise) return 'cancelled';
      try {
        const changes = {
          name: draft.name,
          muscle_group: draft.muscle_group,
          rest_seconds: draft.rest_seconds,
        };
        if (draft.setCount === 0) changes.tracks = draft.tracks;
        await store.updateExercise(exercise, changes);
        return 'saved';
      } catch (error) {
        draft.error = error.message;
        return 'changed';
      }
    }
  }
  return null;
}
