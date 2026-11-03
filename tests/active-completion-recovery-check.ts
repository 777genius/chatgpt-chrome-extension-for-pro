import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/content-script.js','utf8');
const recovery=source.slice(source.indexOf('  function scheduleActiveCompletionRecovery()'),source.indexOf('  async function recoverActiveCompletion()'));
assert.ok(recovery.length>100);
function setup(pending=false){
  let now=0,probes=0,next=0,generating=!pending,alive=true,acceptAt=40,restores=0;
  const timers=new Map<number,()=>Promise<void>>();
  const world=createContext({__chatgptNotifierAttemptId:'request',location:{pathname:'/c/test'},watchToken:1,completionRecoveryTimer:null,
    completionAttempt:null,restoreCompletionCheckpoint:async()=>pending?(++restores>=3?true:'pending'):undefined,
    Date:{now:()=>now},runtimeAvailable:()=>alive,isGenerating:()=>generating,currentErrors:()=>[],
    recoverActiveCompletion:async()=>++probes>=acceptAt,
    setTimeout:(fn:()=>Promise<void>,delay:number)=>{assert.ok(delay>=1000&&delay<=5000);const id=++next;timers.set(id,fn);return id;},
    clearTimeout:(id:number)=>timers.delete(id)});
  runInContext(recovery+';scheduleActiveCompletionRecovery()',world);
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  return {world,timers,get probes(){return probes;},settle,
    async step(){const [id,fn]=timers.entries().next().value!;timers.delete(id);now+=5000;await fn();await settle();},
    stop(){generating=false;},dispose(){alive=false;},neverAccept(){acceptAt=Infinity;}};
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
