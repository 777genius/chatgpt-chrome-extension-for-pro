import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

class Element {
  textContent = "";
  hidden = false;
  value = "";
  readonly handlers = new Map<string, () => void>();
  addEventListener(name: string, action: () => void): void { this.handlers.set(name, action); }
  replaceChildren(): void {}
}

test("compiled journal discards older reads and stale failures after a newer refresh", async () => {
  const elements: Record<string, Element> = Object.fromEntries(
    ["filter", "status", "events", "more", "refresh", "export"].map(id => [id, new Element()]),
  );
  let firstSuccess: ((value: unknown) => void) | null = null;
  let count = 0;
  const older = new Promise<unknown>(resolve => { firstSuccess = resolve; });
  const newDate = 1780000000000, oldDate = 1700000000000;
  const ctx = createContext({
    HTMLInputElement: Element,
    document: {
      getElementById(id: string) { return elements[id] || null; },
      createElement() { throw new Error("Unexpected journal entry"); },
    },
    chrome: { runtime: { sendMessage: async () => { throw new Error("Must use modular read"); } } },
    ChatGPTJournalModular: {
      read: async () => {
        count++;
        return count === 1 ? older : { ok: true, events: [], meta: { startedAt: newDate } };
      },
    },
    URL, Blob, setTimeout,
  });
  const script = readFileSync(new URL("../dist/extension/journal.js", import.meta.url), "utf8");
  runInContext(script, ctx, { filename: "journal.js" });
  assert.equal(count, 1);
  elements.refresh.handlers.get("click")?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  const latest = elements.status.textContent;
  assert.ok(latest.includes(new Date(newDate).toLocaleString()), "Newer response must be shown");
  assert.ok(firstSuccess, "Initial read should remain pending");
  firstSuccess({ ok: true, events: [], meta: { startedAt: oldDate } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(elements.status.textContent, latest, "Older success must not overwrite newer status");
  assert.equal(elements.more.hidden, true);
});
