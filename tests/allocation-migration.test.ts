import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type AllocationRecord = {
  state: string; url: string; baselineKey: string; promptKey: string; startedAt: number;
};
type NativeEvidence = {
  ok: boolean; url: string; firstTurn: boolean; isLatest: boolean;
  isReadOnly: boolean; hasError: boolean;
  userId: string; promptKey: string; firstUserSentAtMs: number;
  turnStatus: string; generating: boolean;
  assistantCompleted: boolean; assistantPhase: string;
  assistantId: string; assistantKey: string;
};
type Evidence = { url: string; promptKey: string } | null;

function run(sourceDir: "extension" | "dist/extension", record: AllocationRecord,
  url: string, native: NativeEvidence): Evidence {
  const source = readFileSync(new URL("../" + sourceDir + "/completion-checkpoint.js", import.meta.url), "utf8");
  const context: Record<string, unknown> = { URL, record, url, native };
  const result = runInNewContext(source+"\ncompletionAllocationEvidence(record,url,native)", context) as Evidence;
  return JSON.parse(JSON.stringify(result)) as Evidence;
}

test("typed new-chat allocation proof preserves fail-closed native and timestamp fences", () => {
  const url = "https://chatgpt.com/c/test-allocation";
  const record: AllocationRecord = {
    state: "active", url: "https://chatgpt.com/", baselineKey: "",
    promptKey: "", startedAt: 100_000,
  };
  const native: NativeEvidence = {
    ok: true, url, firstTurn: true, isLatest: true, isReadOnly: false,
    hasError: false, userId: "test-user", promptKey: "/c/test-allocation|test-user",
    firstUserSentAtMs: 100_050, turnStatus: "in_progress", generating: true,
    assistantCompleted: false, assistantPhase: "", assistantId: "", assistantKey: "",
  };
  const cases: readonly [AllocationRecord, NativeEvidence][] = [
    [record, native],
    [record, {...native, turnStatus: "complete", generating: false,
      assistantCompleted: true, assistantPhase: "final_answer", assistantId: "answer",
      assistantKey: "answer-key"}],
    [record, {...native, firstTurn: false}],
    [record, {...native, firstUserSentAtMs: 110_001}],
    [record, {...native, firstUserSentAtMs: NaN}],
    [record, {...native, hasError: true}],
    [record, {...native, isReadOnly: true}],
    [{...record, baselineKey: "old-answer"}, native],
    [{...record, startedAt: 90_000}, native],
  ];
  for(const [saved, observed] of cases) {
    assert.deepEqual(run("dist/extension", saved, url, observed),
      run("extension", saved, url, observed),
      "compiled TS altered new-chat allocation evidence");
  }
  assert.deepEqual(run("dist/extension", record, url, native), {
    url, promptKey: native.promptKey,
  });
  assert.equal(run("dist/extension", record, url, {...native, firstTurn: false}), null);
});
