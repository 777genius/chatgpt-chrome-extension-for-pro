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

{
 const h=harness(),j=h.boot();
 await j.append({kind:'handoff.navigating',sourceUrl:url,operationId:'handoff-one'});
 for(const kind of ['retry.planned','retry.send_intent'])
  await assert.rejects(()=>j.append({kind,sourceUrl:url,operationId:'retry-old',attemptId:'999999',promptKey:'changed-prompt'}),/Автоповтор/,
   'a source handoff fences a later retry even when the DOM prompt key changes');
 const restarted=h.boot();
 await assert.rejects(()=>restarted.append({kind:'retry.planned',sourceUrl:url,operationId:'retry-restart',attemptId:'999999',promptKey:'other-prompt'}),/Автоповтор/,
  'the source handoff fence survives worker restart');
 h.advance(2);await restarted.append({kind:'retry.preparation_superseded',sourceUrl:url,requestId:'manual-new',startedAt:1000001});
 await assert.rejects(()=>restarted.append({kind:'retry.planned',sourceUrl:url,operationId:'retry-stale',attemptId:'999999',promptKey:'old'}),/Автоповтор/,
  'a newer manual send never reauthorizes an old attempt');
 await restarted.append({kind:'retry.planned',sourceUrl:url,operationId:'retry-new',attemptId:'1000001',promptKey:'new-user'});
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

// A delayed manual ACK must reset old failures without cancelling a newer
// retry or its backup, even if that new failure belongs to the manual request.
const ordered=harness();const orderedRuntime=ordered.boot();
await orderedRuntime.append(retry('999000','old-turn'));
ordered.advance(150);
await orderedRuntime.append(retry('1000100','new-turn'));
await orderedRuntime.append({kind:'retry.blocked',reason:'New failure'});
await orderedRuntime.append({kind:'retry.planned',operationId:'new-op',attemptId:'1000100',promptKey:'new-turn'});
await orderedRuntime.append({kind:'draft.saved',operationId:'new-op',attemptId:'1000100',draft:'New exact owner draft'});
await orderedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000100});
assert.equal((await orderedRuntime.read())!.failures.length,1,'delayed ACK prunes only failures before its real request');
assert.equal((await orderedRuntime.read())!.blocked,true,'new failure remains blocked');
const orderedMeta=ordered.storage[metaKey] as any;
assert.equal(orderedMeta.retryDraftByChat[url].phase,'saved','new draft is not superseded by old ACK');
assert.equal(orderedMeta.retryPreparingByChat[url].operationId,'new-op','new preparation retains ownership');
await orderedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000200});
assert.equal(await orderedRuntime.read(),null,'a later actual manual request can reset the old failure');
assert.equal((ordered.storage[metaKey] as any).retryDraftByChat[url].phase,'superseded');
assert.equal((ordered.storage[metaKey] as any).retryPreparingByChat[url],undefined);
console.log('PASS: verified manual request cutoff preserves newer failures, drafts and preparation ownership');

const inherited=harness();const inheritedRuntime=inherited.boot();
await inheritedRuntime.append(retry('999000','old-turn'));
await inheritedRuntime.append({kind:'retry.blocked',reason:'Old terminal restriction',terminal:true});
await inheritedRuntime.append({kind:'retry.resume',remainingRetries:1});
await inheritedRuntime.append({kind:'retry.planned',operationId:'old-budget',attemptId:'999000',promptKey:'old-turn'});
await inheritedRuntime.append({kind:'retry.cancelled',operationId:'old-budget'});
await inheritedRuntime.append({kind:'retry.blocked',attemptId:'999000',reason:'Old block',terminal:true});
inherited.advance(150);
await inheritedRuntime.append(retry('1000100','manual-turn'));
await inheritedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000100});
const inheritedState=(await inheritedRuntime.read())!;
assert.equal(inheritedState.blocked,false,'new error cannot inherit a restriction from before the actual manual request');
assert.equal(inheritedState.terminal,false);
assert.equal((inheritedState as any).remainingRetries,undefined,'old exhausted extra budget cannot survive the reset');
assert.equal(inheritedState.failures.length,1);
console.log('PASS: delayed manual ACK clears inherited restrictions without deleting the new failure');

