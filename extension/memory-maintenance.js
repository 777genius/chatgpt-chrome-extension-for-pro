'use strict';

// Own only an extension task's disposable observers/timers. Durable journal,
// drafts, retry decisions and handoff/exactly-once records never enter this slot.
globalThis.ChatGPTNotifierMemory = Object.freeze({
  createLatestTaskSlot() {
    let current = null;

    function dispose(task) {
      const cleanup = task?.cleanup;
      if (task) task.cleanup = null;
      if (cleanup) cleanup();
    }

    return Object.freeze({
      replace(cleanup) {
        if (typeof cleanup !== 'function') throw new TypeError('Task cleanup must be a function');
        const previous = current;
        const task = { cleanup };
        current = task;
        try {
          dispose(previous);
        } catch (error) {
          // Do not leave a newly registered task orphaned if retirement fails.
          if (current === task) current = null;
          dispose(task);
          throw error;
        }
        // A settled older task must not release a newer task's ownership.
        return () => {
          if (current === task) current = null;
          task.cleanup = null;
        };
      },
      cancel() {
        const previous = current;
        current = null;
        dispose(previous);
      }
    });
  }
});
