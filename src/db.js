// Event log in IndexedDB (database "calmfeed", store "events").
// Shared by the background worker (the only writer) and the dashboard
// (reads directly, same extension origin).
(function (root) {
  'use strict';

  const DB_NAME = 'calmfeed';
  const DB_VERSION = 1;
  const STORE = 'events';
  const SCHEMA_VERSION = 1;      // bump if the event shape changes (sync relies on it)
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_EVENTS = 20000;

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const st = req.result.createObjectStore(STORE, { keyPath: 'id' });
        st.createIndex('t', 't');
        st.createIndex('site', 'site');
        st.createIndex('filter', 'filter');
        st.createIndex('key', 'key');
        st.createIndex('site_key_t', ['site', 'key', 't']);   // dedup lookups
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        resolve(db);
      };
      req.onerror = () => { dbp = null; reject(req.error); };
    });
    return dbp;
  }

  const done = (tx) => new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // Normalise a raw event from a content script into the stored schema.
  function makeEvent(raw, { logText = true } = {}) {
    const t = Number(raw.t) || Date.now();
    return {
      schemaVersion: SCHEMA_VERSION,
      id: (crypto.randomUUID && crypto.randomUUID()) || `${t.toString(36)}-${Math.random().toString(36).slice(2)}`,
      t,
      site: String(raw.site || ''),
      filter: String(raw.filter || ''),
      source: String(raw.source || ''),
      score: Number(raw.score) || 0,
      scores: raw.scores || {},
      reasons: Array.isArray(raw.reasons) ? raw.reasons.slice(0, 12).map(String) : [],
      author: String(raw.author || '').slice(0, 80),
      text: logText ? String(raw.text || '').slice(0, 500) : '',
      url: raw.url || null,
      key: String(raw.key || ''),
      restored: false,
      seenCount: 1,
      lastSeen: t
      // audit?: { model, r, s, why, t }   — reserved for a later LLM review pass
    };
  }

  // Write a batch. The same key on the same site within 24 h bumps seenCount
  // on the existing event instead of adding a new one.
  async function writeBatch(events) {
    if (!events.length) return;
    const merged = new Map();
    for (const e of events) {
      const k = `${e.site}|${e.key}`;
      const m = merged.get(k);
      if (m) { m.seenCount += e.seenCount; m.lastSeen = Math.max(m.lastSeen, e.lastSeen); } else merged.set(k, e);
    }
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const idx = st.index('site_key_t');
    for (const e of merged.values()) {
      const range = IDBKeyRange.bound([e.site, e.key, e.t - DAY], [e.site, e.key, Infinity]);
      const cur = await req(idx.openCursor(range, 'prev'));
      if (cur) {
        const ex = cur.value;
        ex.seenCount = (ex.seenCount || 1) + e.seenCount;
        ex.lastSeen = Math.max(ex.lastSeen || ex.t, e.lastSeen);
        cur.update(ex);
      } else {
        st.put(e);
      }
    }
    await done(tx);
  }

  // Apply fn to the newest event for site+key (or by id); fn mutates it.
  async function updateLatest({ id, site, key }, fn) {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    let ev = null;
    if (id) {
      ev = await req(st.get(id));
    } else {
      const cur = await req(st.index('site_key_t').openCursor(
        IDBKeyRange.bound([site, key, -Infinity], [site, key, Infinity]), 'prev'));
      ev = cur ? cur.value : null;
    }
    if (ev) { fn(ev); st.put(ev); }
    await done(tx);
    return ev;
  }

  // All events with from <= t <= to, newest first.
  async function range(from, to) {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const all = await req(tx.objectStore(STORE).index('t').getAll(IDBKeyRange.bound(from || 0, to || Infinity)));
    return all.reverse();
  }

  async function count() {
    const db = await open();
    return req(db.transaction(STORE, 'readonly').objectStore(STORE).count());
  }

  // Drop events older than retentionDays (0 = keep forever), then cap at MAX_EVENTS.
  async function prune(retentionDays, max = MAX_EVENTS) {
    const db = await open();
    let removed = 0;
    // index.getAllKeys returns primary keys (ids), oldest first.
    const drop = async (rangeArg, limit) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const ids = await req(st.index('t').getAllKeys(rangeArg, limit));
      for (const id of ids) st.delete(id);
      await done(tx);
      removed += ids.length;
    };
    if (retentionDays > 0) await drop(IDBKeyRange.upperBound(Date.now() - retentionDays * DAY));
    const n = await count();
    if (n > max) await drop(null, n - max);
    return removed;
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  }

  root.RBF_DB = { open, makeEvent, writeBatch, updateLatest, range, count, prune, clear, SCHEMA_VERSION, MAX_EVENTS };
})(globalThis);
