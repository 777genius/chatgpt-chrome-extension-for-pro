import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = join(root, "dist", "extension");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
  background: { service_worker: string };
  content_scripts: { js: string[] }[];
  icons: Record<string, string>;
};
const files = new Set<string>([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((script) => script.js),
  ...Object.values(manifest.icons),
  "popup.js",
  "offscreen.js",
  "journal.js",
]);
const worker = readFileSync(join(dir, manifest.background.service_worker), "utf8");
for (const match of worker.matchAll(/\bimportScripts\(([^)]+)\)/g)) {
  for (const spec of match[1]?.matchAll(/['"]([^'"]+\.js)['"]/g) ?? []) {
    if (spec[1]) files.add(spec[1]);
  }
}
for (const name of ["popup.html", "journal.html", "offscreen.html"]) {
  const html = readFileSync(join(dir, name), "utf8");
  for (const match of html.matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g)) {
    if (match[1]) files.add(match[1]);
  }
}
for (const file of files) {
  if (!existsSync(join(dir, file))) throw new Error("Missing generated MV3 resource " + file);
}
const scanner = new Bun.Transpiler({ loader: "js", target: "browser" });
const js = readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
const legacy = join(root, "extension");
const typed = join(root, "src", "extension");
for (const name of js) {
  if (!existsSync(join(typed, name.replace(/\.js$/, ".ts")))) {
    const original = readFileSync(join(legacy, name));
    const output = readFileSync(join(dir, name));
    if (!original.equals(output)) {
      throw new Error("Unported legacy script was silently changed by the build: " + name);
    }
  }
}
for (const name of ["manifest.json", "popup.html", "journal.html", "offscreen.html"]) {
  if (readFileSync(join(legacy, name), "utf8") !== readFileSync(join(dir, name), "utf8")) {
    throw new Error("Chrome MV3 entry or permissions changed during build: " + name);
  }
}
for (const file of js) {
  const bytes = readFileSync(join(dir, file), "utf8");
  const scanned = scanner.scan(bytes);
  if (scanned.imports.length > 0 || scanned.exports.length > 0) {
    throw new Error("Import/export or module require found in classic Chrome script: " + file);
  }
  const check = spawnSync(process.execPath, ["--check", join(dir, file)], { stdio: "inherit" });
  if (check.error || check.status !== 0) throw new Error("Generated script failed syntax: " + file);
}
console.log("Generated Chrome MV3 resources and syntax verified (" + js.length + " scripts).");
