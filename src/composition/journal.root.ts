import type { Assembly } from "@get-modular/assembly";
import type { JournalCapabilities } from "../features/journal/composition/journal.contracts.js";
import { journalGroup } from "../features/journal/composition/journal.group.js";
import { readerModule } from "../features/journal/composition/reader.module.js";
import { transportInput } from "../features/journal/composition/transport.input.js";

export function composeJournal(api: Assembly<JournalCapabilities>) {
  return api.prepare({
    profileId: "chatgpt/journal/production",
    modules: [journalGroup],
    roots: { reader: readerModule },
    inputs: { transport: transportInput },
  });
}
