import { group } from "@get-modular/assembly";
import { readerModule } from "./reader.module.js";

export const journalGroup = group("journal", [readerModule]);
