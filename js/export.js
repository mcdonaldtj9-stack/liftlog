/* Export and import: a copy of everything that you hold yourself, independent
   of this phone and of Supabase.

   The backup is a snapshot of every domain table INCLUDING deletion markers,
   so restoring an old backup can never bring back a set you deleted since.
   It deliberately excludes `meta`, which holds the Supabase session and key —
   a backup file ends up in iCloud Drive, email and chat, and credentials have
   no business travelling with it.

   Import merges, never replaces. A record comes in only if it's new or newer
   than what's on the phone — the same rule sync uses — and everything applied
   is marked for upload so Supabase catches up. */

import * as db from './db.js';

export const FORMAT = 1;

/* Every table a backup carries. `meta` is absent on purpose. */
export const TABLES = [
  'exercises', 'places', 'templates', 'template_exercises',
  'workouts', 'sets', 'exercise_notes', 'bodyweights',
];

/* ---------- building ---------- */

export function buildBackup(tables, { build = null, now = new Date() } = {}) {
  const out = {};
  for (const name of TABLES) {
    // `dirty` is this phone's upload bookkeeping, not data.
    out[name] = (tables[name] || []).map(({ dirty, ...rest }) => rest);
  }
  return {
    app: 'liftlog',
    format: FORMAT,
    exported_at: now.toISOString(),
    build,
    tables: out,
  };
}

export function datedName(prefix, extension, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${extension}`;
}

/* One CSV cell. Quotes anything with a comma, quote or newline, and defuses
   text a spreadsheet would run as a formula: an exercise named "=HYPERLINK(...)"
   must arrive as text, not as something clickable. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows) {
  // CRLF and a byte-order mark: what Excel and Numbers both open cleanly.
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const live = (rows = []) => rows.filter((r) => !r.deleted);

function localDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* Every live set as a flat row, with names rather than ids, in the order
   they were lifted. */
export function buildSetsCSV(tables) {
  const byId = (rows) => new Map(live(rows).map((r) => [r.id, r]));
  const workouts = byId(tables.workouts);
  const exercises = byId(tables.exercises);
  const places = byId(tables.places);
  const templates = byId(tables.templates);
  const notes = new Map(live(tables.exercise_notes)
    .map((n) => [`${n.workout_id}|${n.exercise_id}`, n.body]));

  const sets = live(tables.sets)
    .filter((s) => workouts.has(s.workout_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const rows = [[
    'date', 'time', 'location', 'routine', 'exercise', 'muscle', 'set',
    'weight_lbs', 'reps', 'seconds', 'rpe', 'failed', 'warmup', 'drop_set', 'note',
  ]];
  const noted = new Set();

  for (const set of sets) {
    const workout = workouts.get(set.workout_id);
    const exercise = exercises.get(set.exercise_id);
    const key = `${set.workout_id}|${set.exercise_id}`;
    // The note belongs to the exercise for the session; print it once.
    const note = noted.has(key) ? '' : (notes.get(key) || '');
    noted.add(key);

    rows.push([
      localDate(set.created_at),
      localTime(set.created_at),
      places.get(workout.place_id)?.name || '',
      templates.get(workout.template_id)?.name || '',
      exercise?.name || '(deleted exercise)',
      exercise?.muscle_group || '',
      set.set_index ?? '',
      set.weight ?? '',
      set.reps ?? '',
      set.seconds ?? '',
      set.rpe ?? '',
      set.failed ? 'yes' : '',
      set.is_warmup ? 'yes' : '',
      set.is_dropset ? 'yes' : '',
      note,
    ]);
  }
  return csv(rows);
}

export function buildWeightsCSV(tables) {
  const places = new Map(live(tables.places).map((p) => [p.id, p]));
  const rows = [['date', 'time', 'weight_lbs', 'scale']];
  for (const r of live(tables.bodyweights).sort((a, b) => a.weighed_at.localeCompare(b.weighed_at))) {
    rows.push([
      localDate(r.weighed_at),
      localTime(r.weighed_at),
      r.lbs,
      places.get(r.place_id)?.name || 'Other scale',
    ]);
  }
  return csv(rows);
}

/* ---------- reading a backup ---------- */

export class ImportError extends Error {}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("That file isn't a LiftLog backup (it isn't valid JSON).");
  }
  if (!data || data.app !== 'liftlog' || !data.tables) {
    throw new ImportError("That file isn't a LiftLog backup.");
  }
  if (!(data.format <= FORMAT)) {
    throw new ImportError('That backup is from a newer version of LiftLog. Update the app, then try again.');
  }
  for (const name of TABLES) {
    const rows = data.tables[name] ?? [];
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string' || !r.updated_at)) {
      throw new ImportError(`The backup's ${name.replace('_', ' ')} are damaged.`);
    }
  }
  return data;
}

/* What an import would change, without changing anything. A record is taken
   when the phone doesn't have it, or the backup's copy is strictly newer.
   Unpushed edits on the phone are newer by construction and so survive. */
export function planImport(backup, localTables) {
  const plan = {};
  const counts = {};
  for (const name of TABLES) {
    const local = new Map((localTables[name] || []).map((r) => [r.id, r]));
    const incoming = backup.tables[name] || [];
    plan[name] = incoming.filter((row) => {
      const mine = local.get(row.id);
      return !mine || row.updated_at > mine.updated_at;
    });
    counts[name] = plan[name].length;
  }
  return { plan, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/* ---------- the database side ---------- */

export async function readAll() {
  const tables = {};
  for (const name of TABLES) tables[name] = await db.getAll(name);
  return tables;
}

export async function applyImport(plan) {
  let applied = 0;
  for (const name of TABLES) {
    const rows = plan[name] || [];
    if (!rows.length) continue;
    // Marked for upload so Supabase ends up with what the phone now has.
    await db.putMany(name, rows.map((row) => ({ ...row, dirty: 1 })));
    applied += rows.length;
  }
  await db.setMeta('last_import_at', db.nowISO());
  return applied;
}

/* ---------- sharing ---------- */

/* Offer files to the iOS share sheet. MUST be called directly from a tap
   handler with the File objects already built: any await before this and iOS
   decides the tap no longer counts, and refuses. */
export function share(files, title) {
  if (typeof navigator === 'undefined' || !navigator.canShare?.({ files })) {
    return Promise.reject(new Error('unsupported'));
  }
  return navigator.share({ files, title });
}
