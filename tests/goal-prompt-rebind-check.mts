import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const worker=readFileSync('extension/service-worker.js','utf8');
const code=worker.slice(worker.indexOf('async function reconcileGoalPromptBinding('),worker.indexOf('const retryReadinessRecoveries=new Map();'));
const url='https://chatgpt.com/c/rebind-fixture',oldPromptKey='/c/rebind-fixture|fallback-7',newPromptKey='/c/rebind-fixture|fallback-4';
async function fixture(extra:any={}) {
 let rebinds=0,completions=0,checkpoints=0;
 const goal={id:'goal',phase:'waiting',expectedPromptKey:oldPromptKey,...extra.goal};
 const events=[{kind:'request.started',operationId:'op',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000000,sequence:1},
  {kind:'send.dispatched',operationId:'op',tabId:7,sourceUrl:url,text:'exact native payload',sequence:2},
  {kind:'goal.confirmed',operationId:'op',tabId:7,sourceUrl:url,goalId:'goal',promptKey:oldPromptKey,sequence:3},...(extra.events||[])];
 const native={ok:true,isLatest:true,isReadOnly:false,hasError:false,userId:'stable-user',userSentAtMs:999990,
  userText:'exact native payload',promptKey:newPromptKey,turnStatus:'in_progress',generating:false,
  assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'assistant',...extra.native};
 const receipts=new Map();
 const fn=new Function('goalController','chrome','inspectCompletedTurn','readJournal','ChatGPTHandoffTitle','completionCheckpointChange','manualRequestReceiptsByTab',code+';return reconcileGoalPromptBinding;')(
  {get:async()=>goal,rebindPrompt:async()=>{rebinds++;return {ok:extra.accept!==false};},completion:async()=>completions++},
  {tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async()=>[{result:native}]}},()=>{},
  async()=>({ok:true,events}),{chatUrl:(u:string)=>u},async(_id:number,change:any)=>{
   const result=change({url,state:'active',promptKey:oldPromptKey,startedAt:1000000});if(result.record)checkpoints++;
  },receipts);
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
