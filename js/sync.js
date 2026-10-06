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
    ['id', 'name', 'name_key', 'muscle_group', 'tracks', 'is_custom', 'rest_seconds']],
  ['places', 'places',
    ['id', 'name', 'lat', 'lng', 'radius_m', 'accuracy_m', 'located_at', 'for_weight']],
  ['templates', 'templates',
    ['id', 'name', 'place_id', 'position', 'archived']],
  ['template_exercises', 'template_exercises',
    ['id', 'template_id', 'exercise_id', 'position', 'target_sets', 'target_reps']],
  ['workouts', 'workouts',
    ['id', 'started_at', 'ended_at', 'place_id', 'template_id', 'plan', 'notes']],
  ['sets', 'sets',
    ['id', 'workout_id', 'exercise_id', 'set_index', 'weight', 'reps', 'seconds',
     'rpe', 'failed', 'is_warmup', 'is_dropset', 'is_pr']],
  ['exercise_notes', 'exercise_notes',
    ['id', 'workout_id', 'exercise_id', 'body']],
  ['bodyweights', 'bodyweights',
    ['id', 'weighed_at', 'lbs', 'place_id']],
  ['settings', 'settings',
    ['id', 'key', 'value']],
];

/* Progress photos sync apart from the rest: the table is new enough that an
   older server may not have it, and the bytes are heavy and go to Storage.
   Neither is allowed to stop a logged set from going up. */
const PHOTOS = ['photos', 'photos',
  ['id', 'taken_at', 'pose', 'note', 'width', 'height', 'bytes']];
export const PHOTO_BUCKET = 'progress-photos';

const COMMON = ['created_at', 'updated_at', 'deleted'];

/* 0/1 locally, smallint NOT NULL remotely. Older records predate some of
   these entirely, and a missing one must go up as 0, never as null. */
const FLAGS = ['is_custom', 'failed', 'is_warmup', 'is_dropset', 'is_pr', 'deleted',
  'for_weight', 'archived'];
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
    if (FLAGS.includes(column)) {
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
  for (const flag of FLAGS) {
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

/* ---------- photo bytes ---------- */

const photoPath = (userId, photo) => `${userId}/${photo.id}.jpg`;

/* Upload bytes this phone took, fetch bytes another device took, and remove
   the Storage copy of anything deleted. One photo failing is noted and the
   rest carry on; only being offline or signed out stops the pass. */
async function syncPhotoBytes() {
  const userId = await supa.userId();
  if (!userId) return { uploaded: 0, downloaded: 0, error: 'No user id in the session' };

  let uploaded = 0;
  let downloaded = 0;
  let error = null;

  for (const photo of await db.getAll('photos')) {
    try {
      const blobs = await db.get('photo_blobs', photo.id);

      if (photo.deleted) {
        if (blobs) {
          await supa.storageDelete(PHOTO_BUCKET, photoPath(userId, photo));
          await db.hardDelete('photo_blobs', photo.id);
        }
        continue;
      }

      if (blobs?.full) {
        if (!blobs.uploaded) {
          await supa.storageUpload(PHOTO_BUCKET, photoPath(userId, photo), blobs.full,
            blobs.mime || 'image/jpeg');
          const current = await db.get('photo_blobs', photo.id);
          if (current?.full) await db.put('photo_blobs', { ...current, uploaded: 1 });
          uploaded++;
        }
        continue;
      }

      // No bytes here: another device took it, or this is a restored backup.
      const bytes = await supa.storageDownload(PHOTO_BUCKET, photoPath(userId, photo));
      if (bytes) {
        await db.put('photo_blobs', {
          id: photo.id, mime: 'image/jpeg', full: bytes, thumb: null, uploaded: 1,
        });
        downloaded++;
      }
    } catch (err) {
      if (err instanceof supa.OfflineError || err instanceof supa.AuthError) throw err;
      error = error || err.message || String(err);
    }
  }

  return { uploaded, downloaded, error };
}

/* Photos, table and bytes, as one soft stage: a failure here is reported on
   the result and remembered, never thrown at the sets. */
async function syncPhotos() {
  const [store, table, columns] = PHOTOS;
  try {
    const pushed = await pushStore(store, table, columns);
    const pulled = await pullStore(store, table, columns);
    const bytes = await syncPhotoBytes();
    await db.setMeta('sync_photos_error', bytes.error);
    return { pushed, pulled, ...bytes };
  } catch (err) {
    if (err instanceof supa.OfflineError || err instanceof supa.AuthError) throw err;
    const message = /photos.*(404|Could not find)/s.test(err.message || '')
      ? 'photos need the server update (run supabase/photos.sql)'
      : err.message || String(err);
    await db.setMeta('sync_photos_error', message);
    return { pushed: 0, pulled: 0, uploaded: 0, downloaded: 0, error: message };
  }
}

/* ---------- the whole thing ---------- */

export async function pendingCount() {
  let total = 0;
  for (const [store] of [...TABLES, PHOTOS]) {
    const all = await db.getAll(store);
    total += all.filter((record) => record.dirty).length;
  }
  const blobs = await db.getAll('photo_blobs');
  total += blobs.filter((row) => row.full && !row.uploaded).length;
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
    photosError: await db.getMeta('sync_photos_error', null),
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

      // Last, and on its own: nothing about photos may fail the sets above.
      const photos = await syncPhotos();
      pushed += photos.pushed;
      pulled += photos.pulled;

      await db.setMeta('sync_last_at', db.nowISO());
      await db.setMeta('sync_last_error', null);
      return {
        ok: true, pushed, pulled,
        photosUploaded: photos.uploaded,
        photosDownloaded: photos.downloaded,
        photosError: photos.error || null,
      };
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
  for (const [, table] of [...TABLES, PHOTOS]) {
    await db.setMeta(`sync_watermark_${table}`, null);
  }
}
