import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Cleanup = () => void;
type Slot = { replace(cleanup: Cleanup): Cleanup; cancel(): void };
type MemoryApi = { createLatestTaskSlot(): Slot };
type WatcherSession = {
  get(key: string): Promise<Record<string, { version: string } | undefined>>;
  set(value: Record<string, { version: string }>): Promise<void>;
};
type WatcherApi = {
  create(options: {session: WatcherSession | null; version: string; install(): Promise<void>}):
    {ensure(): Promise<boolean>} | null;
};
type Tick = { type: "CHATGPT_STATUS_TICK"; frame: number; url: string };
type AnimationApi = {
  create(options: {send(id: number, message: Tick): Promise<{ok: boolean}>;
    setTimeout(fn: () => void, delay: number): number; clearTimeout(id: number): void}):
    {set(id: number, url: string, loading: boolean): void; setEnabled(value: boolean): void;
      remove(id: number): void; dispose(): void};
};

function load<T>(directory: "extension" | "dist/extension", name: string, globalName: string): T {
  const source = readFileSync(new URL("../" + directory + "/" + name + ".js", import.meta.url), "utf8");
  const context: Record<string, unknown> = { URL };
  runInNewContext(source, context, { filename: name + ".js" });
  const value: unknown = context[globalName];
  assert.ok(value && typeof value === "object", globalName + " absent after evaluation");
  return value as T;
}

test("typed task-slot emit retains original cleanup ownership", () => {
  function observe(api: MemoryApi): string[] {
    const events: string[] = [];
    const slot = api.createLatestTaskSlot();
    const staleRelease = slot.replace(() => { events.push("first"); });
    slot.replace(() => { events.push("second"); });
    staleRelease();
    slot.cancel();
    slot.cancel();
    const fails = api.createLatestTaskSlot();
    fails.replace(() => { events.push("throws"); throw new Error("cleanup"); });
    assert.throws(() => fails.replace(() => { events.push("reclaimed"); }), /cleanup/);
    fails.cancel();
    return events;
  }
  const baseline = observe(load<MemoryApi>("extension", "memory-maintenance", "ChatGPTNotifierMemory"));
  const migrated = observe(load<MemoryApi>("dist/extension", "memory-maintenance", "ChatGPTNotifierMemory"));
  assert.deepEqual(migrated, baseline);
  assert.deepEqual(migrated, ["first", "second", "throws", "reclaimed"]);
});

test("typed watcher emit preserves one installation, even with concurrent wakeups", async () => {
  async function observe(api: WatcherApi): Promise<(boolean | number)[]> {
    const saved: Record<string, { version: string }> = {};
    let installations = 0;
    const session: WatcherSession = {
      async get(key) { return { [key]: saved[key] }; },
      async set(value) { Object.assign(saved, value); },
    };
    const handle = api.create({
      session, version: "1.6.1",
      install: async () => { installations++; await Promise.resolve(); },
    });
    assert.ok(handle);
    const sameWake = await Promise.all([handle.ensure(), handle.ensure()]);
    const onceReady = await handle.ensure();
    const second = api.create({ session, version: "1.6.1", install: async () => { installations++; } });
    assert.ok(second);
    const persisted = await second.ensure();
    return [...sameWake, onceReady, persisted, installations];
  }
  const baseline = await observe(load<WatcherApi>("extension", "watcher-bootstrap", "ChatGPTWatcherBootstrap"));
  const migrated = await observe(load<WatcherApi>("dist/extension", "watcher-bootstrap", "ChatGPTWatcherBootstrap"));
  assert.deepEqual(migrated, baseline);
  assert.deepEqual(migrated, [true, true, false, false, 1]);
});

test("typed animation emit keeps acknowledgement and disposal behavior", async () => {
  async function observe(api: AnimationApi): Promise<string[]> {
    const events: string[] = [];
    let nextId = 0;
    const tasks = new Map<number, () => void>();
    const runner = api.create({
      send: async (tab, message) => {
        events.push("tick:" + tab + ":" + message.frame);
        return { ok: true };
      },
      setTimeout(fn, delay) {
        events.push("schedule:" + delay);
        tasks.set(++nextId, fn);
        return nextId;
      },
      clearTimeout(id) { events.push("cancel:" + id); tasks.delete(id); },
    });
    runner.set(1, "https://chatgpt.com/c/a", true);
    const fire = tasks.entries().next().value;
    assert.ok(fire);
    tasks.delete(fire[0]);
    fire[1]();
    await Promise.resolve();
    await Promise.resolve();
    runner.setEnabled(false);
    runner.dispose();
    return events;
  }
  const baseline = await observe(load<AnimationApi>("extension", "status-animation", "ChatGPTStatusAnimation"));
  const migrated = await observe(load<AnimationApi>("dist/extension", "status-animation", "ChatGPTStatusAnimation"));
  assert.deepEqual(migrated, baseline);
  assert.ok(migrated.includes("tick:1:0"));
});


