import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const body=source.slice(source.indexOf('async function recoverHandoffReadiness('),source.indexOf('async function handleHandoffMessage('));
const url='https://chatgpt.com/c/readiness-fixture';
async function fixture(options:any={}) {
 const state:any={id:'handoff-fixture',stage:'failed',reason:'Не удалось дождаться готовности нового чата',sourceUrl:url,createdAt:100,...options.record};
 let route=options.url||'https://chatgpt.com/';
 let current=structuredClone(state),nativeCalls=0,goalCalls=0,writes=0;
 const events:any[]=[{kind:'handoff.navigating',sourceUrl:url,operationId:state.id},...(options.events||[])];
 const locks=new Map();
 const fn=new Function('handoffWrites','handoffKey','chrome','readJournal','controlChatComposer','goalController','appendJournal',body+';return recoverHandoffReadiness;')(
  locks,()=> 'key',{
   storage:{local:{get:async()=>({key:structuredClone(current)}),set:async(v:any)=>{writes++;current=structuredClone(v.key);}}},
   tabs:{get:async()=>({url:route,status:options.status||'complete'})},
   scripting:{executeScript:async(params:any)=>{nativeCalls++;const action=params.args[0].action;return [{result:{ok:options.nativeOk!==false&&(options.seeded?action==='inspect-resumable-handoff':action==='inspect-empty-handoff')}}];}}
  },async()=>({ok:true,events,storageError:options.storageError||''}),()=>{},
  {handoffPreparationReady:async()=>{goalCalls++;if(options.routeDuringGoal)route='https://chatgpt.com/c/new-manual';return {ok:options.goalOk!==false};}},async(e:any)=>events.push(e));
 const result=await fn(7,state);
 return {result,current,nativeCalls,goalCalls,writes,events,fn,state};
}
const ready=await fixture();
assert.equal(ready.current.stage,'navigating');
assert.equal(ready.current.preparationRecoveries,1);
assert.equal(ready.goalCalls,1);
const uploadTimeout=await fixture({events:[{kind:'handoff.preparing',operationId:'handoff-fixture'},{kind:'attachment.status',status:'uploading',operationId:'handoff-fixture'}]});
assert.equal(uploadTimeout.current.stage,'navigating','proven no-send upload timeout recovers through the same sender');
const seeded=await fixture({seeded:true,record:{lastUserText:'доделай е2е',draft:''}});
assert.equal(seeded.current.stage,'navigating','an exact native seed may recover');
assert.equal(seeded.current.draft,'доделай е2е','the destination text is durably saved as a draft before recovery');
const conflictingDraft=await fixture({seeded:true,record:{lastUserText:'доделай е2е',draft:'different saved draft'}});
assert.equal(conflictingDraft.writes,0,'never overwrite a different saved draft');
const unmatchedSeed=await fixture({seeded:true,nativeOk:false,record:{lastUserText:'доделай е2е'}});
assert.equal(unmatchedSeed.writes,0,'unverified destination text cannot resume');
await ready.fn(7,ready.state);
assert.equal(ready.events.filter(e=>e.kind==='handoff.preparation_recovered').length,1,'repeat GET cannot reopen the operation');
for(const kind of ['handoff.sending','handoff.sent','handoff.awaiting-confirmation','handoff.clicked','send.authorized','send.dispatched','send.not_clicked','request.started']) {
 const env=await fixture({events:[{kind,operationId:'handoff-fixture'}]});
 assert.equal(env.writes,0,kind+' must not permit initial-readiness replay');
 assert.equal(env.nativeCalls,0);
}
for(const options of [{events:[{kind:'request.started',tabId:7,recordedAt:101,operationId:'manual'}]},{nativeOk:false},{goalOk:false},{url:'https://chatgpt.com/c/other'},
 {status:'unloaded'},{storageError:'storage failed'},{record:{preparationRecoveries:3}},
 {record:{sendReceipt:{operationId:'handoff-fixture'}}},{record:{reason:'Other failure'}}]) {
 const env=await fixture(options);assert.equal(env.writes,0,'refusal does not modify the handoff');
}
console.log('Initial handoff readiness: exact no-send recovery, duplicate GET and unsafe-state refusals passed.');

assert.equal((await fixture({routeDuringGoal:true})).writes,0,'route change during Goal preparation cannot resume old handoff');
