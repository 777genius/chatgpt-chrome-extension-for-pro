import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

test("the browser IIFE runs without Bun, Node, or module globals and respects the journal port", async () => {
  const source = readFileSync("dist/extension/journal-modular.js", "utf8");
  const seen: unknown[] = [];
  const isolated = createContext({
    crypto: webcrypto,
    TextEncoder, TextDecoder, URL, AbortController,
    setTimeout, clearTimeout, queueMicrotask, structuredClone,
  });
  assert.equal(runInContext("typeof process", isolated), "undefined");
  assert.equal(runInContext("typeof Bun", isolated), "undefined");
  assert.equal(runInContext("typeof require", isolated), "undefined");
  runInContext(source, isolated, { filename: "journal-modular.js" });

  const reader: unknown = runInContext("globalThis.ChatGPTJournalModular?.read", isolated);
  assert.equal(typeof reader, "function");
  if (typeof reader !== "function") throw new Error("journal.read.missing");

  const value: unknown = await reader({
    sendMessage: async (message: unknown) => {
      seen.push(message);
      return { ok: true, events: [{ kind: "migration.sample", sequence: 1 }] };
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    ok: true, events: [{ kind: "migration.sample", sequence: 1 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ type: "CHATGPT_JOURNAL_READ" }]);

  await assert.rejects(async () => {
    await reader({
      sendMessage: async () => { throw new Error("synthetic journal transport failure"); },
    });
  }, /synthetic journal transport failure/, "read errors must not become empty successful exports");
});
