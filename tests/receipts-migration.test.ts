import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

// Reuse the actual classic-script surface, including serialized writes across
// worker wakeups. No browser, credential, or real ChatGPT conversation is used.
async function scenario(folder: "extension" | "dist/extension"): Promise<unknown[]> {
  const state: Record<string, unknown> = {};
  const storage = {
    async get(key: string) { return structuredClone({ [key]: state[key] }); },
    async set(values: Record<string, unknown>) {
      Object.assign(state, structuredClone(values));
    },
  };
  const context = createContext({
    chrome: { storage: { session: storage, local: storage } },
    Date: { now: () => 1_000_000 },
    Promise,
  });
  const source = readFileSync(new URL("../" + folder + "/request-receipts.js", import.meta.url), "utf8");
  runInContext(source, context);
  const exec = (expression: string): Promise<unknown> => runInContext(expression, context) as Promise<unknown>;
  const added = await exec("rememberRequestReceipt(7,{requestId:'r1',startedAt:100,url:'https://chatgpt.com/c/a',receipt:{epoch:'t',order:1}})");
  const duplicate = await exec("rememberRequestReceipt(7,{requestId:'r1',startedAt:100,url:'https://chatgpt.com/c/a'})");
  const consumed = await exec("readRequestReceipt(7,{requestId:'r1',startedAt:100,url:'https://chatgpt.com/c/a',consume:true})");
  const blocked = await exec("readRequestReceipt(7,{requestId:'r1',startedAt:100,consume:true})");
  const wrongChat = await exec("readRequestReceipt(7,{requestId:'r1',url:'https://chatgpt.com/c/b'})");
  const differentTab = await exec("readRequestReceipt(9,{requestId:'r1'})");
  await exec("rememberRequestReceipt(7,{requestId:'r2',startedAt:101,url:'https://chatgpt.com/c/a'})");
  const latest = await exec("readRequestReceipt(7)");
  await exec("forgetRequestReceipts(7)");
  const afterForget = await exec("readRequestReceipt(7)");
  const actual = [added, duplicate, consumed, blocked, wrongChat, differentTab, latest, afterForget, state];
  return JSON.parse(JSON.stringify(actual)) as unknown[];
}

test("typed request receipt cache preserves one ACK, chat and tab fences", async () => {
  const baseline = await scenario("extension");
  const migrated = await scenario("dist/extension");
  assert.deepEqual(migrated, baseline);
  assert.equal(migrated[3], null, "consume ACK must not be reusable");
  assert.equal(migrated[4], null, "another chat cannot claim a receipt");
  assert.equal(migrated[5], null, "another tab cannot claim a receipt");
  assert.equal(migrated[7], null, "closed tab cache is retired");
});
