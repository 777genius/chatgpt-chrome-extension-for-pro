import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const source=readFileSync('extension/service-worker.js','utf8'),start=source.indexOf('async function recoverCancelledReasoningRetry('),end=source.indexOf('async function recoverNoClickRetry(',start);assert.ok(start>0&&end>start);
const url='https://chatgpt.com/c/test',promptKey='/c/test|turn:user',op='cancelled',attemptId='100000',requestId='req';
async function fixture(variant='ok') {
 const events:any[]=[{kind:'request.started',requestId,eventAt:100000,operationId:'old'},
 {kind:'request.failed',requestId,eventAt:100100,operationId:'old'},
 {kind:'retry.planned',requestId,attemptId,promptKey,retryUserId:'native-user'},
 {kind:'draft.saved',draft:'Saved draft'}, {kind:'retry.send_intent'},
 {kind:'retry.cancelled'}, {kind:'draft.restored'}, {kind:'retry.finished',clicked:false,confirmed:false}]
 .map((e,i)=>({sourceUrl:url,tabId:7,operationId:op,sequence:i+1,...e}));
 if(variant==='clicked')events.splice(5,0,{kind:'send.authorized',sourceUrl:url,tabId:7,operationId:op});
 if(variant==='newer')events.push({kind:'request.started',sourceUrl:url,tabId:8,requestId:'newer'});
 if(variant==='missing-restored')events.splice(6,1);
 events.forEach((e,i)=>e.sequence=i+1);
 let state:any={lastAttemptId:attemptId,lastPromptKey:promptKey,failures:[],remainingRetries:2},goal:any={phase:'recovering',deadlineAt:999999,stopRequested:false,pauseRequested:false};
 const checkpoint:any={state:'active',url,requestId,startedAt:100000,requestFailedAt:100100,promptKey};
 const native:any={ok:true,isLatest:true,isReadOnly:false,reasoningFailed:true,generating:false,promptKey,userId:'native-user',lastUserSentAtMs:100001};
 if(variant==='stop')goal.stopRequested=true;if(variant==='checkpoint-stop')checkpoint.state='stopped';if(variant==='running')native.generating=true;if(variant==='other-user')native.userId='other';if(variant==='no-failure')delete checkpoint.requestFailedAt;if(variant==='budget')state.remainingRetries=0;
 const writes:any[]=[];let calls=0;function controlChatComposer(){}
 const ctx=createContext({Date:class extends Date{static now(){return 200000}},Number,Math,JSON,controlChatComposer,
  readRetryState:async()=>structuredClone(state),readJournal:async()=>({ok:true,meta:{sequence:events.length},events:structuredClone(events)}),
  completionCheckpointRead:async()=>structuredClone(checkpoint),goalController:{get:async()=>structuredClone(goal)},inspectBoundNativeTurn:async()=>structuredClone(native),
  chrome:{tabs:{get:async()=>({id:7,url,status:'complete'})},scripting:{executeScript:async()=>[{result:{ok:variant!=='rich-or-attachment',matches:variant!=='draft-changed'}}]}},
  appendJournal:async(e:any)=>{calls++;if(variant==='journal-race')throw Error('sequence changed');writes.push(e);state.preparationRecovered=true}});
 runInContext(source.slice(start,end),ctx);try{await runInContext(`recoverCancelledReasoningRetry(7,${JSON.stringify(url)})`,ctx)}catch{if(variant!=='journal-race')throw Error('unexpected failure')};return{state,writes,calls};
}
const ok=await fixture();assert.equal(ok.writes.length,1);assert.equal(ok.writes[0].kind,'retry.cancelled_recovered');assert.equal(ok.state.preparationRecovered,true);
for(const v of ['clicked','newer','missing-restored','stop','checkpoint-stop','running','other-user','no-failure','budget','rich-or-attachment']){const f=await fixture(v);assert.equal(f.writes.length,0,v)}
assert.equal((await fixture('draft-changed')).writes.length,1,'a changed plain draft is backed up afresh by the retry coordinator');
const race=await fixture('journal-race');assert.equal(race.writes.length,0,'a concurrent journal mutation cannot rearm');
console.log('Cancelled reasoning recovery: exact failed request and restored draft rearm once; clicks, stops, newer requests and races remain fenced.');
{
 const key='chatgpt-journal:meta',goalKey='chatgpt-goal:'+url;
 const data:any={[key]:{sequence:0,startedAt:1,active:{},requests:{},tabs:{},retrySchema:1,retryByChat:{test:{lastAttemptId:attemptId,lastPromptKey:promptKey}},handoffSourceClaimSchema:1,handoffSourceClaims:{},retrySendClaimSchema:2,retrySendClaims:{},retryConsumedOperations:{},retryReleasedOperations:{},retryPreparingByChat:{},retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}},[goalKey]:{phase:'recovering'}};
 const storage={get:async(k:any)=>structuredClone(k===null?data:Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,data[x]]))),set:async(v:any)=>Object.assign(data,structuredClone(v))};
 const ctx=createContext({URL,Date,Number,Math,Object,console,chrome:{storage:{local:storage},runtime:{getManifest:()=>({version:'test'})}}});runInContext(readFileSync('extension/journal-store.js','utf8'),ctx);
 ctx.event={kind:'retry.cancelled_recovered',sourceUrl:url,operationId:op,attemptId,promptKey,requestId,expectedSequence:0};
 await runInContext('appendJournal(event,{id:7,url:event.sourceUrl})',ctx);
 assert.equal(data[key].retryByChat.test.preparationRecovered,true);assert.equal(data[key].retryByChat.test.cancelledRecoveries,1);
 ctx.event.expectedSequence=1;await assert.rejects(()=>runInContext('appendJournal(event,{id:7,url:event.sourceUrl})',ctx),'duplicate recovery is rejected');
 data[goalKey].stopRequested=true;data[key].retryByChat.test.preparationRecovered=false;
 await assert.rejects(()=>runInContext('appendJournal(event,{id:7,url:event.sourceUrl})',ctx),'a manual stop at commit time is fenced');
}
for(const variant of ['unrelated','same-chat','missing']) {
 const key='chatgpt-journal:meta',eventKey='chatgpt-journal:event:000000000001';
 const data:any={[key]:{sequence:1,startedAt:1,active:{},requests:{},tabs:{},retrySchema:1,retryByChat:{test:{lastAttemptId:attemptId,lastPromptKey:promptKey}},handoffSourceClaimSchema:1,handoffSourceClaims:{},retrySendClaimSchema:2,retrySendClaims:{},retryConsumedOperations:{},retryReleasedOperations:{},retryPreparingByChat:{},retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}}};
 if(variant!=='missing')data[eventKey]={kind:'tab.snapshot',sequence:1,tabId:8,sourceUrl:variant==='same-chat'?url:'https://chatgpt.com/c/other'};
 const storage={get:async(k:any)=>structuredClone(k===null?data:Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,data[x]]))),set:async(v:any)=>Object.assign(data,structuredClone(v))};
 const ctx=createContext({URL,Date,Number,Math,Object,console,chrome:{storage:{local:storage},runtime:{getManifest:()=>({version:'test'})}}});runInContext(readFileSync('extension/journal-store.js','utf8'),ctx);
 ctx.event={kind:'retry.cancelled_recovered',sourceUrl:url,operationId:op,attemptId,promptKey,requestId,expectedSequence:0};
 if(variant==='unrelated'){await runInContext('appendJournal(event,{id:7,url:event.sourceUrl})',ctx);assert.equal(data[key].retryByChat.test.preparationRecovered,true,'unrelated chat events do not starve recovery')}
 else await assert.rejects(()=>runInContext('appendJournal(event,{id:7,url:event.sourceUrl})',ctx),variant+' invalidates the proof');
}
