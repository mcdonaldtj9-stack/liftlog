/* Push local changes up, pull remote changes down.

   Rules, in the order they matter:

   1. Local is the source of truth for what you just did. A pull never
      overwrites a record with unpushed edits — your set wins, and the next
      push settles it. Losing a logged set to a background sync is exactly the
      failure this whole app exists to avoid.

   2. `dirty` is cleared per record, only if that record hasn't changed since
      it was pushed. Clearing in bulk would silently drop an edit made while
      the request was in flight.

   3. The pull watermark is the server's own clock, taken from the last row of
      the last page. A wrong clock on the phone can't skip rows, and resuming
      mid-sync can't miss them.

   4. Nothing here ever blocks the UI or throws at the caller. Sync failing is
      a normal state at a gym, not an error. */

import * as db from './db.js';
import * as supa from './supa.js';

/* Local store -> remote table, plus the columns that actually travel.
   `dirty` is deliberately absent: it's local bookkeeping, not data. */
const TABLES = [
  ['exercises', 'exercises',
    ['id', 'name', 'name_key', 'muscle_group', 'tracks', 'is_custom']],
  ['places', 'places',
    ['id', 'name', 'lat', 'lng', 'radius_m']],
  ['templates', 'templates',
    ['id', 'name', 'place_id', 'position']],
  ['template_exercises', 'template_exercises',
    ['id', 'template_id', 'exercise_id', 'position', 'target_sets', 'target_reps']],
  ['workouts', 'workouts',
    ['id', 'started_at', 'ended_at', 'place_id', 'template_id', 'plan', 'notes']],
  ['sets', 'sets',
    ['id', 'workout_id', 'exercise_id', 'set_index', 'weight', 'reps', 'seconds',
     'rpe', 'failed', 'is_warmup', 'is_dropset']],
  ['exercise_notes', 'exercise_notes',
    ['id', 'workout_id', 'exercise_id', 'body']],
  ['bodyweights', 'bodyweights',
    ['id', 'weighed_at', 'lbs', 'place_id']],
];

const COMMON = ['created_at', 'updated_at', 'deleted'];
const PUSH_BATCH = 200;
const PULL_PAGE = 500;

let running = null;

/* ---------- shaping ---------- */

function toRow(record, columns) {
  const row = {};
  for (const column of [...columns, ...COMMON]) {
    let value = record[column];
    if (value === undefined) value = null;
    // Flags are 0/1 locally and smallint remotely; older rows predate some
    // of these fields entirely.
    if (['is_custom', 'failed', 'is_warmup', 'is_dropset', 'deleted'].includes(column)) {
      value = value ? 1 : 0;
    }
    row[column] = value;
  }
  // user_id and server_updated_at are the server's to set, never ours.
  return row;
}

function fromRow(row, columns) {
  const record = {};
  for (const column of [...columns, ...COMMON]) {
    record[column] = row[column] ?? null;
  }
  for (const flag of ['is_custom', 'failed', 'is_warmup', 'is_dropset', 'deleted']) {
    if (flag in record) record[flag] = record[flag] ? 1 : 0;
  }
  record.dirty = 0;
  return record;
}

/* ---------- push ---------- */

async function pushStore(store, table, columns) {
  const all = await db.getAll(store);
  const pending = all.filter((record) => record.dirty);
  if (!pending.length) return 0;

  let pushed = 0;

  for (let i = 0; i < pending.length; i += PUSH_BATCH) {
    const batch = pending.slice(i, i + PUSH_BATCH);
    await supa.upsert(table, batch.map((record) => toRow(record, columns)));

    // Only now is it safe to clear the flag, and only for records that haven't
    // been touched since we read them. Anything edited mid-flight stays dirty
    // and goes up on the next pass.
    for (const snapshot of batch) {
      const current = await db.get(store, snapshot.id);
      if (current && current.updated_at === snapshot.updated_at && current.dirty) {
        await db.put(store, { ...current, dirty: 0 });
      }
      pushed++;
    }
  }

  return pushed;
}

/* ---------- pull ---------- */

async function pullStore(store, table, columns) {
  const watermarkKey = `sync_watermark_${table}`;
  let since = await db.getMeta(watermarkKey, null);
  let applied = 0;

  for (;;) {
    const rows = await supa.selectSince(table, since, PULL_PAGE);
    if (!rows.length) break;

    for (const row of rows) {
      const incoming = fromRow(row, columns);
      const local = await db.get(store, incoming.id);

      // Keep local when it has unpushed edits: what you did on the phone beats
      // what the server last heard, and the next push reconciles it.
      if (local?.dirty) continue;
      if (local && !(incoming.updated_at > local.updated_at)) continue;

      await db.put(store, incoming);
      applied++;
    }

    since = rows[rows.length - 1].server_updated_at;
    await db.setMeta(watermarkKey, since);

    if (rows.length < PULL_PAGE) break;
  }

  return applied;
}

/* ---------- the whole thing ---------- */

export async function pendingCount() {
  let total = 0;
  for (const [store] of TABLES) {
    const all = await db.getAll(store);
    total += all.filter((record) => record.dirty).length;
  }
  return total;
}

export async function status() {
  const configured = await supa.isConfigured();
  const session = await supa.getSession();
  return {
    configured,
    signedIn: Boolean(session),
    email: session?.email ?? null,
    lastSyncAt: await db.getMeta('sync_last_at', null),
    lastError: await db.getMeta('sync_last_error', null),
    pending: await pendingCount(),
  };
}

/* Never throws. Returns a result object the UI can render as a status line. */
export async function syncNow() {
  if (running) return running;

  running = (async () => {
    if (!(await supa.isConfigured())) {
      return { ok: false, reason: 'unconfigured' };
    }
    if (!(await supa.getSession())) {
      return { ok: false, reason: 'signed-out' };
    }

    let pushed = 0;
    let pulled = 0;

    try {
      for (const [store, table, columns] of TABLES) {
        pushed += await pushStore(store, table, columns);
      }
      for (const [store, table, columns] of TABLES) {
        pulled += await pullStore(store, table, columns);
      }

      await db.setMeta('sync_last_at', db.nowISO());
      await db.setMeta('sync_last_error', null);
      return { ok: true, pushed, pulled };
    } catch (error) {
      if (error instanceof supa.OfflineError) {
        return { ok: false, reason: 'offline' };
      }
      if (error instanceof supa.AuthError) {
        await db.setMeta('sync_last_error', error.message);
        return { ok: false, reason: 'signed-out', message: error.message };
      }
      await db.setMeta('sync_last_error', error.message || String(error));
      return { ok: false, reason: 'error', message: error.message || String(error) };
    }
  })().finally(() => { running = null; });

  return running;
}

/* Forget every watermark so the next sync re-reads everything. Used after
   signing in on a fresh install, where the local database is empty but the
   watermarks from a previous account would otherwise skip the whole history. */
export async function resetWatermarks() {
  for (const [, table] of TABLES) {
    await db.setMeta(`sync_watermark_${table}`, null);
  }
}
