import { declareModule, input } from "@get-modular/assembly";
import { Transport } "./journal.contracts.ts";
import type { JournalCapabilities } "./journal.contracts.ts";

export const transportDeclaration = declareModule({
  moduleId: "chatgpt/journal/transport",
  implementationId: "chatgpt/journal/transport/host",
  owner: { authority: "chatgpt", path: ["journal"] },
  provides: [Transport.provide()],
  slots: [],
});

export const transportInput = input<JournalCapabilities>()(transportDeclaration);
