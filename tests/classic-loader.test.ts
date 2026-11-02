import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
type CompletionPort = {
  bindAttemptPrompt: (attempt: unknown, snapshot: unknown) => unknown;
  completedAttemptEvidence: (attempt: unknown, snapshot: unknown) => unknown;
};

test("classic Chrome helper retains CommonJS loader compatibility in both source and generated build", () => {
  for (const path of ["../extension/completion-state.js", "../dist/extension/completion-state.js"]) {
    const loaded: unknown = require(path);
    assert.ok(loaded && typeof loaded === "object");
    const port = loaded as CompletionPort;
    assert.equal(typeof port.bindAttemptPrompt, "function");
    assert.equal(typeof port.completedAttemptEvidence, "function");
    const attempt = { id: "test-request", url: "https://chatgpt.com/c/test",
      baselineKey: "old", promptKey: "new" };
    const snapshot = { url: attempt.url, attemptId: attempt.id, promptKey: "new",
      isLatest: true, isReadOnly: false, generating: false, hasError: false,
      turnStatus: "complete", assistantKey: "answer", assistantCompleted: true,
      assistantPhase: "final_answer" };
    assert.deepEqual(port.completedAttemptEvidence(attempt, snapshot),
      { attemptId: "test-request", promptKey: "new", assistantKey: "answer" });
  }
});
