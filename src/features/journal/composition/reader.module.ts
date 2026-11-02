import { implement } from "@get-modular/assembly";
import type { JournalReader } "../contracts/journal.ts";
import type { JournalCapabilities } "./journal.contracts.ts";
import { readerDeclaration } "./reader.declaration.ts";

export const readerModule = implement<JournalCapabilities>()(readerDeclaration, async ({ transport }) => {
  const port: JournalReader = {
    read: () => transport.sendMessage({ type: "CHATGPT_JOURNAL_READ" }),
  };
  return { instance: port, capabilities: { "chatgpt/journal/reader": port } };
});
