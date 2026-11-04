import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/content-script.js','utf8');
const waitCode=source.slice(source.indexOf('  async function waitHandoff('),source.indexOf('  async function submitHandoff('));
let time=0,calls=0;
const ctx=createContext({Date:class extends Date{static override now(){return time;}},runtimeAvailable:()=>true,
 runtimeMessage:async(m:any)=>{time+=m.delayMs;calls++;return {ok:true};},sleepUntilNextCheck:async()=>{time+=250;},Object,Error});
runInContext(waitCode,ctx);
ctx.ready=()=>time>=75000;assert.equal(await runInContext("waitHandoff(ready,180000,'upload')",ctx),true);
assert.equal(time,75000);assert.equal(calls,75,'file uploads poll once a second, avoiding four native probes a second');
time=0;ctx.ready=()=>false;
await assert.rejects(()=>runInContext("waitHandoff(ready,180000,'upload')",ctx),(e:any)=>e.preparationPhase==='upload');
assert.equal(time,180000,'upload readiness stays bounded');
time=0;ctx.ready=()=>{if(time>=3000)throw Error('Owner changed the draft');return false;};
await assert.rejects(()=>runInContext("waitHandoff(ready,180000,'upload')",ctx),/Owner changed/);assert.equal(time,3000);
const schedule=source.slice(source.indexOf('  function scheduleHandoffReadiness('),source.indexOf('  async function resumeSavedHandoff('));
for(const phase of ['upload','editor']){
 const delays:number[]=[],c=createContext({runtimeAvailable:()=>true,handoffReadinessTimer:null,
  handoffRecord:{stage:'failed',reason:'Не удалось дождаться готовности нового чата',preparationPhase:phase},
  setTimeout:(_fn:unknown,ms:number)=>{delays.push(ms);return 1;},resumeSavedHandoff:async()=>{}});
 runInContext(schedule+'scheduleHandoffReadiness()',c);assert.deepEqual(delays,[phase==='upload'?5000:300000]);
}
for(const stage of ['sending','awaiting-confirmation','sent']){
 let scheduled=false;const c=createContext({runtimeAvailable:()=>true,handoffReadinessTimer:null,
  handoffRecord:{stage,reason:'Не удалось дождаться готовности нового чата',preparationPhase:'upload'},setTimeout:()=>{scheduled=true;}});
 runInContext(schedule+'scheduleHandoffReadiness()',c);assert.equal(scheduled,false,'uncertain/confirmed sends are never reopened');
}
console.log('File handoff: 75-second upload, bounded three-minute wait, draft cancellation, cheap polling, fast no-send recovery and unknown-send fences passed.');
