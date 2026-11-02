import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

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

let migrated = 0;
if (existsSync(typed)) {
  for (const name of readdirSync(typed).filter((file) => file.endsWith(".ts"))) {
    const from = join(typed, name);
    const to = join(destination, name.replace(/\.ts$/, ".js"));
    const input = readFileSync(from, "utf8");
    const result = ts.transpileModule(input, {
      fileName: from,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.None,
        removeComments: false,
      },
    });
    const failures = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
    if (failures.length > 0) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(failures, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }));
    }
    writeFileSync(to, result.outputText);
    migrated++;
  }
}

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
