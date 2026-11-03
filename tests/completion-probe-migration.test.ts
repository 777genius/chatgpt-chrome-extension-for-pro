import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

// The MAIN-world probe must be serializable through chrome.scripting.func:
// no imported helpers, globals from the isolated world, or run-time type code.
function probe(dir: "extension" | "dist/extension", opts: {
  route?: string; generating?: boolean; error?: boolean; complete?: boolean;
} = {}): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const user = {
    getAttribute(key: string) { return key === "data-testid" ? "user-key" : null; },
    getClientRects() { return [1]; },
  };
  const assistant = {
    getAttribute(key: string) { return key === "data-testid" ? "assistant-key" : null; },
    getClientRects() { return [1]; },
  };
  const stop = { getClientRects() { return opts.generating ? [1] : []; } };
  const root = {
    querySelectorAll(selector: string) {
      if (selector.includes("conversation-turn-")) return [turn];
      if (selector.includes("stop-button")) return [stop];
      if (selector.includes('aside[role="alert"]')) return [];
      return [];
    },
  };
  const turn = {
    "__reactFiber$fixture": {
      memoizedProps: { entries: [{
        id: "turn-1", isMostRecentTurn: true, isReadOnly: false,
        errorMessage: opts.error ? "network error" : "",
        turn: {
          status: opts.complete === false ? "in_progress" : "complete",
          items: [
            { type: "user-message", messageId: "u1" },
            { type: "assistant-message", phase: "final_answer",
              completed: opts.complete !== false, messageId: "a1" },
          ],
        },
      }] },
      return: null,
    },
    getAttribute(name: string) {
      return name === "data-content-search-turn-key" ? "turn-1" : null;
    },
    querySelectorAll(selector: string) {
      return selector.includes(":user") ? [user] :
        selector.includes(":assistant") ? [assistant] : [];
    },
  };
  const context = createContext({
    location: { origin: "https://chatgpt.com", pathname: opts.route || "/c/fixture" },
    document: {
      querySelector(selector: string) {
        return selector.includes("app-shell") ? root : null;
      },
    },
  });
  const source = readFileSync(new URL("../" + dir + "/completion-probe.js", import.meta.url), "utf8");
  runInContext(source, context);
  const fn = runInContext("inspectCompletedTurn.toString()", context) as string;
  assert.equal(typeof fn, "string");
  const serializable = createContext({
    document: context.document,
    location: context.location,
  });
  runInContext("var inspectCompletedTurn = (" + fn + ");", serializable);
  for (const expectedUrl of ["https://chatgpt.com/c/fixture", "https://chatgpt.com/c/not-this"]) {
    const observed = runInContext("inspectCompletedTurn(" + JSON.stringify(expectedUrl) + ")", serializable);
    seen.push(JSON.parse(JSON.stringify(observed)) as Record<string, unknown>);
  }
  return seen;
}

test("compiled MAIN probe is self-contained and preserves prompt-bound final evidence", () => {
  for (const options of [
    {}, { generating: true }, { error: true }, { complete: false },
    { route: "/c/different" },
  ]) {
    assert.deepEqual(probe("dist/extension", options), probe("extension", options));
  }
  const [ready, wrong] = probe("dist/extension");
  assert.equal(ready?.ok, true);
  assert.equal(ready?.assistantKey, "assistant-key");
  assert.equal(ready?.userId, "u1");
  assert.equal(ready?.assistantId, "a1", "probe must preserve the native assistant message ID");
  assert.equal(ready?.assistantCompleted, true);
  assert.equal(ready?.generating, false);
  assert.equal(wrong?.reason, "route-changed");
});
