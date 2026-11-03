import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

interface LatestTaskSlot {
  replace(cleanup: () => void): () => void;
  cancel(): void;
}
interface MemoryPolicy {
  createLatestTaskSlot(): LatestTaskSlot;
}

const context = createContext({});
runInContext(readFileSync('extension/memory-maintenance.js', 'utf8'), context);
const policy = context.ChatGPTNotifierMemory as MemoryPolicy;
const slot = policy.createLatestTaskSlot();

// Regression: superseded completion watchers used to retain an observer,
// two intervals, and their answer/DOM closure until their natural timeout.
let observers = 0;
let intervals = 0;
let cancellations = 0;
const releases: Array<() => void> = [];
for (let index = 0; index < 2500; index += 1) {
  observers += 1;
  intervals += 2;
  let disposed = false;
  releases.push(slot.replace(() => {
    assert.equal(disposed, false, 'a retired watcher may only be disposed once');
    disposed = true;
    observers -= 1;
    intervals -= 2;
    cancellations += 1;
  }));
  assert.equal(observers, 1, 'only the latest watcher can remain active');
  assert.equal(intervals, 2, 'superseded watcher intervals must be cleared immediately');
}
assert.equal(cancellations, 2499);
for (const release of releases.slice(0, -1)) release();
slot.cancel();
slot.cancel();
assert.equal(observers, 0, 'disposal/reinjection must cancel the latest observer');
assert.equal(intervals, 0);
assert.equal(cancellations, 2500, 'late releases must preserve the latest cancellation');

let naturalCleanup = 0;
const release = slot.replace(() => { naturalCleanup += 1; });
// The owner already cleared its resources when its promise settled.
release();
slot.cancel();
assert.equal(naturalCleanup, 0, 'natural completion releases ownership without running cleanup twice');

let failedReplacementCleanup = 0;
slot.replace(() => { throw new Error('retirement failed'); });
assert.throws(() => slot.replace(() => { failedReplacementCleanup += 1; }), /retirement failed/);
slot.cancel();
assert.equal(failedReplacementCleanup, 1, 'a failed retirement cannot orphan its replacement');

