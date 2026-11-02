import { assemblyFor } from "@get-modular/assembly";
import { createScope } from "@get-modular/resources";
import { composeJournal } "../composition/journal.root.ts";
import type { JournalCapabilities } "../features/journal/composition/journal.contracts.ts";
import type { JournalTransport } "../features/journal/contracts/journal.ts";

/**
 * Chrome MV3 page-local, read-only composition. Bundled as one classic IIFE
 * before journal.js. The worker/journal remains the only durable state writer.
 */
const prepared = composeJournal(assemblyFor<JournalCapabilities>());

async function readViaModule(transport: JournalTransport): Promise<unknown> {
  const result = await prepared;
  if (result.status !== "prepared") throw new Error("journal.composition.failed");
  const scope = createScope({ name: "journal-read" });
  let failure: unknown;
  try {
    const outcome = await result.prepared.run({
      scope: scope.resources,
      inputs: { transport: { "chatgpt/journal/transport": transport } },
    });
    if (outcome.status !== "succeeded") {
      throw new Error("journal.construction.failed");
    }
    return await outcome.roots.reader.read();
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    const report = await scope.control.close();
    if (!report.complete) {
      throw Object.assign(new Error("journal.resources.close-incomplete", { cause: failure }), {
        report,
      });
    }
  }
}

const journalHost = Object.freeze({ read: readViaModule });
(globalThis as typeof globalThis & { ChatGPTJournalModular?: typeof journalHost }).ChatGPTJournalModular = journalHost;
