"use strict";

// Transient task ownership is deliberately separate from durable send authority.
// A stale task cannot release a newer task's cleanup.
type Cleanup = () => void;
interface OwnedTask {
  cleanup: Cleanup | null;
}
interface LatestTaskSlot {
  replace(cleanup: Cleanup): Cleanup;
  cancel(): void;
}
const memoryApi = Object.freeze({
  createLatestTaskSlot(): Readonly<LatestTaskSlot> {
    let current: OwnedTask | null = null;

    function dispose(task: OwnedTask | null): void {
      const cleanup = task?.cleanup;
      if (task) task.cleanup = null;
      if (cleanup) cleanup();
    }

    return Object.freeze({
      replace(cleanup: Cleanup): Cleanup {
        if (typeof cleanup !== "function") throw new TypeError("Task cleanup must be a function");
        const previous = current;
        const task: OwnedTask = { cleanup };
        current = task;
        try {
          dispose(previous);
        } catch (error) {
          if (current === task) current = null;
          dispose(task);
          throw error;
        }
        return () => {
          if (current === task) current = null;
          task.cleanup = null;
        };
      },
      cancel(): void {
        const previous = current;
        current = null;
        dispose(previous);
      },
    });
  },
});

(globalThis as typeof globalThis & { ChatGPTNotifierMemory: typeof memoryApi }).ChatGPTNotifierMemory = memoryApi;