type TitleLineage = {
  version: 1; sourceUrl: string; baseTitle: string; part: number; title: string;
  targetUrl: string; transferred: boolean; confirmed: boolean;
};
type TitleApi = {
  chatUrl(value: string): string;
  planNext(options: {sourceUrl: string; sourceTitle: string; lineage?: TitleLineage | null}):
    {version: 1; sourceUrl: string; baseTitle: string; part: number; title: string};
  confirm(naming: {version: 1; sourceUrl: string; baseTitle: string; part: number; title: string},
    targetUrl: string): TitleLineage;
};
test("typed title policy retains lineage and rejects identical handoff targets", () => {
  function observe(api: TitleApi): string[] {
    const first = api.planNext({ sourceUrl: "https://chatgpt.com/c/one", sourceTitle: "Task" });
    const confirmed = api.confirm(first, "https://chatgpt.com/c/two");
    const next = api.planNext({
      sourceUrl: confirmed.targetUrl, sourceTitle: confirmed.title, lineage: confirmed,
    });
    assert.throws(() => api.confirm(first, first.sourceUrl), /Invalid continuation/);
    return [first.title, next.title, confirmed.targetUrl, api.chatUrl("https://evil.example/c/one")];
  }
  const baseline = observe(load<TitleApi>("extension", "handoff-title", "ChatGPTHandoffTitle"));
  const migrated = observe(load<TitleApi>("dist/extension", "handoff-title", "ChatGPTHandoffTitle"));
  assert.deepEqual(migrated, baseline);
  assert.deepEqual(migrated, ["Task (1)", "Task (2)", "https://chatgpt.com/c/two", ""]);
});

type Attempt = {id: string; url: string; baselineKey: string; promptKey?: string};
type Snapshot = {
  url: string; attemptId: string; promptKey: string; assistantKey: string;
  isLatest: boolean; isReadOnly: boolean; generating: boolean; hasError: boolean;
  turnStatus: string; assistantCompleted: boolean; assistantPhase: string;
};
type CompletionPolicy = {
  bindAttemptPrompt(attempt: Attempt | null, snapshot: Snapshot | null): Attempt | null;
  completedAttemptEvidence(attempt: Attempt | null, snapshot: Snapshot | null):
    {attemptId: string; promptKey: string; assistantKey: string} | null;
};
function loadCompletion(directory: "extension" | "dist/extension"): CompletionPolicy {
  const content = readFileSync(new URL("../" + directory + "/completion-state.js", import.meta.url), "utf8");
  const context: { module: { exports: Record<string, unknown> } } = { module: { exports: {} } };
  runInNewContext(content, context);
  const exports: unknown = context.module.exports;
  assert.ok(exports && typeof exports === "object");
  assert.ok("bindAttemptPrompt" in exports && typeof exports.bindAttemptPrompt === "function");
  assert.ok("completedAttemptEvidence" in exports && typeof exports.completedAttemptEvidence === "function");
  return exports as CompletionPolicy;
}
test("typed completion policy cannot promote stale or generating turns", () => {
  function observe(api: CompletionPolicy): string[] {
    const raw: Attempt = {id: "attempt-1", url: "https://chatgpt.com/c/one", baselineKey: "old"};
    const snapshot: Snapshot = {
      url: raw.url, attemptId: raw.id, promptKey: "new", assistantKey: "answer-1",
      isLatest: true, isReadOnly: false, generating: false, hasError: false,
      turnStatus: "complete", assistantCompleted: true, assistantPhase: "final_answer",
    };
    const bound = api.bindAttemptPrompt(raw, snapshot);
    assert.ok(bound);
    const confirmed = api.completedAttemptEvidence(bound, snapshot);
    const generating = api.completedAttemptEvidence(bound, {...snapshot, generating: true});
    const stale = api.completedAttemptEvidence(bound, {...snapshot, assistantPhase: "analysis"});
    return [confirmed?.assistantKey ?? "", String(generating), String(stale)];
  }
  const baseline = observe(loadCompletion("extension"));
  const migrated = observe(loadCompletion("dist/extension"));
  assert.deepEqual(migrated, baseline);
  assert.deepEqual(migrated, ["answer-1", "null", "null"]);
});
