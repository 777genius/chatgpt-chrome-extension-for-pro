import { group } from "@get-modular/assembly";
import { readerModule } from "./reader.module.ts";

export const journalGroup = group("journal", [readerModule]);
