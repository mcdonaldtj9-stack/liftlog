/* Export and import, against a real (fake) IndexedDB. The cases that matter
   most: credentials never leave, deletions survive a restore, and an old
   backup can't overwrite newer work. */

import 'fake-indexeddb/auto';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const db = await import('../js/db.js');
const store = await import('../js/store.js');
const ex = await import('../js/export.js');

await store.init();

// A realistic little history.
const places = await store.listPlaces();
const pf = places.find((p) => p.name.includes('Fenton'));
const bench = (await store.listExercises()).find((e) => e.name === 'Barbell Bench Press');
const custom = await store.createExercise({ name: '=HYPERLINK("http://evil","click")' });
const routine = await store.createTemplate({ name: 'Push', place_id: pf.id, exerciseIds: [bench.id] });
const session = await store.startWorkout({ templateId: routine.id });
await store.addSet({ workout_id: session.id, exercise_id: bench.id, weight: 135, reps: 10, is_warmup: 1 });
await new Promise((r) => setTimeout(r, 2));
const top = await store.addSet({ workout_id: session.id, exercise_id: bench.id, weight: 185, reps: 8, rpe: 8.5 });
await new Promise((r) => setTimeout(r, 2));
await store.addSet({ workout_id: session.id, exercise_id: bench.id, weight: 145, reps: 12, is_dropset: 1 });
await new Promise((r) => setTimeout(r, 2));
const doomed = await store.addSet({ workout_id: session.id, exercise_id: bench.id, weight: 999, reps: 1 });
await store.deleteSet(doomed);
await store.addSet({ workout_id: session.id, exercise_id: custom.id, weight: 50, reps: 10, failed: 1 });
await store.saveNote({ workout_id: session.id, exercise_id: bench.id, body: 'Easy, "go up" 10, next time' });
await store.finishWorkout(await store.getActiveWorkout());
await store.addWeight({ lbs: 186.4, place_id: pf.id });
await store.addWeight({ lbs: 188.1, place_id: null });

// Pretend we're signed in, so there's something sensitive to leak.
await db.setMeta('supabase_session', { access_token: 'SECRET-TOKEN', refresh_token: 'SECRET-REFRESH' });
await db.setMeta('supabase_anon_key', 'SECRET-KEY');

/* ---------- the backup ---------- */

const tables = await ex.readAll();
const backup = ex.buildBackup(tables, { build: '18' });
const text = JSON.stringify(backup);

check('the backup identifies itself', backup.app === 'liftlog' && backup.format === 1);
check('and carries every data table', ex.TABLES.every((t) => Array.isArray(backup.tables[t])));
check('but never the session or key', !/SECRET/.test(text));
check('and no meta table at all', !('meta' in backup.tables));
check('upload bookkeeping is stripped', !/"dirty"/.test(text));
check('deletion markers are kept, so a restore cannot resurrect them',
  backup.tables.sets.some((s) => s.id === doomed.id && s.deleted === 1));
check('RPE halves survive', backup.tables.sets.find((s) => s.id === top.id).rpe === 8.5);
check('dated file name', /^liftlog-\d{4}-\d{2}-\d{2}\.json$/.test(ex.datedName('liftlog', 'json')));

/* ---------- CSV ---------- */

check('plain values pass through', ex.csvCell('Bench') === 'Bench' && ex.csvCell(185) === '185');
check('commas are quoted', ex.csvCell('a,b') === '"a,b"');
check('quotes are doubled', ex.csvCell('say "hi"') === '"say ""hi"""');
check('newlines are quoted', ex.csvCell('a\nb') === '"a\nb"');
check('empty is empty', ex.csvCell(null) === '' && ex.csvCell(undefined) === '');
check('a formula is defused into text', ex.csvCell('=SUM(A1)') === "'=SUM(A1)");
check('so is a leading plus, minus or at',
  ['+1', '-1', '@x'].every((v) => ex.csvCell(v).startsWith("'")));
check('but numbers are left alone, even negative ones', ex.csvCell(-5) === '-5');

const setsCsv = ex.buildSetsCSV(tables);
const lines = setsCsv.replace(/^﻿/, '').trim().split('\r\n');
check('opens with a byte-order mark for Excel', setsCsv.startsWith('﻿'));
check('has a header row', lines[0].startsWith('date,time,location,routine,exercise'));
check('one row per live set, deleted ones left out', lines.length - 1 === 4, `got ${lines.length - 1}`);
check('names replace ids', lines[1].includes('Planet Fitness') && lines[1].includes('Push')
  && lines[1].includes('Barbell Bench Press'));
check('flags read as words', lines[1].includes(',yes,') && lines.some((l) => /,yes,$|,yes,"?[^,]*$/.test(l)));
check('the note appears once, quoted safely',
  setsCsv.split('Easy, ""go up"" 10').length === 2);
check('a hostile exercise name is defused', setsCsv.includes(`"'=HYPERLINK(""http://evil"",""click"")"`));

const weightsCsv = ex.buildWeightsCSV(tables);
check('weigh-ins export with their scale',
  weightsCsv.includes('186.4,Planet Fitness') && weightsCsv.includes('188.1,Other scale'));

/* ---------- reading a backup ---------- */

const reject = (input) => { try { ex.parseBackup(input); return null; } catch (e) { return e; } };
check('garbage is refused politely', reject('not json') instanceof ex.ImportError);
check('some other app\'s JSON is refused', reject('{"hello":1}') instanceof ex.ImportError);
check('a future format is refused with a reason',
  /newer version/.test(reject(JSON.stringify({ ...backup, format: 99 }))?.message || ''));
const damaged = structuredClone(backup);
damaged.tables.sets[0].id = 42;
check('damaged rows are refused', reject(JSON.stringify(damaged)) instanceof ex.ImportError);
check('a real backup reads back', ex.parseBackup(text).tables.sets.length === backup.tables.sets.length);

/* ---------- merging ---------- */

const same = ex.planImport(ex.parseBackup(text), await ex.readAll());
check('importing onto the same data changes nothing', same.total === 0, `got ${same.total}`);

// Edit a set locally after the backup was taken.
await store.updateSet(await db.get('sets', top.id), { reps: 9 });
const afterEdit = ex.planImport(ex.parseBackup(text), await ex.readAll());
check('an old backup cannot overwrite a newer edit', afterEdit.counts.sets === 0);

// Simulate losing the phone: wipe everything, then restore.
for (const name of ex.TABLES) {
  for (const row of await db.getAll(name)) await db.hardDelete(name, row.id);
}
check('the phone is empty', (await store.listExercises()).length === 0);

const restore = ex.planImport(ex.parseBackup(text), await ex.readAll());
check('a restore onto an empty phone takes everything',
  ex.TABLES.every((t) => restore.counts[t] === backup.tables[t].length));
const applied = await ex.applyImport(restore.plan);
check('and applies it', applied === restore.total);

const restored = await ex.readAll();
check('row counts match the backup exactly',
  ex.TABLES.every((t) => restored[t].length === backup.tables[t].length));
check('the deleted set is still deleted', (await db.get('sets', doomed.id)).deleted === 1);
check('restored sessions are readable', (await store.setsForWorkout(session.id)).length === 4);
check('everything restored is queued for upload', restored.sets.every((s) => s.dirty === 1));
check('the note came back', (await store.getNote(session.id, bench.id))?.body.startsWith('Easy'));
check('credentials were not restored from the file',
  (await db.getMeta('supabase_anon_key')) === 'SECRET-KEY');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
