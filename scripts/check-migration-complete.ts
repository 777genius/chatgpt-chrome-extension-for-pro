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
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version:string;
  devDependencies?:Record<string,string>;
  dependencies?:Record<string,string>;
};
const manifest = JSON.parse(readFileSync(join(historical, "manifest.json"), "utf8")) as { version: string };
if (pkg.version !== manifest.version) throw new Error("Package and MV3 manifest version drift");
if (pkg.devDependencies?.typescript !== "7.0.2") {
  throw new Error("Published TS7 contract requires exact TypeScript 7.0.2");
}
if (pkg.dependencies?.["@agent-teams/engineering-foundation"]) {
  throw new Error("Engineering Foundation must never be bundled into Chrome");
}
function inspectSource(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file=join(dir, entry.name);
    if (entry.isDirectory()) { inspectSource(file); continue; }
    if (!entry.name.endsWith(".ts")) continue;
    const source=readFileSync(file,"utf8");
    // Review-ready production must not bypass compiler checks.
    if (/@ts-nocheck|@ts-ignore|\bas\s+any\b/.test(source)) {
      throw new Error("Unsafe compiler suppression in: "+file);
    }
  }
}
inspectSource(join(root,"src"));
console.log("Strict TS release inventory complete: " + readdirSync(historical).filter(name=>name.endsWith(".js")).length + " browser entry points.");
