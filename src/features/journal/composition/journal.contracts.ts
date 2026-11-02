import { defineContract, type CapabilitiesOf } from "@get-modular/assembly";
import type { JournalReader, JournalTransport } from "../contracts/journal.js";

export const Transport = defineContract<JournalTransport>()({
  id: "chatgpt/journal/transport", revision: 1,
});
export const Reader = defineContract<JournalReader>()({
  id: "chatgpt/journal/reader", revision: 1,
});

export interface JournalCapabilities extends CapabilitiesOf<typeof Transport | typeof Reader> {}
