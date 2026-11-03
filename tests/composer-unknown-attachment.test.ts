import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

type Result = { ok?: boolean; clicked?: boolean; reason?: string };

test("compiled MAIN-world composer refuses unknown or unnamed extra attachments", () => {
  const { document, window } = parseHTML(
    '<html><body><div data-app-shell-active-page="true">' +
    '<div data-composer-body><div id="editor-wrap">' +
    '<div data-composer-markdown contenteditable="true">History payload</div></div>' +
    '<button type="submit">Send</button>' +
    '<div data-composer-attachments><span id="history">history.txt</span></div>' +
    '</div></div></body></html>',
  );
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    configurable: true, value() { return [{}]; },
  });
  const editor = document.querySelector("[contenteditable]")!;
  const outer = document.querySelector("#editor-wrap")!;
  const container = document.querySelector("[data-composer-attachments]")!;
  const button = document.querySelector("button[type=submit]")!;
  let clicks = 0;
  button.addEventListener("click", () => { clicks++; });
  const controller = {
    view: { dom: editor },
    getChatGptPrompt: () => ({ prompt: "History payload" }),
    getPlainText: () => "History payload",
    submitReady: true,
    pendingSubmit: null,
  };
  (outer as unknown as Record<string, unknown>).__reactFiber$editor = {
    memoizedProps: { composerController: controller },
  };
  const attach = (node: Element, data: {name?: string;status?: string}) => {
    (node as unknown as Record<string, unknown>).__reactFiber$attachment = {
      memoizedProps: { attachment: data },
    };
  };
  const expected = document.querySelector("#history")!;
  attach(expected, { name: "history.txt", status: "ready" });

  const context = createContext({ document, URL, location: { href: "https://chatgpt.com/c/test" } });
  const bytes = readFileSync(new URL("../dist/extension/page-probe.js", import.meta.url), "utf8");
  runInContext(bytes, context);
  const check = (action: "inspect" | "send"): Result => {
    context.options = {
      action, url: "https://chatgpt.com/c/test", text: "History payload",
      fileName: "history.txt",
    };
    return runInContext("controlChatComposer(options)", context) as Result;
  };

  assert.equal(check("inspect").ok, true, "one verified ready history file is permitted");

  const opaque = document.createElement("span");
  opaque.textContent = "unknown attachment";
  container.append(opaque);
  assert.equal(check("send").ok, false,
    "a second chip without accessible React metadata must block a send");
  assert.equal(clicks, 0, "an unknown extra chip must never be clicked");
  opaque.remove();

  // One wrapper can contain multiple native files even though the
  // attachment container itself has just one direct child.
  const wrapper = document.createElement("div");
  expected.remove();
  wrapper.append(expected);
  const unnamed = document.createElement("span");
  unnamed.textContent = "upload without filename";
  attach(unnamed, { status: "ready" });
  wrapper.append(unnamed);
  container.append(wrapper);
  assert.equal(container.children.length, 1);
  assert.equal(check("inspect").ok, false,
    "unnamed native attachment metadata is not evidence of the one history file");
  assert.equal(check("send").ok, false,
    "an unnamed extra native attachment must block a send");
  assert.equal(clicks, 0);
});
