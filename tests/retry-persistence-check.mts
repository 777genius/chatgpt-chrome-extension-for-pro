import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';

type Stored = Record<string, unknown>;
interface RetryState {
  failures: number[];
  lastPromptKey?: string;
  lastAttemptId?: string;
  blocked?: boolean;
  terminal?: boolean;
  reason?: string;
}
interface JournalEvent extends Stored {
  kind: string;
  sourceUrl?: string;
  recordedAt?: number;
  eventAt?: number;
}
const metaKey = 'chatgpt-journal:meta';
const prefix = 'chatgpt-journal:event:';
const source = readFileSync('extension/journal-store.js', 'utf8');
const url = 'https://chatgpt.com/c/source-chat';
const eventKey = (sequence: number) => `${prefix}${String(sequence).padStart(12, '0')}`;

function harness(storage: Stored = {}, initialClock = 1000000) {
  let clock = initialClock;
  let failing = false;
  const reads: Array<string | string[] | null> = [];
  const writes: Stored[] = [];
  function boot() {
    const context = createContext({URL, console: {error() {}},
      Date: class extends Date {static now() {return clock;}},
      chrome: {runtime: {getManifest: () => ({version: 'test'})}, storage: {local: {
        async get(keys: string | string[] | null) {
          reads.push(keys);
          assert.notEqual(keys, null, 'retry restoration/migration must never read the full log');
          const wanted = Array.isArray(keys) ? keys : [keys as string];
          return structuredClone(Object.fromEntries(wanted.map(key => [key, storage[key]])));
        },
        async set(values: Stored) {
          if (failing) throw new Error('Disk full');
          writes.push(structuredClone(values));
          Object.assign(storage, structuredClone(values));
        }
      }}}
    });
    runInContext(source, context);
    return {
      async append(event: JournalEvent) {
        context.event = event;
        return await runInContext('appendJournal(event,{id:7,url:"https://chatgpt.com/c/source-chat"})', context);
      },
      async read(target = url): Promise<RetryState | null> {
        context.target = target;
        return await runInContext('readRetryState(target)', context) as RetryState | null;
      }
    };
  }
  return {storage, reads, writes, boot, advance(ms: number) {clock += ms;}, fail(value: boolean) {failing = value;}};
}
function retry(attempt: string, promptKey = 'prompt'): JournalEvent {
  return {kind: 'error.detected', action: 'retry', attemptId: attempt, promptKey};
}

const live = harness();
let runtime = live.boot();
await Promise.all([runtime.append(retry('one')), runtime.append(retry('two')), runtime.append(retry('one'))]);
let state = (await runtime.read())!;
assert.equal(state.failures.length, 2, 'interleaved duplicate prompt+attempt counts once');
assert.equal(state.lastAttemptId, 'one');
assert.equal(state.lastPromptKey, 'prompt');
const firstWrite = live.writes[0];
assert.ok(firstWrite[eventKey(1)] && firstWrite[metaKey], 'each event and retry summary share one atomic write');
live.advance(120001);
state = (await runtime.read())!;
assert.equal(state.failures.length, 0, 'reading a restart summary uses the current rolling window');
await runtime.append(retry('three'));
assert.equal((await runtime.read())!.failures.length, 1);
await runtime.append({kind: 'retry.blocked', reason: 'three failures', terminal: true});
live.advance(600000);
runtime = live.boot();
state = (await runtime.read())!;
assert.equal(state.blocked, true, 'restart and elapsed time cannot lift a sticky block');
assert.equal(state.terminal, true);
assert.equal(state.reason, 'three failures');
await runtime.append({kind: 'retry.failed', error: 'uncertain send'});
state = (await runtime.read())!;
assert.equal(state.reason, 'uncertain send');
assert.equal(state.terminal, true, 'a later nonterminal failure cannot weaken terminal state');
await runtime.append({kind: 'retry.manual_reset'});
assert.equal(await runtime.read(), null, 'only a deliberate manual reset clears the chat summary');
assert.equal(Object.keys(live.storage).filter(key => key.startsWith(prefix)).length, 7,
  'manual reset preserves every durable event');
