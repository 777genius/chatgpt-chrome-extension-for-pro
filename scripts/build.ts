import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Preserve MV3's current classic script boundaries and load order.
 * Pure TS emit deliberately does not wrap global scripts in an IIFE:
 * importScripts and classic content scripts share a global lexical environment.
 * This is a transitional adapter while each script becomes a typed module.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const legacy = join(root, "extension");
const typed = join(root, "src", "extension");
const destination = join(root, "dist", "extension");

rmSync(destination, { recursive: true, force: true });
cpSync(legacy, destination, { recursive: true });

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

let migrated = 0;
if (existsSync(typed)) {
  for (const name of readdirSync(typed).filter((file) => file.endsWith(".ts") && file !== "journal-modular.ts")) {
    const from = join(typed, name);
    const to = join(destination, name.replace(/\.ts$/, ".js"));
    const input = readFileSync(from, "utf8");
    const shape = transpiler.scan(input);
    if (shape.imports.length > 0 || shape.exports.length > 0) {
      throw new Error("Classic Chrome entry cannot have module imports/exports: " + name);
    }
    const javascript = transpiler.transformSync(input);
    writeFileSync(to, javascript);
    migrated++;
  }
}

// Journal uses the public Get Modular packages in a single browser IIFE.
// This is intentionally not a worker entry: Chrome MV3 event registrations
// must remain synchronous and must never await graph construction.
const journalEntrypoint = join(root, "src", "extension", "journal-modular.ts");
const journalBuild = await Bun.build({
  entrypoints: [journalEntrypoint],
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
});
if (!journalBuild.success || journalBuild.outputs.length !== 1) {
  const errors = journalBuild.logs.map((log) => String(log.message)).join("; ");
  throw new Error("Get Modular journal bundle failed: " + errors);
}
writeFileSync(join(destination, "journal-modular.js"), await journalBuild.outputs[0]!.text());
const htmlFile = join(destination, "journal.html");
const legacyHtml = readFileSync(htmlFile, "utf8");
const scriptTag = '<script src="journal.js"></script>';
if (!legacyHtml.includes(scriptTag)) throw new Error("Journal script anchor missing");
writeFileSync(htmlFile, legacyHtml.replace(scriptTag,
  '<script src="journal-modular.js"></script>' + scriptTag));

const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")) as {
  background: { service_worker: string };
  content_scripts: { js: string[] }[];
};
const required = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  "popup.js",
  "journal.js",
  "offscreen.js",
];
const serviceWorker = readFileSync(join(destination, manifest.background.service_worker), "utf8");
for (const match of serviceWorker.matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)) {
  if (match[1]) required.push(match[1]);
}
for (const file of new Set(required)) {
  if (!existsSync(join(destination, file))) {
    throw new Error("Missing generated Chrome script: " + file);
  }
}
console.log("Chrome MV3 distribution built: " + required.length + " referenced scripts; " + migrated + " typed scripts.");
