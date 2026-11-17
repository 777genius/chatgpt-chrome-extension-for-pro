# Storage fallback

`chrome.storage.local` is a LevelDB owned by the browser process. After a background write error (for example a full disk) LevelDB keeps rejecting every write with the same `IO error ... NewWritableFile` until Chrome restarts, and reloading the extension does not reopen it. Reads keep working, so the journal and every state write used to stop while automatic sends stayed blocked.

`extension/resilient-storage.js` decorates `chrome.storage.local` in place at the top of the service worker and popup, so no call site changes:

- A write that fails with a storage fault (`IO error`, `NewWritableFile`, `ChromeMethodBFE`, `Corruption`, `ENOSPC`) is committed atomically to the extension's IndexedDB (`chatgpt-resilient-storage`) instead. Any other error is rethrown unchanged.
- Reads merge the overlay (writes and deletes) over the real store. Writes keep their submission order.
- Once the real store accepts writes again (probe at most once a minute and at worker start), the overlay is copied back and cleared before new writes go to the real store.
- If the overlay cannot be written either, the original error is rejected exactly as before, so the journal rule "a failed write stops automatic sends" still holds. Nothing is deleted and no data is dropped.
- While degraded the toolbar badge shows `!` and the journal page says so.

Known gaps:

- Content scripts do not see the overlay. They still read the real store directly (for example the retry message set in the popup applies after recovery). Goal changes written to the overlay are signalled to open ChatGPT tabs with `CHATGPT_STORAGE_OVERLAY_CHANGED`, because `storage.onChanged` does not fire for them.
- `clear()` is not mirrored; nothing in the extension calls it.
- Unit tests use in-memory fakes. The IndexedDB overlay was additionally exercised against `fake-indexeddb` and in a live Chrome with a stuck store, but there is no automated browser test.
