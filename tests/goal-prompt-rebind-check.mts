import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const worker=readFileSync('extension/service-worker.js','utf8');
const code=worker.slice(worker.indexOf('async function reconcileGoalPromptBinding('),worker.indexOf('const retryReadinessRecoveries=new Map();'));
const url='https://chatgpt.com/c/rebind-fixture',oldPromptKey='/c/rebind-fixture|fallback-7',newPromptKey='/c/rebind-fixture|fallback-4';
async function fixture(extra:any={}) {
 let rebinds=0,completions=0,checkpoints=0;
 const goal={id:'goal',phase:'waiting',expectedPromptKey:oldPromptKey,...extra.goal};
 const events=extra.onlyEvents||[{kind:'request.started',operationId:'op',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000000,sequence:1},
  {kind:'send.dispatched',operationId:'op',tabId:7,sourceUrl:url,text:'exact native payload',sequence:2},
  {kind:'goal.confirmed',operationId:'op',tabId:7,sourceUrl:url,goalId:'goal',promptKey:oldPromptKey,sequence:3},...(extra.events||[])];
 const native={ok:true,isLatest:true,isReadOnly:false,hasError:false,userId:'stable-user',userSentAtMs:999990,
  userText:'exact native payload',promptKey:newPromptKey,turnStatus:'in_progress',generating:false,
  assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'assistant',...extra.native};
 const receipts=new Map();
 const fn=new Function('goalController','chrome','inspectCompletedTurn','readJournal','ChatGPTHandoffTitle','completionCheckpointChange','manualRequestReceiptsByTab','completionCheckpointRead',code+';return reconcileGoalPromptBinding;')(
  {get:async()=>goal,rebindPrompt:async()=>{rebinds++;return {ok:extra.accept!==false};},completion:async()=>completions++},
  {tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async()=>[{result:native}]}},()=>{},
  async()=>({ok:true,events}),{chatUrl:(u:string)=>u},async(_id:number,change:any)=>{
   const result=change({url,state:'active',promptKey:oldPromptKey,startedAt:1000000});if(result.record)checkpoints++;
  },receipts,async()=>extra.checkpoint||null);
 const result=await fn(7,url);return {result,rebinds,completions,checkpoints};
}
assert.equal((await fixture({goal:{expectedPromptKey:'/c/rebind-fixture|renumbered',confirmedPromptBinding:{operationId:'op',userId:'stable-user'}}})).rebinds,1,'a repeated renumbering keeps the same stable binding');
const valid=await fixture();assert.equal(valid.rebinds,1);assert.equal(valid.checkpoints,1);
assert.equal(valid.completions,0,'server in_progress must never schedule a continuation');
assert.equal((await fixture({native:{turnStatus:'complete'}})).completions,1,'a fully complete verified answer uses the existing coordinator');
for(const extra of [{goal:{phase:'stopped'}},{goal:{phase:'paused'}},{goal:{operation:{status:'clicked'}}},
 {goal:{expectedPromptKey:'other',confirmedPromptBinding:{operationId:'op',userId:'different'}}},{goal:{manualPending:{text:'owner'}}},{goal:{pauseRequested:true}},{goal:{stopRequested:true}},
 {native:{isReadOnly:true}},{native:{isLatest:false}},{native:{hasError:true}},{native:{userText:'owner draft'}},
 {native:{userSentAtMs:1}},{native:{promptKey:oldPromptKey}},{url:'https://chatgpt.com/c/other'},
 {events:[{kind:'request.started',sourceUrl:url,tabId:8,eventAt:999995,sequence:0}]},
 {events:[{kind:'request.started',sourceUrl:url,tabId:7,eventAt:2000000,sequence:4}]},
 {events:[{kind:'send.dispatched',operationId:'op',sourceUrl:url,tabId:7,text:'duplicate',sequence:5}]}]) {
 const test=await fixture(extra);assert.equal(test.rebinds,0,JSON.stringify(extra));assert.equal(test.completions,0);
}
assert.equal((await fixture({accept:false,native:{turnStatus:'complete'}})).completions,0);
console.log('Goal prompt renumbering: exact confirmed wire payload + unique request, no implicit send, native completion and manual/unknown fences passed.');

