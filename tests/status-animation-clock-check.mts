import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

type Tick={type:'CHATGPT_STATUS_TICK';url:string;frame:number};
type Ack={ok?:boolean}|undefined;
type Clock={setEnabled(value:boolean):void;set(tabId:number,url:string,loading:boolean):void;remove(tabId:number):void;dispose():void};
type Adapters={send:(tabId:number,message:Tick)=>Promise<Ack>;setTimeout:(callback:()=>void,delay:number)=>number;clearTimeout:(id:number)=>void};
type Factory={create(adapters:Adapters):Clock};
const context=createContext({});
runInContext(readFileSync('extension/status-animation.js','utf8'),context);
const factory=context.ChatGPTStatusAnimation as Factory;
const a='https://chatgpt.com/c/a',b='https://chatgpt.com/c/b';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() {
  let resolve:(value:T)=>void=()=>{},reject:(reason:Error)=>void=()=>{};
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function harness(send:Adapters['send']) {
  let now=0,next=0,maximum=0;
  const timers=new Map<number,{at:number;callback:()=>void}>();
  const clock=factory.create({send,
    setTimeout(callback,delay) {
      assert.equal(delay,250,'one shared 4fps clock drives every tab');
      const id=++next;timers.set(id,{at:now+delay,callback});maximum=Math.max(maximum,timers.size);return id;
    },
    clearTimeout(id){timers.delete(id);}
  });
  return {clock,get pending(){return timers.size;},get maximum(){return maximum;},
    advance(ms=250) {
      const target=now+ms;
      while(true) {
        const entry=Array.from(timers).sort((left,right)=>left[1].at-right[1].at)[0];
        if(!entry||entry[1].at>target)break;
        now=entry[1].at;timers.delete(entry[0]);entry[1].callback();
      }
      now=target;
    }
  };
}

{
  const calls:{tabId:number;message:Tick}[]=[];
  const h=harness(async(tabId,message)=>{calls.push({tabId,message});return {ok:true};});
  assert.equal(h.pending,0);
  h.clock.set(7,a,true);h.clock.set(8,b,true);h.clock.set(7,a,true);
  assert.equal(h.pending,1,'multiple loading tabs share exactly one timer');
  for(let index=0;index<9;index++){h.advance();await settle();}
  assert.deepEqual(calls.filter(call=>call.tabId===7).map(call=>call.message.frame),[0,1,2,3,4,5,6,7,0]);
  assert.deepEqual(calls.filter(call=>call.tabId===8).map(call=>call.message.frame),[0,1,2,3,4,5,6,7,0]);
  assert.ok(calls.every(call=>call.message.type==='CHATGPT_STATUS_TICK'&&call.message.url===(call.tabId===7?a:b)));
  h.clock.set(7,a,false);assert.equal(h.pending,1,'a terminal tab does not stop another loading tab');
  h.clock.remove(8);assert.equal(h.pending,0,'closing the final tab stops the timer');
  const before=calls.length;h.advance(10000);await settle();assert.equal(calls.length,before);
  assert.equal(h.maximum,1);
}
{
  const frozen=deferred<Ack>(),calls:{tabId:number;frame:number}[]=[];
  const h=harness(async(tabId,message)=>{calls.push({tabId,frame:message.frame});return tabId===7?frozen.promise:{ok:true};});
  h.clock.set(7,a,true);h.clock.set(8,b,true);
  for(let index=0;index<5;index++){h.advance();h.clock.set(7,a,true);await settle();}
  assert.equal(calls.filter(call=>call.tabId===7).length,1,'an idempotent loading update never resets an in-flight request');
  assert.deepEqual(calls.filter(call=>call.tabId===8).map(call=>call.frame),[0,1,2,3,4],'a frozen tab cannot block responsive tabs');
  frozen.resolve({ok:true});await settle();
  assert.equal(calls.filter(call=>call.tabId===7).length,1,'settling a slow tick does not replay skipped frames');
  h.advance();await settle();
  assert.deepEqual(calls.filter(call=>call.tabId===7).map(call=>call.frame),[0,5],'a recovered tab receives only the next current frame');
  h.clock.dispose();assert.equal(h.pending,0);assert.equal(h.maximum,1);
}
for(const failure of ['negative','missing','reject','throw'] as const) {
  const h=harness(()=>{
    if(failure==='throw')throw new Error('Tab is gone');
    if(failure==='reject')return Promise.reject(new Error('No listener'));
    return Promise.resolve(failure==='negative'?{ok:false}:undefined);
  });
  h.clock.set(7,a,true);h.advance();await settle();
  assert.equal(h.pending,0,`${failure} acknowledgement retires the final subscription`);
}
{
  const old=deferred<Ack>(),calls:Tick[]=[];
  const h=harness(async(_tabId,message)=>{calls.push(message);return message.url===a?old.promise:{ok:true};});
  h.clock.set(7,a,true);h.advance();
  h.clock.set(7,b,true);h.clock.set(7,a,false);
  old.reject(new Error('Old route failed'));await settle();
  h.advance();await settle();
  assert.deepEqual(calls.map(call=>call.url),[a,b],'a stale stop or rejection cannot retire a rebound chat');
  h.clock.set(7,b,false);assert.equal(h.pending,0);
}
{
  const old=deferred<Ack>(),fresh=deferred<Ack>(),calls:Tick[]=[];
  const h=harness(async(_tabId,message)=>{calls.push(message);return calls.length===1?old.promise:fresh.promise;});
  h.clock.set(7,a,true);h.advance();
  h.clock.remove(7);h.clock.set(7,a,true);h.advance();
  old.resolve({ok:false});await settle();
  h.advance(1000);await settle();
  assert.equal(calls.length,2,'an old same-URL response cannot clear or reset the new binding pending flag');
  fresh.resolve({ok:true});await settle();h.advance();await settle();assert.equal(calls.length,3);
  h.clock.dispose();assert.equal(h.pending,0);
}
{
  const pending=deferred<Ack>();let calls=0;
  const h=harness(async()=>{calls++;return pending.promise;});
  h.clock.set(7,a,true);h.advance();h.clock.dispose();h.clock.dispose();
  pending.resolve({ok:true});await settle();
  h.clock.set(8,b,true);h.advance(10000);
  assert.equal(calls,1);assert.equal(h.pending,0,'disposed clocks cannot schedule or revive after an old response');
}
console.log('PASS: one bounded 250ms animation clock, shared eight frames, idle/terminal/close cleanup, failed acknowledgements, slow-tab isolation, binding identity races and disposal');

{
  let calls=0;const h=harness(async()=>{calls++;return {ok:true};});
  h.clock.set(7,a,true);h.clock.setEnabled(false);
  assert.equal(h.pending,0,'animation timer stops while Chrome is unfocused');
  h.advance(10000);await settle();assert.equal(calls,0);
  h.clock.setEnabled(true);assert.equal(h.pending,1);
  h.advance();await settle();assert.equal(calls,1,'focus resumes retained loading bindings');
  h.clock.setEnabled(false);h.clock.remove(7);h.clock.setEnabled(true);
  assert.equal(h.pending,0,'completed bindings do not return on refocus');h.clock.dispose();
}

// Execute the real worker startup/focus wiring against a deferred initial API
// response. A stale startup snapshot must not override a newer focus event.
const workerSource=readFileSync('extension/service-worker.js','utf8');
const startup=workerSource.slice(workerSource.indexOf('const statusAnimation='),workerSource.indexOf('\n\nfunction normalizePathname'));
const focusStart=workerSource.indexOf('chrome.windows?.onFocusChanged?.addListener');
const focusWiring=workerSource.slice(focusStart,workerSource.indexOf('\n\nchrome.tabs.onUpdated',focusStart));
assert.ok(startup&&focusWiring);
for(const focused of [true,false]) {
  const initial=deferred<{focused:boolean}>(),applied:boolean[]=[];
  let onFocus:(id:number)=>void=()=>{};
  const world=createContext({setTimeout,clearTimeout,
    ChatGPTStatusAnimation:{create:()=>({setEnabled:(value:boolean)=>applied.push(value)})},
    chrome:{windows:{getLastFocused:()=>initial.promise,onFocusChanged:{addListener:(fn:(id:number)=>void)=>{onFocus=fn;}}},tabs:{query:async()=>[]}},
    statusReceipt:()=>({}),visitVisibleChat:async()=>{},ChatGPTHandoffTitle:{chatUrl:()=>''}
  });
  runInContext(startup+'\n'+focusWiring,world);onFocus(focused?7:-1);
  initial.resolve({focused:!focused});await settle();
  assert.deepEqual(applied,[focused],'a newer focus event wins over a stale initial window snapshot');
}
