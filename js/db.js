/* Minimal IndexedDB wrapper.
   Every record carries sync metadata (id / updated_at / dirty / deleted) from
   day one, so adding Supabase in step 4 is a new module rather than a migration.
   Booleans are stored as 0/1 because IndexedDB can't index true/false. */

const DB_NAME = 'liftlog';
const DB_VERSION = 1;

const SCHEMA = {
  exercises: {
    keyPath: 'id',
    indexes: { by_key: 'name_key', by_updated: 'updated_at', by_dirty: 'dirty' },
  },
  workouts: {
    keyPath: 'id',
    indexes: { by_started: 'started_at', by_updated: 'updated_at', by_dirty: 'dirty' },
  },
  sets: {
    keyPath: 'id',
    indexes: {
      by_workout: 'workout_id',
      by_exercise: 'exercise_id',
      by_updated: 'updated_at',
      by_dirty: 'dirty',
    },
  },
  meta: { keyPath: 'key', indexes: {} },
};

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, spec] of Object.entries(SCHEMA)) {
        const store = db.objectStoreNames.contains(name)
          ? request.transaction.objectStore(name)
          : db.createObjectStore(name, { keyPath: spec.keyPath });

        for (const [indexName, keyPath] of Object.entries(spec.indexes)) {
          if (!store.indexNames.contains(indexName)) {
            store.createIndex(indexName, keyPath);
          }
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });

  return dbPromise;
}

function run(storeNames, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    result = fn(tx);
  }));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------- reads ---------- */

export async function get(store, id) {
  const db = await open();
  return wrap(db.transaction(store, 'readonly').objectStore(store).get(id));
}

export async function getAll(store) {
  const db = await open();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function getAllByIndex(store, index, query) {
  const db = await open();
  const idx = db.transaction(store, 'readonly').objectStore(store).index(index);
  return wrap(idx.getAll(query));
}

/* ---------- writes ---------- */

export function put(store, record) {
  return run(store, 'readwrite', (tx) => {
    tx.objectStore(store).put(record);
    return record;
  });
}

export function putMany(store, records) {
  return run(store, 'readwrite', (tx) => {
    const objectStore = tx.objectStore(store);
    for (const record of records) objectStore.put(record);
    return records;
  });
}

/* Hard delete. Only for `meta` — domain records use tombstones so that a
   deletion can propagate to the server later. */
export function hardDelete(store, id) {
  return run(store, 'readwrite', (tx) => {
    tx.objectStore(store).delete(id);
  });
}

/* ---------- record helpers ---------- */

export function nowISO() {
  return new Date().toISOString();
}

export function newRecord(fields) {
  const now = nowISO();
  return {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    dirty: 1,
    deleted: 0,
    ...fields,
  };
}

export function touch(record, changes = {}) {
  return { ...record, ...changes, updated_at: nowISO(), dirty: 1 };
}

export function isLive(record) {
  return record && !record.deleted;
}

/* ---------- meta ---------- */

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return put('meta', { key, value });
}
