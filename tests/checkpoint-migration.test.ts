import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

async function scenario(dir: "extension" | "dist/extension"): Promise<unknown[]> {
  const records: Record<string, unknown> = {};
  const context = createContext({
    URL,
    Promise,
    chrome: {
      storage: { local: {
        async get(key: string) { return structuredClone({ [key]: records[key] }); },
        async set(value: Record<string, unknown>) { Object.assign(records, structuredClone(value)); },
      } },
    },
  });
  const source = readFileSync(new URL("../" + dir + "/completion-checkpoint.js", import.meta.url), "utf8");
  runInContext(source, context);
  const run = (command: string): Promise<unknown> => runInContext(command, context) as Promise<unknown>;
  const observations: unknown[] = [];
  observations.push(await run("completionCheckpointIntent(7,{url:'https://chatgpt.com/c/a',at:100,baselineKey:'old'})"));
  observations.push(await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'one'})"));
  observations.push(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'one',promptKey:'old'})"));
  observations.push(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'one',promptKey:'new'})"));
  observations.push(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/b',startedAt:101,requestId:'one',promptKey:'new'})"));
  observations.push(await run("completionCheckpointFinish(7,101,'stopped','one')"));
  observations.push(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'one',promptKey:'new'})"));
  observations.push(await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:200,requestId:'two'})"));
  observations.push(await run("completionCheckpointFinish(7,101,'complete','one')"));
  observations.push(await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:100,requestId:'late'})"));
  observations.push(await run("completionCheckpointFinish(7,200,'complete','two')"));
  observations.push(await run("completionCheckpointFinish(7,200,'complete','two')"));
  observations.push(await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:200,requestId:'three'})"));
  observations.push(await run("completionCheckpointFinish(7,200,'complete','two')"));
  observations.push(await run("completionCheckpointRead(7)"));
  return JSON.parse(JSON.stringify(observations)) as unknown[];
}

test("migrated checkpoint preserves original stale-receipt and terminal guards", async () => {
  const baseline = await scenario("extension");
  const generated = await scenario("dist/extension");
  assert.deepEqual(generated, baseline, "compilation changed durable checkpoint semantics");
  assert.equal(generated[2], false, "an existing answer cannot be the new prompt");
  assert.equal(generated[3], true);
  assert.equal(generated[4], false, "another chat cannot steal evidence");
  assert.equal(generated[5], true);
  assert.equal(generated[6], false, "stopped operation cannot reactivate");
  assert.equal(generated[8], false, "old terminal must not close newer send");
  assert.equal(generated[10], true);
  assert.equal(generated[11], false, "terminal checkpoint cannot be consumed twice");
  assert.equal(generated[13], false,
    "a stale request ID cannot finish a newer same-millisecond checkpoint");
});