await runtime.append({kind: 'draft.restore_failed', error: 'draft restore refused'});
assert.equal((await runtime.read())!.blocked, true, 'draft restore failure persists a stop');
assert.equal(await runtime.read('https://example.com/c/source-chat'), null, 'chat IDs must be canonical ChatGPT URLs');

// Upgrade old immutable logs in batches and race a new append behind migration.
const legacy: Stored = {[metaKey]: {sequence: 125, active: {7: {operationId: 'keep'}}, requests: {r: {operationId: 'keep'}}}};
for (let sequence = 1; sequence <= 125; sequence += 1) {
  legacy[eventKey(sequence)] = {kind: 'watcher.started', sequence, sourceUrl: url, recordedAt: 900000};
}
legacy[eventKey(2)] = {...retry('legacy-one'), sequence: 2, sourceUrl: url, recordedAt: 900000};
legacy[eventKey(3)] = {...retry('legacy-one'), sequence: 3, sourceUrl: url, recordedAt: 900001};
legacy[eventKey(54)] = {kind: 'retry.blocked', sourceUrl: url, reason: 'legacy sticky stop', terminal: true, sequence: 54, recordedAt: 950000};
legacy[eventKey(90)] = {kind: 'retry.manual_reset', sourceUrl: 'https://chatgpt.com/c/different-chat', sequence: 90, recordedAt: 980000};
legacy[eventKey(124)] = {kind: 'handoff.navigating', sourceUrl: url, text: 'FULL HISTORY\n'.repeat(10000), sequence: 124, recordedAt: 999999};
const originalLogs = structuredClone(Object.fromEntries(Object.entries(legacy).filter(([key]) => key.startsWith(prefix))));
const upgraded = harness(legacy);
const upgradedRuntime = upgraded.boot();
const restoration = upgradedRuntime.read();
const newError = upgradedRuntime.append(retry('after-upgrade'));
const migrated = (await restoration)!;
assert.equal(migrated.failures.length, 1);
assert.equal(migrated.blocked, true);
assert.equal(migrated.terminal, true);
await newError;
assert.equal((await upgradedRuntime.read())!.failures.length, 2, 'a concurrent append cannot be overwritten by migration');
assert.deepEqual(upgraded.reads.filter(Array.isArray).map(batch => batch.length), [50, 50, 25]);
assert.deepEqual(upgraded.writes[0], {[metaKey]: upgraded.writes[0][metaKey]}, 'migration writes metadata only');
for (const [key, event] of Object.entries(originalLogs)) assert.deepEqual(legacy[key], event, `immutable event ${key} changed`);
const meta = legacy[metaKey] as {retrySchema: number; sequence: number; active: unknown; requests: unknown};
assert.equal(meta.retrySchema, 1);
assert.equal(meta.sequence, 126);
assert.deepEqual(meta.active, {7: {operationId: 'keep'}});
assert.deepEqual(meta.requests, {r: {operationId: 'keep'}});

const beforeFailure = structuredClone(live.storage);
live.fail(true);
await assert.rejects(runtime.append({kind: 'retry.manual_reset'}), /Disk full/);
assert.deepEqual(live.storage, beforeFailure, 'failed writes cannot reset sticky state or lose events');
live.fail(false);
assert.equal((await live.boot().read())!.blocked, true);
await runtime.append({kind:'retry.resume',remainingRetries:2,reason:'Explicit user request'});
assert.equal((await runtime.read())!.blocked,false);
assert.equal((await runtime.read() as any).remainingRetries,2);
await runtime.append({kind:'retry.planned',operationId:'extra-one'});
await runtime.append({kind:'retry.planned',operationId:'extra-one'});
assert.equal((await live.boot().read() as any).remainingRetries,1,'one operation consumes its extra budget exactly once');
await runtime.append({kind:'retry.planned',operationId:'extra-two'});
assert.equal((await live.boot().read() as any).remainingRetries,0);
console.log('PASS: atomic retry summaries, duplicate detection, rolling counts, sticky restart blocks, terminal state, manual reset, bounded migration, concurrent writes, full history preservation and disk failure');