// Manually started Goals have no goal.confirmed auto-send; native message and
// the exact unowned request receipt must be sufficient, but never a timestamp alone.
{
 const submitted={requestId:'manual-request',startedAt:1000000,promptKey:oldPromptKey,
   userId:'stable-user',userText:'exact native payload',userSentAtMs:999990,tabId:7,sourceUrl:url};
 const event={kind:'request.started',operationId:null,tabId:7,sourceUrl:url,
   requestId:submitted.requestId,eventAt:submitted.startedAt,sequence:1};
 const goal={manualStart:submitted};
 const valid=await fixture({goal,onlyEvents:[event]});
 assert.equal(valid.rebinds,1,'manual Goal rebinding uses exact persisted request and native user');
 assert.equal(valid.checkpoints,1);
 const supplemented=await fixture({goal:{manualSupplementBinding:submitted},onlyEvents:[event]});
 assert.equal(supplemented.rebinds,1,'the newest confirmed follow-up also rebinds');
 const checkpoint={state:'active',url,requestId:submitted.requestId,startedAt:submitted.startedAt,
   promptKey:oldPromptKey,nativeUserId:submitted.userId,nativeUserSentAtMs:submitted.userSentAtMs};
 const shifted=await fixture({goal,onlyEvents:[event],checkpoint,native:{userSentAtMs:1300000,turnStatus:'complete'}});
 assert.equal(shifted.completions,1,'server timestamp correction retains the same verified native message');
 for(const changed of [{nativeUserId:'other'}, {nativeUserSentAtMs:1}, {requestId:'other'}, {state:'finished'}, {promptKey:'other'}])
   assert.equal((await fixture({goal,onlyEvents:[event],checkpoint:{...checkpoint,...changed},native:{userSentAtMs:1300000}})).rebinds,0,'timestamp shift requires the exact durable native checkpoint');
 assert.equal((await fixture({goal,onlyEvents:[event,{...event,sequence:2,requestId:'newer'}],checkpoint,native:{userSentAtMs:1300000}})).rebinds,0,'newer request prevents timestamp-shift recovery');
 const repeated=await fixture({goal:{...goal,expectedPromptKey:'/c/rebind-fixture|renumbered',
   confirmedPromptBinding:{operationId:'manual:manual-request',userId:'stable-user'}},onlyEvents:[event]});
 assert.equal(repeated.rebinds,1,'later native renumbering remains tied to the same manual request');
 for(const change of [{userId:'other-user'},{userText:'modified'},{userSentAtMs:10},{hasError:true}]) {
   const failed=await fixture({goal,onlyEvents:[event],native:change});
   assert.equal(failed.rebinds,0,JSON.stringify(change));
 }
 for(const invalid of [
   [{...event,requestId:'wrong'}],
   [{...event,tabId:8}],
   [event,{...event,sequence:2,requestId:'second'}]
 ]) {
   const failed=await fixture({goal,onlyEvents:invalid});
   assert.equal(failed.rebinds,0,'foreign or newer request must not rebind a manual Goal');
 }
}
console.log('Manual Goal rebind: exact native message, request ownership, later renumbering and negative fences passed.');
{
 const events=[{kind:'request.started',operationId:'retry',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000000,sequence:1},
  {kind:'send.dispatched',operationId:'retry',tabId:7,sourceUrl:url,text:'exact native payload',sequence:2},
  {kind:'completion.bound',tabId:7,sourceUrl:url,promptKey:oldPromptKey,attemptId:'1000000',sequence:3},
  {kind:'retry.confirmed',operationId:'retry',tabId:7,sourceUrl:url,sequence:4}];
 assert.equal((await fixture({onlyEvents:events,native:{turnStatus:'complete'}})).completions,1);
 for(const modified of [events.filter(e=>e.kind!=='retry.confirmed'),events.filter(e=>e.kind!=='completion.bound'),[...events,{...events[0],sequence:5,requestId:'new'}]])
  assert.equal((await fixture({onlyEvents:modified})).rebinds,0);
}
