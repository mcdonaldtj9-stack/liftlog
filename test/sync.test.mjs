/* Sync, against a fake Supabase.

   The interesting cases here are all failure modes: a token that expires
   mid-sync, an edit made while a push is in flight, a pull that would
   overwrite unpushed work. Those are the ones that lose a training log. */

import 'fake-indexeddb/auto';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------- a fake Supabase ---------- */

const server = {
  tables: new Map(),          // table -> Map(id -> row)
  requests: [],
  tokenSerial: 0,
  liveTokens: new Set(),
  refreshValid: true,
  failNextWith: null,
  offline: false,
  clock: 0,
};

const rowsOf = (table) => {
  if (!server.tables.has(table)) server.tables.set(table, new Map());
  return server.tables.get(table);
};

function issueToken() {
  const token = `token-${++server.tokenSerial}`;
  server.liveTokens.add(token);
  return token;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (url, options = {}) => {
  if (server.offline) throw new TypeError('Failed to fetch');

  const parsed = new URL(url);
  const path = parsed.pathname;
  const body = options.body ? JSON.parse(options.body) : null;
  server.requests.push({ path, search: parsed.search, method: options.method, body });

  if (server.failNextWith) {
    const status = server.failNextWith;
    server.failNextWith = null;
    return json({ message: 'boom' }, status);
  }

  // auth
  if (path === '/auth/v1/token') {
    if (parsed.searchParams.get('grant_type') === 'password') {
      if (body.password !== 'correct-horse') return json({ error_description: 'Bad login' }, 400);
      return json({
        access_token: issueToken(), refresh_token: 'refresh-1',
        expires_in: 3600, user: { email: body.email },
      });
    }
    if (!server.refreshValid) return json({ msg: 'bad refresh' }, 400);
    return json({
      access_token: issueToken(), refresh_token: 'refresh-1',
      expires_in: 3600, user: { email: 'lifter@example.com' },
    });
  }

  // everything below needs a live token
  const auth = (options.headers?.Authorization || '').replace('Bearer ', '');
  if (!server.liveTokens.has(auth)) return json({ message: 'JWT expired' }, 401);

  const table = path.replace('/rest/v1/', '');

  if (options.method === 'POST') {
    for (const row of body) {
      rowsOf(table).set(row.id, { ...row, server_updated_at: nextStamp() });
    }
    // Lets a test edit the local database while a push is in flight.
    if (server.afterPush) await server.afterPush(table, body);
    return new Response(null, { status: 201 });
  }

  const since = parsed.searchParams.get('server_updated_at')?.replace('gt.', '') || null;
  const limit = Number(parsed.searchParams.get('limit') || 500);
  const all = [...rowsOf(table).values()]
    .filter((row) => !since || row.server_updated_at > since)
    .sort((a, b) => a.server_updated_at.localeCompare(b.server_updated_at));
  return json(all.slice(0, limit));
};

function nextStamp() {
  server.clock++;
  return new Date(Date.UTC(2026, 0, 1) + server.clock * 1000).toISOString();
}

/* Put a row on the server as though another device wrote it. */
function seedRemote(table, row) {
  rowsOf(table).set(row.id, { deleted: 0, ...row, server_updated_at: nextStamp() });
}

/* ---------- boot ---------- */

const db = await import('../js/db.js');
const supa = await import('../js/supa.js');
const sync = await import('../js/sync.js');
const store = await import('../js/store.js');

await store.init();

/* ---------- configuration and auth ---------- */

check('sync is inert before configuration',
  (await sync.syncNow()).reason === 'unconfigured');

await supa.setConfig({ url: 'https://demo.supabase.co/', anonKey: 'anon-key' });
check('trailing slashes are trimmed from the url',
  (await supa.getConfig()).url === 'https://demo.supabase.co');
check('configured now', await supa.isConfigured());

check('sync is inert while signed out',
  (await sync.syncNow()).reason === 'signed-out');

let rejected = null;
try {
  await supa.signIn('lifter@example.com', 'wrong');
} catch (error) {
  rejected = error;
}
check('a bad password is rejected', rejected instanceof supa.AuthError);
check('and leaves no session', (await supa.getSession()) === null);

await supa.signIn('lifter@example.com', 'correct-horse');
const session = await supa.getSession();
check('signing in stores a session', Boolean(session?.access_token));
check('and remembers the email', session.email === 'lifter@example.com');
check('and stores an absolute expiry', session.expires_at > Date.now());

/* ---------- push ---------- */

const workout = await store.startWorkout();
const bench = (await store.listExercises()).find((e) => e.name === 'Barbell Bench Press');
await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 185, reps: 8, rpe: 8.5 });

