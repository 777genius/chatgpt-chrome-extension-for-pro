# Storage fallback

`chrome.storage.local` is a LevelDB owned by the browser process. After a background write error (for example a full disk) LevelDB keeps rejecting every write with the same `IO error ... NewWritableFile` until Chrome restarts, and reloading the extension does not reopen it. Reads keep working, so the journal and every state write used to stop while automatic sends stayed blocked.

`extension/resilient-storage.js` decorates `chrome.storage.local` in place at the top of the service worker and popup, so no call site changes:

- A write that fails with a storage fault (a message matching `IO error`, `ChromeMethodBFE`, `NewWritableFile`, `Corruption`, `leveldb`, `No space left`, `ENOSPC` or `disk is full`, case-insensitive) is committed in one IndexedDB transaction (aborted as a whole on any error) to the extension's IndexedDB (`chatgpt-resilient-storage`) instead. Any other error is rethrown unchanged.
- Reads merge the overlay (writes and deletes) over the real store. Writes keep their submission order.
- Once the real store accepts writes again (probe at most once a minute and at worker start), the overlay is copied back and cleared before new writes go to the real store.
- The service worker, popup and journal page each load their own wrapper. Every operation that can touch the overlay runs under one origin-wide Web Lock (`navigator.locks`), the overlay is re-read under that lock before each write, and the copy-back clears a record only if it still carries the revision it copied. So two contexts cannot copy back, clear or overwrite each other's records.
- If the overlay content cannot be read (IndexedDB fails to open), its state is unknown, not empty. Writes are refused with an error that says so until it can be read again, because an older overlay record could otherwise overwrite newer data after recovery. Reads still go to the real store. This only happens when IndexedDB itself fails, and journal writes then fail the same recorded way they did before this wrapper existed.
- If the overlay cannot be written either, the original error is rejected exactly as before, so the journal rule "a failed write stops automatic sends" still holds. Nothing is deleted and no data is dropped.
- While degraded the toolbar badge shows `!` and the journal page says so.

Known gaps:

- Content scripts do not see the overlay. They still read the real store directly (for example a retry message edited in the popup while degraded is not seen by the content script, so the service worker sees a mismatch and refuses automatic retries until recovery; this fails safe). Goal changes written to the overlay are signalled to open ChatGPT tabs with `CHATGPT_STORAGE_OVERLAY_CHANGED`, because `storage.onChanged` does not fire for them.
- A healthy context learns about overlay writes from another context through a `BroadcastChannel`, so a read there can briefly miss a record that was just written to the overlay. Writes always re-check the overlay under the lock.
- `clear()` is not mirrored; nothing in the extension calls it.
- Unit tests use in-memory fakes. The IndexedDB overlay was additionally exercised against `fake-indexeddb` and in a live Chrome with a stuck store, but there is no automated browser test.