// No persistence or page object is accepted by this policy. Preservation of
// drafts, journal and exactly-once state stays with their existing owners.
// Execute the real content script with controlled timers. These checks fail if
// its ownership wiring is omitted even while the slot's own tests pass.
interface RuntimeMessage {type: string; [key: string]: unknown;}
interface LifecycleContext {
  __chatgptNotifierDispose: () => void;
  __chatgptNotifierAlive: () => boolean;
  __chatgptNotifierAttemptId?: string;
  __chatgptNotifierRequestStartedAt?: number;
}
function lifecycleSetup(runtimeId: string | null = 'test-extension') {
  const {document, window} = parseHTML('<html><body><main></main><form><div id="prompt-textarea" contenteditable="true">Private draft</div><button data-testid="send-button">Send</button></form></body></html>');
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:240,height:32}],configurable:true});
  let turnIndex=0;
  const activeObservers = new Set<OwnedObserver>();
  class OwnedObserver {
    readonly callback: (records: unknown[]) => void;
    constructor(callback: (records: unknown[]) => void) {this.callback = callback;}
    observe() { activeObservers.add(this); }
    disconnect() { activeObservers.delete(this); }
  }
  let timerId = 0;
  let clock = 1000000;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  const listeners = new Set<(message: RuntimeMessage) => void>();
  const sent: RuntimeMessage[] = [];
  const location = {origin:'https://chatgpt.com',pathname: '/c/source', href: 'https://chatgpt.com/c/source'};
  const runtime = {
    id: runtimeId,
    onMessage: {
      addListener(listener: (message: RuntimeMessage) => void) {listeners.add(listener);},
      removeListener(listener: (message: RuntimeMessage) => void) {listeners.delete(listener);}
    },
    async sendMessage(message: RuntimeMessage) {
      sent.push(message);
      if(message.type==='CHATGPT_COMPLETION_PROBE'){
        const user=Array.from(document.querySelectorAll('[data-turn=user]')).at(-1);
        const assistant=Array.from(document.querySelectorAll('[data-turn=assistant]')).at(-1);
        return {ok:true,url:location.origin+location.pathname,promptKey:location.pathname+'|'+user?.getAttribute('data-testid'),
          assistantKey:assistant?.getAttribute('data-testid')||'',isLatest:true,isReadOnly:false,generating:false,
          hasError:false,turnStatus:assistant?'complete':'in_progress',assistantPhase:'final_answer',assistantCompleted:!!assistant};
      }
      return {ok: true, record: null};
    }
  };
  const world = createContext({document, window, location, chrome: {runtime}, AbortController, URL,
    Node: window.Node, Element: window.Element, MutationObserver: OwnedObserver, performance,
    Date: class extends Date {static now() {return clock;}},
    setInterval(callback: () => void) { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval(id: number) {intervals.delete(id);},
    setTimeout(callback: () => void) { const id = ++timerId; timeouts.set(id, callback); return id; },
    clearTimeout(id: number) {timeouts.delete(id);}
  });
  const source = readFileSync('extension/memory-maintenance.js', 'utf8') + '\n' + readFileSync('extension/handoff-title.js', 'utf8') + '\n' +
    readFileSync('extension/completion-state.js', 'utf8')+'\n'+readFileSync('extension/content-script.js', 'utf8');
  runInContext(source, world);
  const lifecycle = world as unknown as LifecycleContext;
  return {world, lifecycle, runtime, activeObservers, intervals, timeouts, listeners, sent, location,
    arm() {
      // Capture a trusted send before mounting its new user turn, then deliver
      // the actual request metadata. Old answers cannot authorize this watcher.
      const event=new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:true});
      document.querySelector('[data-testid=send-button]')!.dispatchEvent(event);
      document.querySelector('main')!.insertAdjacentHTML('beforeend',`<article data-testid="conversation-turn-${++turnIndex}" data-turn="user">Question</article>`);
      lifecycle.__chatgptNotifierRequestStartedAt=++clock;
      lifecycle.__chatgptNotifierAttemptId=String(clock);
      for(const listener of listeners)listener({type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:clock});
    },
    observeCompleted(){for(const listener of listeners)listener({type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED',startedAt:lifecycle.__chatgptNotifierRequestStartedAt});},
    advance(ms: number) {clock += ms;},
    answer() {
      document.querySelector('main')!.insertAdjacentHTML('beforeend',`<article data-testid="conversation-turn-${++turnIndex}" data-turn="assistant"><div class="markdown">Finished answer</div></article>`);
    },
    manualStop() {
      const button = document.createElement('button');
      button.setAttribute('data-testid', 'stop-button');
      document.body.append(button);
      button.dispatchEvent(new window.Event('click', {bubbles: true}));
      button.remove();
    },
    poll() {for (const callback of [...intervals.values()]) callback();},
    mutate() {for (const observer of [...activeObservers]) observer.callback([]);}
  };
}

const live = lifecycleSetup();
assert.equal(live.activeObservers.size, 1, 'one persistent error observer starts');
for (let index = 0; index < 100; index += 1) live.arm();
assert.equal(live.activeObservers.size, 2, 'real content script retains just error + latest answer observer');
assert.equal(live.intervals.size, 2, 'real content script retires both obsolete watcher intervals');
live.mutate();
assert.equal(live.timeouts.size, 1, 'latest observer can schedule one throttled answer check');
live.location.pathname = '/c/other';
live.poll();
assert.equal(live.activeObservers.size, 1, 'route change retires the old conversation observer');
assert.equal(live.intervals.size, 0);
assert.equal(live.timeouts.size, 0, 'retirement clears the scheduled answer check');
live.arm();
live.lifecycle.__chatgptNotifierAttemptId = 'new-attempt';
live.poll();
assert.equal(live.intervals.size, 0, 'a new attempt retires the old watcher');
live.arm();
live.lifecycle.__chatgptNotifierDispose();
live.lifecycle.__chatgptNotifierDispose();
assert.equal(live.activeObservers.size, 0, 'reinjection disposal disconnects every owned observer');
assert.equal(live.intervals.size, 0);
assert.equal(live.listeners.size, 0, 'disposal removes the extension runtime listener');
await Promise.resolve();
assert.equal(live.sent.filter(message => message.type === 'CHATGPT_RESPONSE_COMPLETE').length, 0,
  'retiring a watcher must never create a completion notification');

const invalid = lifecycleSetup(null);
assert.equal(invalid.lifecycle.__chatgptNotifierAlive(), false);
assert.equal(invalid.activeObservers.size, 0, 'an initially invalid context must not create observers or hit TDZ');
assert.equal(invalid.listeners.size, 0);
const manualStop = lifecycleSetup();
manualStop.arm();
manualStop.manualStop();
assert.equal(manualStop.intervals.size, 0, 'manual stop cancels completion polling immediately');
assert.equal(manualStop.activeObservers.size, 1);
manualStop.lifecycle.__chatgptNotifierDispose();
const retired = lifecycleSetup();
retired.arm();
retired.runtime.id = null;
retired.poll();
assert.equal(retired.activeObservers.size, 0, 'runtime invalidation disconnects all extension observers');
assert.equal(retired.intervals.size, 0);
assert.equal(retired.listeners.size, 0);
const completed = lifecycleSetup();
completed.arm();
completed.answer();
completed.advance(1000);
completed.poll();
completed.advance(1000);
completed.poll();
await new Promise<void>(resolve=>setImmediate(resolve));
assert.equal(completed.intervals.size, 0, 'natural completion clears its polling');
assert.equal(completed.activeObservers.size, 1);
assert.equal(completed.sent.filter(message => message.type === 'CHATGPT_RESPONSE_COMPLETE').length, 1,
  'natural completion still emits the completed answer');
completed.observeCompleted();
completed.advance(1000);
completed.poll();
await Promise.resolve();
assert.equal(completed.sent.filter(message => message.type === 'CHATGPT_RESPONSE_COMPLETE').length, 1,
  'repeated completion observation still suppresses duplicate notifications');
completed.lifecycle.__chatgptNotifierDispose();
console.log('PASS: bounded replacements and real content lifecycle: route/attempt retirement, scheduled checks, manual stop, invalidation, disposal, natural completion/dedupe, invalid startup');
