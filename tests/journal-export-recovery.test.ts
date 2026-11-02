import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

type Handler = () => unknown;
class MockElement {
  textContent = "";
  hidden = false;
  readonly listeners = new Map<string, Handler>();
  removedChildren = 0;
  addEventListener(name: string, callback: Handler): void {
    this.listeners.set(name, callback);
  }
  replaceChildren(): void {
    this.removedChildren++;
  }
}
class MockInput extends MockElement {
  value = "";
}

test("failed journal refresh cannot export a stale previously loaded snapshot", async () => {
  const ids = {
    filter: new MockInput(),
    status: new MockElement(),
    events: new MockElement(),
    more: new MockElement(),
    refresh: new MockElement(),
    export: new MockElement(),
  };
  let reads = 0;
  let exports = 0;
  const ctx = createContext({
    HTMLInputElement: MockInput,
    URL: class SafeURL extends URL {
      static createObjectURL(): string {
        exports++;
        throw new Error("Stale journal snapshot was exported");
      }
    },
    Blob,
    setTimeout,
    document: {
      getElementById(id: string): MockElement | null {
        return Object.prototype.hasOwnProperty.call(ids, id)
          ? ids[id as keyof typeof ids] : null;
      },
      createElement(): never {
        throw new Error("Unexpected article/link creation");
      },
    },
    chrome: {
      runtime: {
        sendMessage: async () => {
          throw new Error("Journal modular transport is the only reader");
        },
      },
    },
    ChatGPTJournalModular: {
      read: async (): Promise<unknown> => {
        reads++;
        if (reads === 1) {
          return { ok: true, events: [], meta: { startedAt: 1234 } };
        }
        throw new Error("Synthetic durable read failure");
      },
    },
  });
  const source = readFileSync(new URL("../dist/extension/journal.js", import.meta.url), "utf8");
  runInContext(source, ctx, { filename: "journal.js" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.match(ids.status.textContent, /0 событий/);

  const exportHandler = ids.export.listeners.get("click");
  assert.ok(exportHandler, "The export handler must be registered");
  await exportHandler();

  assert.equal(reads, 2);
  assert.equal(exports, 0, "Never export a known-stale durable journal");
  assert.match(ids.status.textContent, /Не удалось прочитать журнал/);
  assert.equal(ids.more.hidden, true);
  assert.ok(ids.events.removedChildren >= 2, "Old entries must be cleared on failed read");
});
