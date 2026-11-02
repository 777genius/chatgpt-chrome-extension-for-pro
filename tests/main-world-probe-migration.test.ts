import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

// MAIN-world functions are sent to chrome.scripting as serialized functions.
// A successful parse of the full script does not prove the individual function
// is self-contained. These tests run it without the content-script's globals.
type ProbeName =
  | "inspectChatError"
  | "inspectChatAttachment"
  | "inspectHandoffAcceptance"
  | "controlChatComposer";

const names: readonly ProbeName[] = [
  "inspectChatError",
  "inspectChatAttachment",
  "inspectHandoffAcceptance",
  "controlChatComposer",
];

function inspect(directory: "extension" | "dist/extension", name: ProbeName): unknown {
  const script = readFileSync(new URL("../" + directory + "/page-probe.js", import.meta.url), "utf8");
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const location = {
    origin: "https://chatgpt.com",
    pathname: "/c/synthetic-test",
    href: "https://chatgpt.com/c/synthetic-test",
  };
  const owner = createContext({ URL, document, location });
  runInContext(script, owner, { filename: directory + "/page-probe.js" });
  const fn: unknown = runInContext(name + ".toString()", owner);
  assert.equal(typeof fn, "string");

  // Only web-platform values are passed to the second realm. No variable
  // defined alongside the original function may be accessed here.
  const isolated = createContext({ URL, document, location });
  runInContext("const probe = (" + fn + ");", isolated);
  const args = name === "inspectChatError"
    ? [0, false, null, location.href, ""]
    : name === "inspectChatAttachment"
      ? ["synthetic-history.txt"]
      : name === "inspectHandoffAcceptance"
        ? [{ sourceUrl: location.href, submittedText: "synthetic text" }]
        : [{ action: "send", url: location.href, text: "synthetic text", requireMax: true }];
  const result: unknown = runInContext("probe(" + args.map(arg => JSON.stringify(arg)).join(",") + ")", isolated);
  const serialized = JSON.stringify(result);
  assert.equal(typeof serialized, "string", "MAIN probe must always return structured evidence");
  return JSON.parse(serialized) as unknown;
}

test("all MAIN-world probes remain standalone after strict TypeScript emission", () => {
  for (const name of names) {
    const baseline = inspect("extension", name);
    const emitted = inspect("dist/extension", name);
    assert.deepEqual(emitted, baseline, "Unexpected probe behavior change: " + name);
  }
});

test("no editor and no native handoff acknowledgement must fail closed", () => {
  const composer = inspect("dist/extension", "controlChatComposer") as { ok?: boolean; clicked?: boolean };
  assert.equal(composer.ok, false, "Missing editor must never authorize sending");
  assert.notEqual(composer.clicked, true, "The composer must never click without native proof");

  const acceptance = inspect("dist/extension", "inspectHandoffAcceptance") as {
    ok?: boolean; accepted?: boolean;
  };
  assert.equal(acceptance.ok, true);
  assert.equal(acceptance.accepted, false, "Source chat must not become a handoff destination");

  const error = inspect("dist/extension", "inspectChatError") as {
    action?: string; messages?: unknown[];
  };
  assert.equal(error.action, "unknown", "Missing rendered error must not authorize an automatic retry");
  assert.deepEqual(error.messages, []);
});