const before = await sync.pendingCount();
check('local changes are pending before a sync', before > 0);

const first = await sync.syncNow();
check('the first sync succeeds', first.ok === true, JSON.stringify(first));
check('nothing is left pending', (await sync.pendingCount()) === 0);

const remoteSets = [...rowsOf('sets').values()];
check('the set reached the server', remoteSets.length === 1);
check('with its weight and reps', remoteSets[0].weight === 185 && remoteSets[0].reps === 8);
check('RPE halves survive the trip', remoteSets[0].rpe === 8.5);
check('local-only bookkeeping is not uploaded', !('dirty' in remoteSets[0]));
check('the server owns its own timestamp',
  !server.requests.some((r) => r.method === 'POST' && Array.isArray(r.body)
    && r.body.some((row) => 'server_updated_at' in row)));
check('user_id is left to the server',
  !remoteSets[0].user_id);

/* ---------- the dirty-clear race ---------- */

const raced = await store.addSet({
  workout_id: workout.id, exercise_id: bench.id, weight: 195, reps: 6,
});

// Edit the record while the push is in flight — exactly what a tap during a
// slow request does. The server has already accepted the old value by then, so
// only the per-record check stops the newer one being marked as synced.
let raceDone = false;
server.afterPush = async (table) => {
  if (raceDone || table !== 'sets') return;
  raceDone = true;
  const current = await db.get('sets', raced.id);
  await db.put('sets', { ...current, reps: 7, updated_at: db.nowISO(), dirty: 1 });
};

await sync.syncNow();
server.afterPush = null;
const afterRace = await db.get('sets', raced.id);
check('a set edited mid-push stays pending', afterRace.dirty === 1,
  `dirty=${afterRace.dirty}`);
check('and keeps the newer value', afterRace.reps === 7);

await sync.syncNow();
check('the next sync clears it', (await db.get('sets', raced.id)).dirty === 0);
check('and the server has the corrected value',
  rowsOf('sets').get(raced.id).reps === 7);

/* ---------- token expiry ---------- */

server.liveTokens.clear();          // every existing token is now rejected
await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 205, reps: 3 });
const afterExpiry = await sync.syncNow();
check('an expired token is refreshed and the sync completes',
  afterExpiry.ok === true, JSON.stringify(afterExpiry));
check('the refreshed session is stored',
  server.liveTokens.has((await supa.getSession()).access_token));

server.liveTokens.clear();
server.refreshValid = false;
const afterDeadRefresh = await sync.syncNow();
check('an unusable refresh token reports signed out',
  afterDeadRefresh.reason === 'signed-out');
check('and the session is cleared', (await supa.getSession()) === null);

server.refreshValid = true;
await supa.signIn('lifter@example.com', 'correct-horse');

/* ---------- pull ---------- */

seedRemote('exercises', {
  id: 'remote-ex', name: 'Remote Machine', name_key: 'remote machine',
  muscle_group: 'Back', tracks: 'weight_reps', is_custom: 1,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
});

await sync.syncNow();
check('a remote exercise arrives locally',
  (await store.listExercises()).some((e) => e.id === 'remote-ex'));
