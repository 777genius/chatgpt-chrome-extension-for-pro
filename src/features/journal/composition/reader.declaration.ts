import { declareModule } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { Reader, Transport } from "./journal.contracts.ts";

export const readerDeclaration = declareModule({
  moduleId: "chatgpt/journal/reader",
  implementationId: "chatgpt/journal/reader/chrome",
  owner: { authority: "chatgpt", path: ["journal"] },
  provides: [Reader.provide()],
  slots: [Transport.slot("transport", required())],
});
