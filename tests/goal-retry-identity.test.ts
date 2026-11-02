import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

type Goal = {
  id: string;
  phase: string;
  expectedPromptKey: string | null;
  lastSendTabId?: number;
  recovery?: {operationId:string;sourcePromptKey:string;tabId:number}|null;
  operation: {id:string;text:string;tabId:number}|null;
};
type GoalStore = {
  start(input: Record<string, unknown>): Promise<{ok:boolean}>;
  intent(input: Record<string, unknown>): Promise<unknown>;
  report(input: Record<string, unknown>): Promise<unknown>;
  retry(input: Record<string, unknown>): Promise<void>;
};
test("compiled Goal accepts only the recovery operation for its own failed turn", async () => {
  const url = "https://chatgpt.com/c/goal-retry-identity";
  const key = "chatgpt-goal:" + url;
  const saved: Record<string, unknown> = {};
  let nextId = 0;
  const storage = {
    async get(name: string) { return { [name]: structuredClone(saved[name]) }; },
    async set(values: Record<string, unknown>) { Object.assign(saved, structuredClone(values)); },
  };
  const tabs = {
    async get(id: number) { return {id, url}; },
    async sendMessage() { return {ok:true}; },
  };
  const journal = async () => ({} as Record<string, unknown>);
  const context = createContext({ URL });
  for (const name of ["goal-policy.js", "goal-store.js"]) {
    runInContext(readFileSync("dist/extension/" + name, "utf8"), context, {filename:name});
  }
  const api = runInContext("ChatGPTGoalStore", context) as {
    create(host: Record<string, unknown>): GoalStore;
  };
  const create = () => api.create({
    storage, tabs, appendJournal: journal,
    now: () => 10_000, uuid: () => "goal-op-" + ++nextId,
  });
  const store = create();
  const state = () => saved[key] as Goal;
  await store.start({
    url, tabId: 7, goal: "Finish all CI",
    rules: "Only verify actual results", maxContinuations: 4, maxMinutes: 60,
  });
  const op = state().operation;
  assert.ok(op);
  await store.intent({url,tabId:7,id:state().id,operationId:op.id,
    text:op.text,baselineKey:"/c/goal-retry-identity|previous"});
  await store.report({url,tabId:7,id:state().id,operationId:op.id,status:"clicked"});
  const expected = "/c/goal-retry-identity|goal-user";
  await store.report({url,tabId:7,id:state().id,operationId:op.id,
    status:"confirmed",newPromptKey:expected});
  assert.equal(state().lastSendTabId, 7);
  assert.equal(state().phase, "waiting");

  const retry = (kind:string, operationId:string, tabId=7,
    sourcePromptKey=expected, promptKey?:string) =>
    store.retry({url,tabId,kind,operationId,sourcePromptKey,promptKey});
  await retry("retry.planned","other-tab",8);
  await retry("retry.planned","other-turn",7,"/c/goal-retry-identity|unrelated");
  await retry("retry.confirmed","unknown",7,expected,
    "/c/goal-retry-identity|intruder");
  assert.equal(state().phase,"waiting");
  assert.equal(state().expectedPromptKey,expected);
  assert.equal(state().recovery ?? null,null);

  await retry("retry.planned","own-retry");
  assert.equal(state().phase,"recovering");
  assert.equal(state().recovery?.operationId,"own-retry");
  await retry("retry.planned","other-retry");
  await retry("retry.confirmed","other-retry",7,expected,
    "/c/goal-retry-identity|intruder");
  await retry("retry.failed","other-retry");
  assert.equal(state().expectedPromptKey,expected,
    "foreign events cannot replace the expected Goal answer");
  assert.equal(state().phase,"recovering","a different retry cannot block Goal");

  // A service-worker restart must retain the retry's owner association.
  const restored = create();
  const newKey="/c/goal-retry-identity|retry-user";
  await restored.retry({url,tabId:7,kind:"retry.confirmed",
    operationId:"own-retry",sourcePromptKey:expected,promptKey:newKey});
  assert.equal(state().phase,"waiting");
  assert.equal(state().expectedPromptKey,newKey);
  assert.equal(state().recovery ?? null,null);
  await retry("retry.confirmed","own-retry",7,expected,
    "/c/goal-retry-identity|replayed");
  assert.equal(state().expectedPromptKey,newKey,"replayed ACK cannot retarget Goal again");
});