check('and is not marked as needing a push',
  (await db.get('exercises', 'remote-ex')).dirty === 0);

// Remote edit beats untouched local.
seedRemote('exercises', {
  ...rowsOf('exercises').get('remote-ex'),
  name: 'Renamed Remotely', updated_at: '2026-06-01T00:00:00.000Z',
});
await sync.syncNow();
check('a newer remote edit wins over clean local data',
  (await db.get('exercises', 'remote-ex')).name === 'Renamed Remotely');

// Local edit beats remote, because it hasn't been pushed yet.
const contested = await db.get('exercises', 'remote-ex');
await db.put('exercises', {
  ...contested, name: 'Renamed On Phone', updated_at: '2026-03-01T00:00:00.000Z', dirty: 1,
});
seedRemote('exercises', {
  ...rowsOf('exercises').get('remote-ex'),
  name: 'Renamed Remotely Again', updated_at: '2026-09-01T00:00:00.000Z',
});
await sync.syncNow();
check('unpushed local work is never overwritten by a pull',
  (await db.get('exercises', 'remote-ex')).name === 'Renamed On Phone');
check('and the push then settles it',
  rowsOf('exercises').get('remote-ex').name === 'Renamed On Phone');

// Tombstones propagate.
seedRemote('places', {
  id: 'remote-place', name: 'Somewhere Else', lat: null, lng: null, radius_m: 250,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted: 0,
});
await sync.syncNow();
check('a remote place arrives', (await store.listPlaces()).some((p) => p.id === 'remote-place'));

seedRemote('places', {
  ...rowsOf('places').get('remote-place'),
  deleted: 1, updated_at: '2026-06-01T00:00:00.000Z',
});
await sync.syncNow();
check('a remote deletion removes it from the list',
  !(await store.listPlaces()).some((p) => p.id === 'remote-place'));
check('but the tombstone is kept so it can propagate further',
  (await db.get('places', 'remote-place'))?.deleted === 1);

/* ---------- paging ---------- */

for (let i = 0; i < 600; i++) {
  seedRemote('exercise_notes', {
    id: `bulk-${i}`, workout_id: workout.id, exercise_id: bench.id,
    body: `note ${i}`,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
}
server.requests.length = 0;
await sync.syncNow();
const noteReads = server.requests.filter(
  (r) => r.path === '/rest/v1/exercise_notes' && r.method === 'GET');
check('a large pull pages rather than truncating', noteReads.length >= 2,
  `${noteReads.length} reads`);
check('every row landed',
  (await db.getAll('exercise_notes')).filter((n) => n.id.startsWith('bulk-')).length === 600);

/* ---------- offline ---------- */

server.offline = true;
await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 215, reps: 2 });
const offline = await sync.syncNow();
check('going offline is reported, not thrown', offline.ok === false && offline.reason === 'offline');
check('and the work stays pending', (await sync.pendingCount()) > 0);

server.offline = false;
const recovered = await sync.syncNow();
check('and goes up once there is signal again', recovered.ok === true);
check('leaving nothing pending', (await sync.pendingCount()) === 0);

/* ---------- a server error is surfaced, not swallowed ---------- */

await store.addSet({ workout_id: workout.id, exercise_id: bench.id, weight: 225, reps: 1 });
server.failNextWith = 500;
const errored = await sync.syncNow();
check('a server error is reported', errored.ok === false && errored.reason === 'error');
check('and recorded for the status line', Boolean((await sync.status()).lastError));
check('and the work is still pending', (await sync.pendingCount()) > 0);

const healthy = await sync.syncNow();
check('a later sync recovers', healthy.ok === true);
check('and clears the recorded error', (await sync.status()).lastError === null);

const finalStatus = await sync.status();
check('status reports a signed-in account', finalStatus.signedIn && finalStatus.email);
check('and a last-synced time', Boolean(finalStatus.lastSyncAt));
check('with nothing outstanding', finalStatus.pending === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
