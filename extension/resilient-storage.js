'use strict';

// chrome.storage.local sits on a LevelDB owned by the browser process. After a
// background write error (disk full, IO error) LevelDB keeps returning that same
// error for every later write until the browser restarts, and an extension reload
// does not reopen it. Reads keep working, so the extension used to go read-only.
//
// This wrapper keeps the chrome.storage.local get/set/remove contract. When a write
// fails with such a storage fault, the write is committed atomically to an
// IndexedDB overlay instead. Reads merge the overlay over the primary store. When
// the primary store accepts writes again, the overlay is copied back and cleared.
// Nothing is dropped, so the journal invariant "a failed write must not leave a
// silent gap" still holds, and a real failure (overlay unavailable too) still
// rejects exactly like before.
//
// The service worker and the popup each load their own copy of this wrapper. Every operation that can touch the overlay therefore runs under one
// origin-wide Web Lock, and the overlay content is re-read under that lock, so two
// contexts can never copy back, clear or overwrite each other's records.
(function resilientStorage() {
  const PROBE_KEY = 'chatgpt-resilient-storage:probe';
  const LOCK_NAME = 'chatgpt-resilient-storage';
  const FLUSH_CHUNK_KEYS = 100;
  const FLUSH_CHUNK_BYTES = 2 * 1024 * 1024;
  const PROBE_INTERVAL_MS = 60000;
  const CHANNEL_NAME = 'chatgpt-resilient-storage';
  const FAULT_PATTERN = /IO error|ChromeMethodBFE|NewWritableFile|Corruption|leveldb|No space left|ENOSPC|disk is full/i;

  function isStorageFault(error) {
    return FAULT_PATTERN.test(String(error?.message || error || ''));
  }

  function keyList(keys) {
    if (keys === null || keys === undefined) return null;
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys);
  }

  function approximateSize(value) {
    try { return JSON.stringify(value)?.length || 0; } catch { return 0; }
  }

  let warnedNoLocks = false;
  function defaultLock(fn) {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(LOCK_NAME, fn);
    // Chrome 116+ (the minimum version) always has Web Locks. Without them contexts
    // are only ordered inside themselves, so say so once.
    if (!warnedNoLocks) { warnedNoLocks = true; try { console.warn('ChatGPT storage: navigator.locks is unavailable, overlay access is not serialized across extension contexts.'); } catch {} }
    return fn();
  }

  // Overlay contract: entries() -> Map(key -> {deleted}|{value}, each with a `rev`);
  // lookup(keys) -> same for the given keys; commit([[key, record]]) is atomic and
  // stores the records as given; clear(Map(key -> rev)) deletes a key only while it
  // still carries that rev; hasRecords() -> boolean, constant time.
  function createIndexedDbOverlay({ indexedDB = globalThis.indexedDB, name = 'chatgpt-resilient-storage' } = {}) {
    const STORE = 'overlay';
    let opened = null;
    function open() {
      if (opened) return opened;
      opened = new Promise((resolve, reject) => {
        let request;
        // A synchronous throw must not leave a rejected promise cached forever.
        try { request = indexedDB.open(name, 1); } catch (error) { opened = null; reject(error); return; }
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opened = null; };
          db.onclose = () => { opened = null; };
          resolve(db);
        };
        request.onerror = () => { opened = null; reject(request.error || new Error('IndexedDB overlay could not be opened')); };
        request.onblocked = () => { opened = null; reject(new Error('IndexedDB overlay is blocked')); };
      });
      return opened;
    }
    async function transaction(mode, run) {
      let db = await open(), tx;
      try { tx = db.transaction(STORE, mode); } catch {
        // The connection was closed under us (InvalidStateError); reopen once.
        opened = null; db = await open(); tx = db.transaction(STORE, mode);
      }
      return new Promise((resolve, reject) => {
        const out = {};
        tx.oncomplete = () => resolve(out.value);
        tx.onerror = event => reject(tx.error || event?.target?.error || new Error('IndexedDB overlay transaction failed'));
        tx.onabort = event => reject(tx.error || event?.target?.error || new Error('IndexedDB overlay transaction aborted'));
        try { run(tx.objectStore(STORE), out); } catch (error) {
          // Requests queued before the throw must not commit: keep the batch atomic.
          try { tx.abort(); } catch {}
          reject(error);
        }
      });
    }
    const toRecord = row => (row.deleted ? { deleted: true, rev: row.rev } : { value: row.value, rev: row.rev });
    return {
      entries: () => transaction('readonly', (store, out) => {
        store.getAll().onsuccess = event => { out.value = new Map(event.target.result.map(row => [row.key, toRecord(row)])); };
      }),
      lookup: keys => transaction('readonly', (store, out) => {
        out.value = new Map();
        for (const key of keys) store.get(key).onsuccess = event => { if (event.target.result) out.value.set(key, toRecord(event.target.result)); };
      }),
      commit: items => transaction('readwrite', store => {
        for (const [key, record] of items) store.put(record.deleted ? { key, deleted: true, rev: record.rev } : { key, deleted: false, value: record.value, rev: record.rev });
      }),
      clear: revisions => transaction('readwrite', store => {
        for (const [key, rev] of revisions) store.get(key).onsuccess = event => { if (event.target.result?.rev === rev) store.delete(key); };
      }),
      hasRecords: () => transaction('readonly', (store, out) => { store.openKeyCursor().onsuccess = event => { out.value = Boolean(event.target.result); }; })
    };
  }

  function create({ primary, overlay, channel = null, now = Date.now, probeIntervalMs = PROBE_INTERVAL_MS, lock = defaultLock, onStateChange = () => {}, onOverlayWrite = () => {} }) {
    const state = { degraded: false, since: 0, reason: '', lastProbeAt: 0, unknown: false };
    let tail = Promise.resolve();
    // One operation at a time per context, and one per origin through the Web Lock,
    // so overlay commits, reads and the copy-back are strictly ordered.
    const exclusive = fn => { const run = tail.then(() => lock(fn)); tail = run.catch(() => {}); return run; };
    const emit = () => { try { onStateChange({ ...state }); } catch {} };
    const revision = () => `${now()}-${Math.random().toString(36).slice(2)}`;

    // Re-reads the overlay. Must run under the lock. When the overlay cannot be read
    // its content is unknown, and writes are refused until it can be.
    async function refresh() {
      if (!overlay) return;
      let next;
      try { next = await overlay.hasRecords(); } catch (error) {
        state.unknown = true; state.reason = `IndexedDB overlay unreadable: ${String(error?.message || error)}`;
        return;
      }
      if (state.unknown) { state.unknown = false; if (!state.degraded) state.reason = ''; }
      if (next === state.degraded) return;
      state.degraded = next;
      if (next) { state.since = now(); state.reason = 'IndexedDB overlay holds records not yet copied back'; } else { state.since = 0; state.reason = ''; }
      emit();
    }

    async function copyBack() {
      const rows = await overlay.entries();
      const sets = [], removes = [];
      for (const [key, record] of rows) (record.deleted ? removes : sets).push([key, record.value]);
      let chunk = {}, count = 0, bytes = 0;
      const flushChunk = async () => { if (count) { await primary.set(chunk); chunk = {}; count = 0; bytes = 0; } };
      for (const [key, value] of sets) {
        chunk[key] = value; count += 1; bytes += approximateSize(value);
        if (count >= FLUSH_CHUNK_KEYS || bytes >= FLUSH_CHUNK_BYTES) await flushChunk();
      }
      await flushChunk();
      for (let i = 0; i < removes.length; i += FLUSH_CHUNK_KEYS) await primary.remove(removes.slice(i, i + FLUSH_CHUNK_KEYS).map(([key]) => key));
      await overlay.clear(new Map([...rows].map(([key, record]) => [key, record.rev])));
      // A record that changed after the snapshot keeps its newer rev and stays.
      return !(await overlay.hasRecords());
    }

    // Returns true when the primary store is writable and the overlay is empty.
    // Must run under the lock.
    async function tryRecover(force) {
      if (!state.degraded) return true;
      if (!force && now() - state.lastProbeAt < probeIntervalMs) return false;
      state.lastProbeAt = now();
      try {
        await primary.set({ [PROBE_KEY]: state.lastProbeAt });
        if (!(await copyBack())) return false;
      } catch { return false; }
      primary.remove(PROBE_KEY).catch(() => {});
      state.degraded = false; state.since = 0; state.reason = '';
      emit();
      try { channel?.postMessage('flushed'); } catch {}
      return true;
    }

    // Takes the lock directly: every other operation awaits `ready` first, so none of
    // them can be waiting on the per-context queue while this runs.
    const ready = (async () => {
      try {
        await lock(async () => {
          await refresh();
          if (state.degraded) await tryRecover(true).catch(() => {});
        });
      } catch {}
    })();
    let refreshQueued = false;
    // Many writes in another context produce many messages; one refresh covers them all.
    if (channel) channel.onmessage = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      ready.then(() => exclusive(() => { refreshQueued = false; return refresh(); })).catch(() => { refreshQueued = false; });
    };

    async function mergedGet(keys) {
      const list = keyList(keys);
      const objectKeys = keys !== null && typeof keys === 'object' && !Array.isArray(keys);
      // Overlay first: the lock keeps it from changing, and a copy-back can never
      // make the primary read older than the overlay read.
      const rows = list === null ? await overlay.entries() : await overlay.lookup(list);
      const base = await primary.get(objectKeys ? list : keys);
      for (const [key, record] of rows) { if (record.deleted) delete base[key]; else base[key] = record.value; }
      if (objectKeys) for (const [key, fallback] of Object.entries(keys)) if (!Object.hasOwn(base, key)) base[key] = fallback;
      return base;
    }

    async function write(applyPrimary, records) {
      // Other contexts may have written to or drained the overlay since last time.
      await refresh();
      if (state.unknown) throw new Error(`${state.reason}; write refused so it cannot be overtaken by older overlay records`);
      if (state.degraded) await tryRecover(false);
      let primaryError = null;
      if (!state.degraded) {
        try { await applyPrimary(); return; } catch (error) {
          if (!overlay || !isStorageFault(error)) throw error;
          primaryError = error;
        }
      }
      const rev = revision();
      try { await overlay.commit(records.map(([key, record]) => [key, { ...record, rev }])); } catch (overlayError) { throw primaryError || overlayError; }
      if (!state.degraded) {
        state.degraded = true; state.since = now(); state.reason = String(primaryError?.message || primaryError);
        emit();
      }
      try { channel?.postMessage('written'); } catch {}
      try { onOverlayWrite(records.map(([key]) => key)); } catch {}
    }

    return Object.freeze({
      async get(keys) {
        await ready;
        if (!state.degraded) {
          // Read-your-writes within this context.
          await tail;
          if (!state.degraded) return primary.get(keys);
        }
        return exclusive(async () => (state.degraded ? mergedGet(keys) : primary.get(keys)));
      },
      set(items) {
        return ready.then(() => exclusive(() => write(() => primary.set(items), Object.entries(items).map(([key, value]) => [key, { value }]))));
      },
      remove(keys) {
        const list = keyList(keys) || [];
        return ready.then(() => exclusive(() => write(() => primary.remove(keys), list.map(key => [key, { deleted: true }]))));
      },
      recover: () => ready.then(() => exclusive(async () => { await refresh(); return state.unknown ? false : tryRecover(true); })),
      status: () => ({ ...state })
    });
  }

  // Decorates chrome.storage.local in place, so every existing caller (and storage
  // handed to other modules) gets the fallback without any call-site change. Only
  // get/set/remove are intercepted; everything else (onChanged, getBytesInUse, ...)
  // is delegated to the real area. clear() is intentionally not mirrored: nothing
  // here calls it, and a clear that skipped the overlay would resurrect old keys.
  const INSTALLED = Symbol.for('chatgpt.resilientStorage');
  function install() {
    const storage = globalThis.chrome?.storage;
    const area = storage?.local;
    if (!area) return null;
    if (area[INSTALLED]) return area[INSTALLED];
    let overlay = null, channel = null;
    try { if (globalThis.indexedDB) overlay = createIndexedDbOverlay(); } catch {}
    try { if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(CHANNEL_NAME); } catch {}
    const store = create({
      primary: area, overlay, channel,
      onStateChange: ({ degraded, reason }) => {
        if (degraded) console.warn('ChatGPT storage: chrome.storage.local rejects writes, using IndexedDB overlay.', reason);
        else console.info('ChatGPT storage: chrome.storage.local writable again, overlay copied back.');
        try {
          globalThis.chrome.action?.setBadgeText?.({ text: degraded ? '!' : '' });
          if (degraded) globalThis.chrome.action?.setBadgeBackgroundColor?.({ color: '#d93025' });
        } catch {}
      },
      // Content scripts listen to storage.onChanged; overlay writes never fire it.
      onOverlayWrite: keys => {
        const goalKeys = keys.filter(key => key.startsWith('chatgpt-goal'));
        if (!goalKeys.length || !globalThis.chrome?.tabs?.query) return;
        globalThis.chrome.tabs.query({ url: 'https://chatgpt.com/*' }).then(tabs => {
          for (const tab of tabs) globalThis.chrome.tabs.sendMessage(tab.id, { type: 'CHATGPT_STORAGE_OVERLAY_CHANGED', keys: goalKeys }).catch(() => {});
        }).catch(() => {});
      }
    });
    const intercepted = { get: store.get, set: store.set, remove: store.remove, [INSTALLED]: store };
    const decorated = new Proxy(area, {
      get(target, property) {
        if (Object.hasOwn(intercepted, property)) return intercepted[property];
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    Object.defineProperty(storage, 'local', { value: decorated, configurable: true, writable: true, enumerable: true });
    return store;
  }

  const api = { create, createIndexedDbOverlay, isStorageFault, PROBE_KEY };
  if (typeof module !== 'undefined') module.exports = api;
  else {
    // A failure here must never stop the service worker from starting: without the
    // wrapper the extension behaves exactly as before.
    let store = null;
    try { store = install(); } catch (error) { console.error('ChatGPT storage: resilient storage disabled', error); }
    globalThis.ChatGPTStorage = Object.freeze({ ...api, install, status: () => store?.status() || null, recover: () => store?.recover() });
  }
})();
