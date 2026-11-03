import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

test("compiled handoff title jobs coalesce only for the same handoff ID", async () => {
  let reads = 0;
  const registered: unknown[] = [];
  const onRequest = { addListener(handler: unknown) { registered.push(handler); } };
  const context = createContext({
    URL, TextDecoder,
    handoffKey: (tabId: number) => "handoff:" + tabId,
    chrome: {
      webRequest: {
        onBeforeRequest: onRequest,
        onCompleted: onRequest,
        onErrorOccurred: onRequest,
      },
      storage: {
        local: {
          async get(key: string): Promise<Record<string, unknown>> {
            reads++;
            const id = reads === 1 ? "first" : "second";
            // The first job is in flight when the next handoff arrives.
            // Both records intentionally refuse a title mutation.
            return { [key]: { id, stage: "not-ready" } };
          },
          async set(): Promise<never> {
            throw new Error("No title mutation should be attempted");
          },
        },
      },
      scripting: {
        async executeScript(): Promise<never> {
          throw new Error("No title UI should be touched");
        },
      },
    },
  });
  const bytes = readFileSync(new URL("../dist/extension/handoff-renamer.js", import.meta.url), "utf8");
  runInContext(bytes, context, { filename: "handoff-renamer.js" });

  const first = runInContext("renameSavedHandoff(7, 'first')", context) as Promise<{ok:boolean;skipped?:boolean}>;
  const duplicate = runInContext("renameSavedHandoff(7, 'first')", context) as typeof first;
  const second = runInContext("renameSavedHandoff(7, 'second')", context) as typeof first;
  assert.strictEqual(duplicate, first, "same-handoff calls should share one in-flight job");
  assert.notStrictEqual(second, first, "another handoff must not receive the previous job result");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.skipped, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.skipped, true);
  assert.equal(reads, 2, "the next handoff must re-read its own durable record");
  assert.equal(registered.length, 3, "MV3 webRequest observers must still register synchronously");
});