const fenced=harness();let fencedRuntime=fenced.boot();
await fencedRuntime.append(retry('999000','old-turn'));
await fencedRuntime.append({kind:'retry.planned',operationId:'old-op',attemptId:'999000',promptKey:'old-turn'});
await fencedRuntime.append({kind:'draft.saved',operationId:'old-op',attemptId:'999000',draft:'Old exact draft'});
await fencedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000100});
fencedRuntime=fenced.boot();
await fencedRuntime.append({kind:'retry.failed',operationId:'old-op',attemptId:'999000',clicked:false,error:'Late old failure'});
await fencedRuntime.append({kind:'retry.cancelled',operationId:'old-op',attemptId:'999000'});
await fencedRuntime.append({kind:'retry.confirmed',operationId:'old-op',attemptId:'999000'});
await fencedRuntime.append(retry('999000','old-turn'));
assert.equal(await fencedRuntime.read(),null,'late old callbacks cannot reblock or recount after a verified manual send and restart');
assert.equal((fenced.storage[metaKey] as any).retryDraftByChat[url].phase,'superseded','late lifecycle events cannot make an old draft claimable again');
assert.equal(Object.entries(fenced.storage).filter(([key,value])=>key.startsWith(prefix)&&['retry.failed','retry.cancelled','retry.confirmed'].includes((value as JournalEvent).kind)).length,3,'ignored late callbacks remain in immutable history');
await assert.rejects(fencedRuntime.append({kind:'retry.planned',operationId:'late-old-plan',attemptId:'999000',promptKey:'old-turn'}),/уже запускался/,'an old attempt cannot reacquire preparation ownership');
await fencedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000000});
assert.equal((fenced.storage[metaKey] as any).retryByChat['source-chat'].manualStartedAt,1000100,'a delayed older ACK cannot regress the cutoff');
fenced.advance(150);
await fencedRuntime.append(retry('1000100','manual-turn'));
assert.equal((await fencedRuntime.read())!.failures.length,1,'the actual manual request can still record its own new failure');
await fencedRuntime.append({kind:'retry.planned',operationId:'new-op',attemptId:'1000100',promptKey:'manual-turn'});
await fencedRuntime.append({kind:'draft.saved',operationId:'new-op',attemptId:'1000100',draft:'New exact draft'});
assert.equal((fenced.storage[metaKey] as any).retryDraftByChat[url].phase,'saved','a new operation can save its own draft after supersession');
const staleBackup=await fencedRuntime.append({kind:'draft.saved',operationId:'late-other-op',attemptId:'999000',draft:'Late stale backup'});
assert.equal(staleBackup.ok,false,'the old client must stop before replacing the editor');
assert.equal(staleBackup.duplicate,true);
assert.equal((fenced.storage[metaKey] as any).retryDraftByChat[url].operationId,'new-op','a delayed old backup cannot replace the new draft index');
await fencedRuntime.append({kind:'retry.resume',remainingRetries:2});
await fencedRuntime.append({kind:'retry.failed',attemptId:'999000',error:'Old callback after an explicit grant'});
await assert.rejects(fencedRuntime.append({kind:'retry.planned',operationId:'old-budget-plan',attemptId:'999000',promptKey:'old-turn'}),/уже запускался/);
assert.equal((await fencedRuntime.read())!.blocked,false,'an explicit grant retains the old-attempt fence');
assert.equal((await fencedRuntime.read() as any).remainingRetries,2,'a stale plan cannot consume a new explicit grant');
await fencedRuntime.append({kind:'retry.failed',attemptId:'0',error:'Unbound failure'});
assert.equal((await fencedRuntime.read())!.blocked,true,'zero or missing attempts keep the existing conservative policy');
console.log('PASS: persisted manual cutoff fences late old callbacks, preparation and budget while preserving new errors and unknown-attempt policy');

// Unknown-attempt visible-error retries are valid, but a known released
// operation must remain retired even if a delayed backup omits its attempt.
const released=harness();let releasedRuntime=released.boot();
await releasedRuntime.append({kind:'retry.planned',operationId:'released-no-attempt',attemptId:'',promptKey:'visible-error'});
await releasedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000100});
assert.ok((released.storage[metaKey] as any).retryReleasedOperations['released-no-attempt']);
releasedRuntime=released.boot();
await releasedRuntime.append({kind:'retry.planned',operationId:'current-draft',attemptId:'1000100',promptKey:'manual-error'});
await releasedRuntime.append({kind:'draft.saved',operationId:'current-draft',attemptId:'1000100',draft:'Current exact owner draft'});
const lateReleased=await releasedRuntime.append({kind:'draft.saved',operationId:'released-no-attempt',attemptId:'',draft:'Stale detached backup'});
assert.equal(lateReleased.ok,false);assert.equal(lateReleased.duplicate,true);
assert.equal((released.storage[metaKey] as any).retryDraftByChat[url].operationId,'current-draft','late unbound callback cannot overwrite the newer draft index');
await assert.rejects(releasedRuntime.append({kind:'retry.planned',operationId:'released-no-attempt',attemptId:'',promptKey:'visible-error'}),/уже запускался/);
await releasedRuntime.append({kind:'retry.finished',operationId:'current-draft',clicked:false});
await releasedRuntime.append({kind:'retry.planned',operationId:'fresh-no-attempt',attemptId:'',promptKey:'new-visible-error'});
assert.equal((await releasedRuntime.append({kind:'draft.saved',operationId:'fresh-no-attempt',attemptId:'',draft:'Fresh visible-error draft'})).ok,true,'a fresh valid visible-error retry need not fabricate a positive attempt ID');
await releasedRuntime.append({kind:'retry.preparation_superseded',startedAt:1000200});
releasedRuntime=released.boot();
const lateSuperseded=await releasedRuntime.append({kind:'draft.saved',operationId:'fresh-no-attempt',draft:'Late after restart'});
assert.equal(lateSuperseded.ok,false);assert.equal((released.storage[metaKey] as any).retryDraftByChat[url].phase,'superseded');
console.log('PASS: retired retry operation IDs fence late unbound draft backups across restart without rejecting fresh visible-error operations');
