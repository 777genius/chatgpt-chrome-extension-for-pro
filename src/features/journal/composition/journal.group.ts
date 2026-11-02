import { group } from "@get-modular/assembly";
import { readerModule } "./reader.module.ts";

export const journalGroup = group("journal", [readerModule]);
