import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const source=readFileSync('extension/content-script.js','utf8'),from=source.indexOf('  async function recoverGoalState('),until=source.indexOf('  function stopContext()',from);
let now=1000,alive=true,replies:any[]=[{pending:true,canRetry:true}],calls=0;const timers=new Map<number,{fn:()=>Promise<void>,delay:number}>();let seq=0;
const c=createContext({location:{pathname:'/c/fixture',href:'https://chatgpt.com/c/fixture'},Date:{now:()=>now},runtimeAvailable:()=>alive,runtimeMessage:async()=>{calls++;return replies.length?replies.shift():{pending:true,canRetry:true};},setTimeout:(fn:()=>Promise<void>,delay:number)=>{const id=++seq;timers.set(id,{fn,delay});return id;},clearTimeout:(id:number)=>timers.delete(id),goalRecoveryTimer:null,goalRecoveryBusy:false,goalRecoveryAgain:false,goalRecoveryPath:'',goalRecoveryFirstAt:0});runInContext(source.slice(from,until),c);
await runInContext('recoverGoalState()',c);assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,5000);
for(let i=0;i<7;i++){const[id,t]=[...timers][0];timers.delete(id);now+=t.delay;await t.fn();await new Promise(r=>setImmediate(r));}
assert.equal([...timers.values()][0].delay,30000,'pending consent stays observed after short UI bind deadline, without a fast idle loop');
replies=[null];{const[id,t]=[...timers][0];timers.delete(id);await t.fn();await new Promise(r=>setImmediate(r));}
assert.equal(timers.size,1,'temporary worker failure keeps existing observation alive');
replies=[{pending:false,canRetry:false}];await runInContext('recoverGoalState()',c);assert.equal(timers.size,0,'bound/disarmed Goal retires observation timer');
replies=[{pending:true,canRetry:false}];await runInContext('recoverGoalState()',c);assert.equal(timers.size,0,'non-retryable intent retires observation');
replies=[{pending:true,canRetry:true}];await runInContext('recoverGoalState()',c);assert.equal(timers.size,1);alive=false;const count=calls;await runInContext('recoverGoalState()',c);assert.equal(calls,count,'obsolete context makes no request');
assert.match(source,/if\(goalRecoveryTimer!==null\)clearTimeout\(goalRecoveryTimer\);goalRecoveryTimer=null/);
console.log('Pending Goal observation: independent of settings mount, one bounded timer, slow fallback, transient worker failure and disposal passed.');

// Browser page timers may be fully throttled in a background tab. Exercise
// the real recovery loop with only worker waits, without any focus event.
{
 let time=1000,reads=0,isAlive=true;const waits:{delay:number,resolve:(value:any)=>void}[]=[];
 const h=createContext({document:{visibilityState:'hidden'},location:{pathname:'/c/fixture',href:'https://chatgpt.com/c/fixture'},Date:{now:()=>time},
  runtimeAvailable:()=>isAlive,runtimeMessage:(message:any)=>{
   if(message.type==='CHATGPT_WAIT')return new Promise(resolve=>waits.push({delay:message.delayMs,resolve}));
   reads++;return Promise.resolve(reads===1?{pending:true,canRetry:true}:{ok:true});
  },setTimeout:()=>{throw Error('hidden page timer must not be required');},clearTimeout:()=>{},
  goalRecoveryTimer:null,goalRecoveryBusy:false,goalRecoveryAgain:false,goalRecoveryPath:'',goalRecoveryFirstAt:0});
 runInContext(source.slice(from,until),h);
 await runInContext('recoverGoalState()',h);
 assert.equal(reads,1);assert.equal(waits.length,1);assert.equal(waits[0].delay,3000);
 let wait=waits.shift()!;time+=wait.delay;wait.resolve({ok:true});await new Promise(r=>setImmediate(r));
 assert.equal(reads,1);assert.equal(waits.length,1);assert.equal(waits[0].delay,2000);
 wait=waits.shift()!;time+=wait.delay;wait.resolve({ok:true});await new Promise(r=>setImmediate(r));
 assert.equal(reads,2,'background observation runs without focus or page timers');
 assert.equal(waits.length,0);assert.equal(h.goalRecoveryTimer,null,'completed observation retires its wait');
 isAlive=false;
}
{
 let reads=0;const waits:{resolve:(value:any)=>void}[]=[];
 const h=createContext({document:{visibilityState:'hidden'},location:{pathname:'/c/fixture',href:'https://chatgpt.com/c/fixture'},Date:{now:()=>1000},
  runtimeAvailable:()=>true,runtimeMessage:(message:any)=>message.type==='CHATGPT_WAIT'?new Promise(resolve=>waits.push({resolve})):
    Promise.resolve(++reads===1?{pending:true,canRetry:true}:{ok:true,pending:false}),
  setTimeout:()=>1,clearTimeout:()=>{},goalRecoveryTimer:null,goalRecoveryBusy:false,goalRecoveryAgain:false,goalRecoveryPath:'',goalRecoveryFirstAt:0});
 runInContext(source.slice(from,until),h);await runInContext('recoverGoalState()',h);
 assert.equal(waits.length,1);await runInContext('recoverGoalState()',h);
 waits.shift()!.resolve({ok:true});await new Promise(r=>setImmediate(r));
 assert.equal(reads,2,'a cancelled wait cannot restart recovery after pause or stop');assert.equal(waits.length,0);
}
console.log('Hidden pending Goal: bounded worker waits observe completion without page timers or focus.');
