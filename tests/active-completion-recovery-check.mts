import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/content-script.js','utf8');
const recovery=source.slice(source.indexOf('  function scheduleActiveCompletionRecovery('),source.indexOf('  async function recoverActiveCompletion()'));
assert.ok(recovery.length>100);
function setup(pending=false){
  let now=0,probes=0,next=0,generating=!pending,alive=true,acceptAt=40,restores=0;
  const timers=new Map<number,()=>Promise<void>>(),delays:number[]=[];
  const world=createContext({__chatgptNotifierAttemptId:'request',location:{pathname:'/c/test'},watchToken:1,completionRecoveryTimer:null,completionRecoveryLastProbeAt:-Infinity,completionRecoveryInFlight:false,
    completionAttempt:null,restoreCompletionCheckpoint:async()=>pending?(++restores>=3?true:'pending'):undefined,
    Date:{now:()=>now},runtimeAvailable:()=>alive,isGenerating:()=>generating,currentErrors:()=>[],
    recoverActiveCompletion:async()=>++probes>=acceptAt,
    setTimeout:(fn:()=>Promise<void>,delay:number)=>{assert.ok(delay>=1000&&delay<=5000||delay===300000);delays.push(delay);const id=++next;timers.set(id,fn);return id;},
    clearTimeout:(id:number)=>timers.delete(id)});
  runInContext(recovery+';scheduleActiveCompletionRecovery()',world);
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  return {world,timers,delays,get probes(){return probes;},settle,
    async step(){const [id,fn]=timers.entries().next().value!;timers.delete(id);now+=5000;await fn();await settle();},
    idle(){generating=false;},stop(){generating=false;world.watchToken++;},dispose(){alive=false;},neverAccept(){acceptAt=Infinity;}};
}
{
  const h=setup();await h.settle();
  while(h.probes<40){assert.equal(h.timers.size,1,'a still-running request must survive more than 30 failed probes');await h.step();}
  assert.equal(h.timers.size,0,'successful recovery stops polling');
}
for(const reason of ['stop','dispose','route','attempt','token'] as const){
  const h=setup();h.neverAccept();await h.settle();await h.step();
  if(reason==='stop')h.stop();
  if(reason==='dispose')h.dispose();
  if(reason==='route')h.world.location.pathname='/c/other';
  if(reason==='attempt')h.world.__chatgptNotifierAttemptId='new';
  if(reason==='token')h.world.watchToken=2;
  await h.step();assert.equal(h.timers.size,0,`${reason} retires the recovery loop`);
}
console.log('Active completion recovery: >30 transient failures, bounded single timer, success and lifecycle cancellation passed.');

{
 const h=setup(true);await h.settle();
 assert.equal(h.timers.size,1,'a native first-turn mount pending after route change is retried');
 await h.step();await h.step();
 assert.equal(h.timers.size,0,'restored allocation retires the same bounded timer');
}

// Existing mutation observer wakes a late native final only after bounded grace.
{
 const wake=source.slice(source.indexOf('  function wakePendingCompletionRecovery()'),source.indexOf('  function scheduleActiveCompletionRecovery('));
 let now=60000,calls=0;
 const world=createContext({completionAttempt:null,completionRecoveryTimer:null,__chatgptNotifierAttemptId:'current-request',
   completionRecoveryLastProbeAt:30000,completionRecoveryInFlight:false,Date:{now:()=>now},runtimeAvailable:()=>true,
   scheduleActiveCompletionRecovery:(allowGrace:boolean)=>{assert.equal(allowGrace,false,'event wake must not restart startup polling');calls++;world.completionRecoveryLastProbeAt=now;}});
 runInContext(wake,world);
 runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'late idle/final DOM mount retries existing strict checkpoint restore');
 runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'stream mutation burst is throttled');
 now+=5000;world.completionRecoveryInFlight=true;runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'inflight native probe is not duplicated');world.completionRecoveryInFlight=false;world.completionRecoveryTimer=1;runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'existing retry timer is not reset');
 world.completionRecoveryTimer=null;world.completionAttempt={};runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'already bound completion is not reprobed');
 world.completionAttempt=null;world.__chatgptNotifierAttemptId='';runInContext('wakePendingCompletionRecovery()',world);assert.equal(calls,1,'idle unrelated tabs do not probe');
 assert.match(source,/errorObserver = new MutationObserver\(\(records\) => \{\s*wakePendingCompletionRecovery\(\);/);
}

{const h=setup();h.neverAccept();await h.settle();h.idle();for(let i=0;i<8;i++)await h.step();assert.equal(h.timers.size,1);assert.equal(h.delays.at(-1),300000,'an idle request without terminal proof retains one five-minute observation timer');h.dispose();await h.step();assert.equal(h.timers.size,0);}
