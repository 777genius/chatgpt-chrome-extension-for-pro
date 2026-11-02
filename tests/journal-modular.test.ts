import assert from "node:assert/strict";
import { test } from "node:test";
import { assemblyFor } from "@get-modular/assembly";
import { isolate } from "@get-modular/conformance";
import { createScope } from "@get-modular/resources";
import { composeJournal } from "../src/composition/journal.root.ts";
import type { JournalCapabilities } from "../src/features/journal/composition/journal.contracts.ts";
import { readerModule } from "../src/features/journal/composition/reader.module.ts";

test("journal reader is strictly read-only and accepts only its declared host port", async () => {
  const requests: unknown[] = [];
  const instance = await isolate(readerModule, { dependencies: {
    transport: {
      sendMessage: async message => {
        requests.push(message);
        return { ok: true, events: [{ kind: "sample", sequence: 1 }] };
      },
    },
  } });
  try {
    const response = await instance.capabilities["chatgpt/journal/reader"].read();
    assert.deepEqual(response, { ok: true, events: [{ kind: "sample", sequence: 1 }] });
    assert.deepEqual(requests, [{ type: "CHATGPT_JOURNAL_READ" }]);
  } finally {
    const report = await instance.close();
    assert.equal(report.complete, true);
    assert.equal(report.settled, true);
    assert.deepEqual(report.debts, []);
  }
});

test("the real composition root constructs through Core and Assembly with a bounded scope", async () => {
  const preparation = await composeJournal(assemblyFor<JournalCapabilities>());
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") throw new Error("journal.prepare.failed");
  const attempt = createScope({ name: "journal-test" });
  let calls = 0;
  try {
    const outcome = await preparation.prepared.run({
      scope: attempt.resources,
      inputs: { transport: { "chatgpt/journal/transport": {
        sendMessage: async ({ type }) => {
          calls++;
          assert.equal(type, "CHATGPT_JOURNAL_READ");
          return { ok: true, events: [] };
        },
      } } },
    });
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") throw new Error("journal.run.failed");
    assert.deepEqual(await outcome.roots.reader.read(), { ok: true, events: [] });
    assert.equal(calls, 1);
  } finally {
    const report = await attempt.control.close();
    assert.equal(report.complete, true, "module scope must not retain cleanup debts");
  }
});
