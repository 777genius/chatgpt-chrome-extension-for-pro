import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

type Handler = () => unknown;

class FakeElement {
  textContent = "";
  hidden = false;
  readonly listeners = new Map<string, Handler>();
  addEventListener(event: string, callback: Handler): void {
    this.listeners.set(event, callback);
  }
  replaceChildren(): void {}
}
class FakeInput extends FakeElement { value = ""; }

test("compiled journal exports the complete fresh durable worker snapshot", async () => {
  const ids = {
    filter: new FakeInput(),
    status: new FakeElement(),
    events: new FakeElement(),
    more: new FakeElement(),
    refresh: new FakeElement(),
    export: new FakeElement(),
  };
  const snapshot = {
    ok: true,
    events: [],
    meta: {
      startedAt: 100,
      sequence: 42,
      active: { "test-claim": { kind: "retry", operationId: "op-42" } },
      retryDraftByChat: { "https://chatgpt.com/c/test": { text: "unsent user draft" } },
    },
  };
  let reads = 0;
  let exportedBlob: Blob | undefined;
  const links: Array<{ href: string; download: string; clicked: boolean }> = [];
  class ExportURL extends URL {
    static createObjectURL(blob: Blob | MediaSource): string {
      if (!(blob instanceof Blob)) throw new Error("Expected a JSON Blob");
      exportedBlob = blob;
      return "blob:journal-test";
    }
    static revokeObjectURL(_url: string): void {}
  }
  const ctx = createContext({
    HTMLInputElement: FakeInput,
    URL: ExportURL,
    Blob,
    setTimeout: (_callback: () => void, _delay: number) => 0,
    document: {
      getElementById(id: string): FakeElement | null {
        return Object.prototype.hasOwnProperty.call(ids, id)
          ? ids[id as keyof typeof ids] : null;
      },
      createElement(tag: string) {
        if (tag !== "a") throw new Error("Unexpected journal DOM element: " + tag);
        const anchor = {
          href: "",
          download: "",
          clicked: false,
          click() { this.clicked = true; },
        };
        links.push(anchor);
        return anchor;
      },
    },
    chrome: {
      runtime: {
        sendMessage: async () => {
          throw new Error("Journal must use the composed reader");
        },
      },
    },
    ChatGPTJournalModular: {
      read: async () => {
        reads++;
        return snapshot;
      },
    },
  });
  const source = readFileSync(new URL("../dist/extension/journal.js", import.meta.url), "utf8");
  runInContext(source, ctx, { filename: "journal.js" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "the journal must load once at startup");

  const exportHandler = ids.export.listeners.get("click");
  assert.ok(exportHandler, "an export handler must be installed");
  await exportHandler();

  assert.equal(reads, 2, "export must refresh the authoritative snapshot");
  assert.equal(links.length, 1, "a successful export must trigger one download");
  assert.equal(links[0]?.clicked, true);
  assert.equal(links[0]?.href, "blob:journal-test");
  assert.match(links[0]?.download ?? "", /^chatgpt-journal-.*\.json$/);
  assert.ok(exportedBlob, "export must create a Blob");
  assert.equal(exportedBlob.type, "application/json;charset=utf-8");
  assert.deepEqual(JSON.parse(await exportedBlob.text()), snapshot,
    "export must retain all durable metadata, claims, and draft state");
});
