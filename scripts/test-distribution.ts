import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Distribution smoke test against the shipped classic-script bytes.
 *
 * The existing tests read extension/*.js directly. A disposable replica with
 * dist/extension copied into that path reuses all existing 29 tests without
 * editing their fixtures or modifying the owner's actual browser/session.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "dist", "parity-fixture");
const dist = join(root, "dist", "extension");

if (!existsSync(join(dist, "manifest.json"))) {
  throw new Error("Build the Chrome distribution before running distribution tests");
}
rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });

try {
  cpSync(dist, join(fixture, "extension"), { recursive: true });
  cpSync(join(root, "tests"), join(fixture, "tests"), { recursive: true });
  cpSync(join(root, "scripts"), join(fixture, "scripts"), { recursive: true });
  cpSync(join(root, "package.json"), join(fixture, "package.json"));
  cpSync(join(root, "README.md"), join(fixture, "README.md"));
  if (existsSync(join(root, "docs"))) {
    cpSync(join(root, "docs"), join(fixture, "docs"), { recursive: true });
  }

  const tests = readdirSync(join(fixture, "tests"))
    .filter((name) => name === "check.ts" || name.endsWith("-check.ts")).sort();
  for (const name of tests) {
    console.log("\n[compiled MV3] " + name);
    const outcome = spawnSync("node", ["tests/" + name], {
      cwd: fixture,
      stdio: "inherit",
      timeout: 120_000,
      env: { ...process.env, CHATGPT_TEST_COMPILED_DISTRIBUTION: "1" },
    });
    if (outcome.error) throw outcome.error;
    if (outcome.status !== 0) {
      throw new Error(name + ": compiled distribution regression (" + outcome.status + ")");
    }
  }
  console.log("\nCompiled MV3 parity: " + tests.length + " existing nonbrowser programs passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
