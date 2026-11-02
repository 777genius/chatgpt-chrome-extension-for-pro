import type { Assembly } from "@get-modular/assembly";
import type { JournalCapabilities } "../features/journal/composition/journal.contracts.ts";
import { journalGroup } "../features/journal/composition/journal.group.ts";
import { readerModule } "../features/journal/composition/reader.module.ts";
import { transportInput } "../features/journal/composition/transport.input.ts";

export function composeJournal(api: Assembly<JournalCapabilities>) {
  return api.prepare({
    profileId: "chatgpt/journal/production",
    modules: [journalGroup],
    roots: { reader: readerModule },
    inputs: { transport: transportInput },
  });
}
