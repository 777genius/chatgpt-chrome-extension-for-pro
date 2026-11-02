import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";

type WorkerMessage = Record<string, unknown>;
type Callback = (...args: any[]) => unknown;

test("compiled MV3 worker does not stop another chat using unallocated root-page receipts", async () => {
  const target = "https://chatgpt.com/c/other-conversation";
  const storage: Record<string, unknown> = {};
  const listeners: Record<string, Callback> = {};
  const event = (name: string) => ({
    addListener(handler: Callback) { listeners[name] = handler; },
  });
  const chrome = {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const selected = keys === null ? Object.keys(storage) :
            Array.isArray(keys) ? keys : [keys];
          return structuredClone(Object.fromEntries(selected.map(key => [key, storage[key]])));
        },
        async set(value: Record<string, unknown>) {
          Object.assign(storage, structuredClone(value));
        },
      },
    },
    runtime: {
      id: "test-extension", getManifest: () => ({ version: "test" }),
      getURL: (path: string) => path, getContexts: async () => [{}],
      sendMessage: async () => ({}),
      onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"),
    },
    tabs: {
      get: async () => ({ id: 7, url: target, active: false, windowId: 1 }),
      query: async () => [],
      sendMessage: async () => ({}),
      onRemoved: event("removed"),
    },
    windows: { get: async () => ({ focused: false }) },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    webRequest: {
      onBeforeRequest: event("before"),
      onCompleted: event("complete"),
      onErrorOccurred: event("error"),
    },
    notifications: {
      getAll: async () => ({}),
      create: async (id: string) => id,
      clear: async () => true,
      onClicked: event("clicked"),
    },
  };
  const ctx = createContext({ chrome, console, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout });
  ctx.importScripts = (name: string) => {
    runInContext(readFileSync("dist/extension/" + name, "utf8"), ctx, { filename: name });
  };
  runInContext(readFileSync("dist/extension/service-worker.js", "utf8"), ctx,
    { filename: "service-worker.js" });
  assert.equal(typeof listeners.before, "function");
  assert.equal(typeof listeners.message, "function");

  listeners.before!({
    tabId: 7,
    method: "POST",
    requestId: "root-request",
    timeStamp: 1000,
    documentUrl: "https://chatgpt.com/",
    url: "https://chatgpt.com/backend-api/f/conversation",
  });
  await flush();
  await flush();

  const checkpoint = () => runInContext("completionCheckpointRead(7)", ctx) as
    Promise<{ state: string; url: string; requestId: string; startedAt: number }>;
  assert.equal((await checkpoint()).url, "https://chatgpt.com/");

  const sendStop = async () => new Promise<Record<string, unknown>>(resolve => {
    listeners.message!({
      type: "CHATGPT_GENERATION_STOPPED",
      url: target, startedAt: 1000, requestId: "root-request",
    } as WorkerMessage, {
      frameId: 0, tab: { id: 7, url: target, active: false, windowId: 1 },
    }, resolve);
  });
  await sendStop();
  assert.equal((await checkpoint()).state, "active",
    "a root-page request with no native destination must not finish another chat");

  const allocated = await runInContext(
    "completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/other-conversation'," +
    "startedAt:1000,requestId:'root-request',baselineKey:''," +
    "promptKey:'/c/other-conversation|native-user'})", ctx,
  ) as boolean;
  assert.equal(allocated, true, "native-evidence allocation may bind the root attempt");
  await sendStop();
  assert.equal((await checkpoint()).state, "stopped",
    "an allocated destination must still be allowed to stop its own exact request");
});
