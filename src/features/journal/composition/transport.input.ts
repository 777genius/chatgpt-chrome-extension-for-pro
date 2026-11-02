import { declareModule, input } from "@get-modular/assembly";
import { Transport } from "./journal.contracts.js";
import type { JournalCapabilities } from "./journal.contracts.js";

export const transportDeclaration = declareModule({
  moduleId: "chatgpt/journal/transport",
  implementationId: "chatgpt/journal/transport/host",
  owner: { authority: "chatgpt", path: ["journal"] },
  provides: [Transport.provide()],
  slots: [],
});

export const transportInput = input<JournalCapabilities>()(transportDeclaration);
