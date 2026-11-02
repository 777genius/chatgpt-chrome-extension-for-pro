import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Release admission, not feedback. Drafts can keep known legacy entry points
// while characterization and compiled-distribution tests expose regressions.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "src", "extension");
const historical = join(root, "extension");
const missing = readdirSync(historical)
  .filter(name => name.endsWith(".js"))
  .filter(name => !existsSync(join(source, name.replace(/\.js$/, ".ts"))));
if (missing.length > 0) {
  throw new Error("Unmigrated Chrome runtime files: " + missing.join(", "));
}
if (!existsSync(join(root, "bun.lock"))) {
  throw new Error("A frozen Bun lockfile is required before review-ready/merge");
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const manifest = JSON.parse(readFileSync(join(historical, "manifest.json"), "utf8")) as { version: string };
if (pkg.version !== manifest.version) throw new Error("Package and MV3 manifest version drift");
console.log("Strict TS release inventory complete: " + readdirSync(historical).filter(name=>name.endsWith(".js")).length + " browser entry points.");
