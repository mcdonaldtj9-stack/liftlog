/* Progression suggestions and PR detection — pure rules, known answers. */

import {
  suggestProgression, progressionStep, detectPR, PR_MIN_PRIOR_SESSIONS,
} from '../js/rules.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const lift = { tracks: 'weight_reps' };
let n = 0;
const s = (extra) => ({
  id: `s${++n}`, workout_id: 'w', weight: 185, reps: 8, rpe: 7,
  failed: 0, is_warmup: 0, is_dropset: 0, deleted: 0, ...extra,
});
const target = { sets: 3, reps: 8 };

// ---------- progression ----------

const easy = [s({ rpe: 7 }), s({ rpe: 7 }), s({ rpe: 8 })];
const go = suggestProgression(easy, target, lift);
check('3 x 8 at RPE 7, 7, 8 suggests going up', go?.weight === 190, JSON.stringify(go));
check('and says what it was built on', go.from === 185 && go.sets === 3 && go.reps === 8 && go.hardestRpe === 8);

check('one set at RPE 9 means stay', suggestProgression(
  [s({}), s({}), s({ rpe: 9 })], target, lift) === null);
check('two sets against a target of three means stay', suggestProgression(
  [s({}), s({})], target, lift) === null);
check('a set short of the target reps means stay', suggestProgression(
  [s({}), s({}), s({ reps: 7 })], target, lift) === null);
check('a failed set means stay', suggestProgression(
  [s({}), s({}), s({}), s({ failed: 1, reps: 1, rpe: null })], target, lift) === null);
check('no RPE means no suggestion — it can\'t tell easy from a grind', suggestProgression(
  [s({ rpe: null }), s({ rpe: null }), s({ rpe: null })], target, lift) === null);
check('warmups and drops are ignored', suggestProgression(
  [s({ weight: 95, reps: 12, is_warmup: 1, rpe: null }), ...easy, s({ weight: 135, reps: 15, is_dropset: 1, rpe: 10 })],
  target, lift)?.weight === 190);
check('beating the rep target still counts', suggestProgression(
  [s({ reps: 10 }), s({ reps: 9 }), s({ reps: 8 })], target, lift)?.weight === 190);
check('mixed weights progress from the lightest', suggestProgression(
  [s({ weight: 185 }), s({ weight: 180 }), s({ weight: 185 })], target, lift)?.weight === 185);

check('light work steps by 2.5', progressionStep(30) === 2.5
  && suggestProgression([s({ weight: 30 }), s({ weight: 30 }), s({ weight: 30 })], target, lift)?.weight === 32.5);
check('from 60 up it steps by 5', progressionStep(60) === 5);

check('without a routine, a consistent last session is its own target',
  suggestProgression([s({}), s({})], null, lift)?.weight === 190);
check('but not an inconsistent one', suggestProgression([s({ reps: 8 }), s({ reps: 6 })], null, lift) === null);
check('nor a single set', suggestProgression([s({})], null, lift) === null);
check('bodyweight work gets no weight suggestion',
  suggestProgression(easy, target, { tracks: 'bodyweight_reps' }) === null);
check('nor does timed work', suggestProgression(easy, target, { tracks: 'time' }) === null);
check('no history, no suggestion', suggestProgression([], target, lift) === null);

// ---------- PRs ----------

/* Prior history across `sessions` workouts, each with one 185 x 8 @ 8. */
const history = (sessions, extra = {}) =>
  Array.from({ length: sessions }, (_, i) => s({ workout_id: `w${i}`, rpe: 8, ...extra }));

const heavier = s({ id: 'new', workout_id: 'now', weight: 195, reps: 8, rpe: 9 });
const pr = detectPR(heavier, history(3), lift);
check('heavier for the same reps is a rep PR', pr?.repPR === true && pr.previousWeight === 185);
check('which is also an estimated 1RM PR here', pr.e1rmPR === true && pr.estimate > pr.previousEstimate);

check('equal is not a PR', detectPR(s({ workout_id: 'now', weight: 185, reps: 8, rpe: 8 }), history(3), lift) === null);
check('more reps at the same weight beats the 8-rep best only via e1RM',
  (() => { const r = detectPR(s({ workout_id: 'now', weight: 185, reps: 10, rpe: 8 }), history(3), lift);
    return r && !r.repPR && r.e1rmPR; })());
const triple = detectPR(s({ workout_id: 'now', weight: 200, reps: 3, rpe: 7 }), history(3), lift);
check('a heavier triple is a 3-rep record, reported as such',
  triple?.repPR === true && triple.reps === 3 && triple.previousWeight === 185);
check('but a lighter triple beats nothing',
  detectPR(s({ workout_id: 'now', weight: 175, reps: 3, rpe: 6 }), history(3), lift) === null);

check(`needs ${PR_MIN_PRIOR_SESSIONS} prior sessions before anything is a PR`,
  detectPR(heavier, history(PR_MIN_PRIOR_SESSIONS - 1), lift) === null);
check('a warmup is never a PR', detectPR({ ...heavier, is_warmup: 1 }, history(3), lift) === null);
check('a drop set is never a PR', detectPR({ ...heavier, is_dropset: 1 }, history(3), lift) === null);
check('a failed set is never a PR', detectPR({ ...heavier, failed: 1 }, history(3), lift) === null);
check('failed attempts in history are not a bar to beat',
  detectPR(heavier, [...history(3), s({ workout_id: 'w9', weight: 245, reps: 8, failed: 1 })], lift)?.repPR === true);
check('a set is never compared with itself',
  detectPR(heavier, [...history(3), heavier], lift)?.repPR === true);

// PRs are all-time: an old peak still has to be beaten.
const oldPeak = [...history(3), s({ workout_id: 'ancient', weight: 225, reps: 8, rpe: 10,
  created_at: '2024-01-01T00:00:00.000Z' })];
check('an old peak still counts against a new set', detectPR(heavier, oldPeak, lift) === null);
check('bodyweight work has no PRs here', detectPR(heavier, history(3), { tracks: 'bodyweight_reps' }) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
