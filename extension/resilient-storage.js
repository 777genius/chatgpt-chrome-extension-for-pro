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
(function resilientStorage() {
  const PROBE_KEY = 'chatgpt-resilient-storage:probe';
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

  // Overlay contract: entries() -> Map(key -> {deleted}|{value}); lookup(keys) -> same
  // for the given keys; commit([[key, record]]) atomic; clear(keys); size().
  function createIndexedDbOverlay({ indexedDB = globalThis.indexedDB, name = 'chatgpt-resilient-storage' } = {}) {
    const STORE = 'overlay';
    let opened = null;
    function open() {
      if (opened) return opened;
      opened = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opened = null; };
          db.onclose = () => { opened = null; };
          resolve(db);
        };
        request.onerror = () => { opened = null; reject(request.error); };
        request.onblocked = () => { opened = null; reject(new Error('IndexedDB overlay is blocked')); };
      });
      return opened;
    }
    async function transaction(mode, run) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const out = {};
        tx.oncomplete = () => resolve(out.value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB overlay transaction aborted'));
        run(tx.objectStore(STORE), out);
      });
    }
    const toRecord = row => (row.deleted ? { deleted: true } : { value: row.value });
    return {
      entries: () => transaction('readonly', (store, out) => {
        store.getAll().onsuccess = event => { out.value = new Map(event.target.result.map(row => [row.key, toRecord(row)])); };
      }),
      lookup: keys => transaction('readonly', (store, out) => {
        out.value = new Map();
        for (const key of keys) store.get(key).onsuccess = event => { if (event.target.result) out.value.set(key, toRecord(event.target.result)); };
      }),
      commit: items => transaction('readwrite', store => {
        for (const [key, record] of items) store.put(record.deleted ? { key, deleted: true } : { key, deleted: false, value: record.value });
      }),
      clear: keys => transaction('readwrite', store => { for (const key of keys) store.delete(key); }),
      size: () => transaction('readonly', (store, out) => { store.count().onsuccess = event => { out.value = event.target.result; }; })
    };
  }

  function create({ primary, overlay, channel = null, now = Date.now, probeIntervalMs = PROBE_INTERVAL_MS, onStateChange = () => {}, onOverlayWrite = () => {} }) {
    const state = { degraded: false, since: 0, reason: '', lastProbeAt: 0 };
    let tail = Promise.resolve();
    // One writer at a time keeps overlay commits and the copy-back strictly ordered.
    const serial = fn => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };
    const emit = () => { try { onStateChange({ ...state }); } catch {} };

    async function refreshFromOverlay() {
      const pending = overlay ? await overlay.size() : 0;
      const next = pending > 0;
      if (next !== state.degraded) {
        state.degraded = next;
        if (!next) { state.since = 0; state.reason = ''; }
        emit();
      }
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
      await overlay.clear([...rows.keys()]);
    }

    // Returns true when the primary store is writable and the overlay is empty.
    async function tryRecover(force) {
      if (!state.degraded) return true;
      if (!force && now() - state.lastProbeAt < probeIntervalMs) return false;
      state.lastProbeAt = now();
      try {
        await primary.set({ [PROBE_KEY]: state.lastProbeAt });
        await copyBack();
      } catch { return false; }
      primary.remove(PROBE_KEY).catch(() => {});
      state.degraded = false; state.since = 0; state.reason = '';
      emit();
      try { channel?.postMessage('flushed'); } catch {}
      return true;
    }

    const ready = (async () => {
      try { await refreshFromOverlay(); } catch { return; }
      // Every operation awaits `ready` first, so nothing else touches the stores yet.
      if (state.degraded) await tryRecover(true).catch(() => {});
    })();
    if (channel) channel.onmessage = () => { ready.then(() => serial(refreshFromOverlay)).catch(() => {}); };

    async function mergedGet(keys) {
      const list = keyList(keys);
      const base = await primary.get(keys !== null && typeof keys === 'object' && !Array.isArray(keys) ? list : keys);
      const rows = list === null ? await overlay.entries() : await overlay.lookup(list);
      for (const [key, record] of rows) { if (record.deleted) delete base[key]; else base[key] = record.value; }
      if (keys !== null && typeof keys === 'object' && !Array.isArray(keys)) for (const [key, fallback] of Object.entries(keys)) if (!Object.hasOwn(base, key)) base[key] = fallback;
      return base;
    }

    async function write(applyPrimary, records) {
      await ready;
      if (state.degraded) await tryRecover(false);
      let primaryError = null;
      if (!state.degraded) {
        try { await applyPrimary(); return; } catch (error) {
          if (!overlay || !isStorageFault(error)) throw error;
          primaryError = error;
        }
      }
      try { await overlay.commit(records); } catch (overlayError) { throw primaryError || overlayError; }
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
        if (!state.degraded) return primary.get(keys);
        return serial(async () => (state.degraded ? mergedGet(keys) : primary.get(keys)));
      },
      set(items) {
        return serial(() => write(() => primary.set(items), Object.entries(items).map(([key, value]) => [key, { value }])));
      },
      remove(keys) {
        const list = keyList(keys) || [];
        return serial(() => write(() => primary.remove(keys), list.map(key => [key, { deleted: true }])));
      },
      recover: () => ready.then(() => serial(() => tryRecover(true))),
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
    const store = install();
    globalThis.ChatGPTStorage = Object.freeze({ ...api, install, status: () => store?.status() || null, recover: () => store?.recover() });
  }
})();
