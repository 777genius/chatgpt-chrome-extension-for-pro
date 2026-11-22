import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const worker=readFileSync('extension/service-worker.js','utf8');
const source=worker.slice(worker.indexOf('async function reconcileGoalMarker('),worker.indexOf('// Stable native identity'));
const url='https://chatgpt.com/c/marker-settle-fixture',promptKey='/c/marker-settle-fixture|user';
type V=Record<string,any>;
function fixture(){
 const markerPending={url,tabId:7,promptKey,completionKey:promptKey+'|assistant',userId:'native-user',observedAt:900};
 const goal:V={schema:1,id:'goal',url,originUrl:url,goal:'Complete synthetic objective',rules:'',phase:'waiting',operation:null,
  expectedPromptKey:promptKey,lastCompletionKey:'',markerPending,continuations:2,maxContinuations:30,maxMinutes:1440,startedAt:500,deadlineAt:100000};
 const data:V={['chatgpt-goal:'+url]:goal},messages:V[]=[],notices:V[]=[],events:V[]=[],journal:V[]=[],storageReads:any[]=[];
 let live=url,after:(()=>void)|null=null,beforeCAS:(()=>void)|null=null;
 const checkpoint:V={state:'active',url,requestId:'request',startedAt:500,promptKey};
 const request:V={url,requestId:'request',startedAt:500,receipt:{epoch:'e',order:1}};
 const view:V={url,revision:1,status:{kind:'loading',eventAt:500,receipt:{epoch:'e',order:1}}};
 const native:V={ok:true,url,isLatest:true,isReadOnly:false,turnStatus:'complete',generating:false,hasError:false,
  userId:'native-user',promptKey,assistantKey:'assistant',assistantCompleted:true,assistantPhase:'final_answer',
  goalResponse:'GOAL_COMPLETE',goalRawExact:false,goalMarkerPending:true};
 const storage={get:async(keys:string|string[])=>{
  assert.notEqual(keys,null,'marker recovery reads exact storage keys');storageReads.push(structuredClone(keys));
  return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(k==='chatgpt-journal:meta'
   ?{sequence:journal.reduce((head,row)=>Math.max(head,row.sequence),0)}
   :k.startsWith('chatgpt-journal:event:')?journal.find(row=>'chatgpt-journal:event:'+String(row.sequence).padStart(12,'0')===k):data[k]) ]));
 },set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url:live,title:'Synthetic chat'}),sendMessage:async(_id:number,message:V)=>{messages.push(message);return {ok:true};}};
 const ctx=createContext({URL,Date,console,JOURNAL_META:'chatgpt-journal:meta',JOURNAL_PREFIX:'chatgpt-journal:event:',RETRY_MIGRATION_BATCH_SIZE:50,journalFailure:'',chrome:{storage:{local:storage},tabs,scripting:{executeScript:async()=>[{result:structuredClone(native)}]}},inspectCompletedTurn:()=>{},
  readJournal:async()=>({ok:true,events:structuredClone(journal),meta:{sequence:journal.length}}),completionCheckpointRead:async()=>structuredClone(checkpoint),
  latestRequestReceipt:async()=>structuredClone(request),readChatStatus:async()=>structuredClone(view),
  inspectBoundNativeTurn:async()=>{const result=structuredClone(native);after?.();return result;},
  reconcileDetachedReply:async()=>({changed:false}),completionCheckpointFinish:async()=>true,
  statusReceipt:()=>({epoch:'e',order:2}),appendJournal:async(e:V)=>events.push(e),
  reserveChatNotification:async(_url:string,_id:number,kind:string,_at:number,_receipt:V,expected:V)=>{
   if(expected.revision!==view.revision)return null;return {ticket:{id:'ticket'},view:{...view,status:{kind}}};},
  broadcastChatStatus:async()=>{},seeVisibleResult:async()=>{},cleanSessionTitle:(s:string)=>s,
  emitBoth:async(n:V)=>notices.push(n),ChatGPTHandoffTitle:{chatUrl:(s:string)=>s}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.deps={storage,tabs,appendJournal:async(e:V,_tab:V,options?:V)=>{
  if(options?.goalCAS){const cas=options.goalCAS,key='chatgpt-goal:'+cas.url;
   beforeCAS?.();
   if(JSON.stringify(data[key])!==JSON.stringify(cas.expected)||journal.some(x=>x.kind==='request.started'&&x.sequence>cas.fence.requestSequence&&(x.tabId===7||x.sourceUrl===url)))
    throw Object.assign(new Error('fence changed'),{code:'GOAL_FENCE_CHANGED'});
   data[key]=structuredClone(cas.next);
  }
  events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'continuation'};
 const store=runInContext('ChatGPTGoalStore.create(deps)',ctx);ctx.goalController=store;
 runInContext(source,ctx);
 const waitingSource=worker.slice(worker.indexOf('async function reconcileWaitingGoalAnswer('),worker.indexOf('async function reconcileCompletedSourceHandoff('));
 runInContext(waitingSource,ctx);
 return{data,native,checkpoint,request,view,messages,notices,events,journal,storageReads,run:()=>runInContext(`reconcileGoalMarker(7,'${url}')`,ctx),after:(fn:()=>void)=>{after=fn;},beforeCAS:(fn:()=>void)=>{beforeCAS=fn;},route:(s:string)=>{live=s;}};
}
{
 const h=fixture();assert.equal((await h.run()).pending,true);
 assert.equal(h.messages.length,0);assert.equal(h.notices.length,0);assert.equal(h.data['chatgpt-goal:'+url].lastCompletionKey,'');
 Object.assign(h.native,{goalRawExact:true,goalMarkerPending:false});await Promise.all([h.run(),h.run()]);
 assert.equal(h.data['chatgpt-goal:'+url].phase,'completed');assert.equal(h.messages.length,0);assert.equal(h.notices.length,1);
 assert.equal(h.notices[0].isError,false);assert.equal(await h.run(),null);assert.equal(h.notices.length,1);
}
{
 const h=fixture();Object.assign(h.native,{goalResponse:'GOAL_BLOCKED',goalRawExact:true,goalMarkerPending:false});await h.run();
 assert.equal(h.data['chatgpt-goal:'+url].phase,'blocked');assert.equal(h.messages.length,0);assert.equal(h.notices.length,1);assert.equal(h.notices[0].isError,true);
}
for(const patch of [{generating:true},{turnStatus:'in_progress'},{hasError:true},{assistantCompleted:false},{userId:'other'},{assistantKey:'other'}]){
 const h=fixture();Object.assign(h.native,patch);assert.equal((await h.run()).pending,true);assert.equal(h.messages.length,0);assert.equal(h.notices.length,0);
}
for(const kind of ['checkpoint','request','route','new-witness']){
 const h=fixture();Object.assign(h.native,{goalRawExact:true,goalMarkerPending:false});
 h.after(()=>{if(kind==='checkpoint')h.checkpoint.requestId='new-request';if(kind==='request')h.request.requestId='new-request';
  if(kind==='route')h.route('https://chatgpt.com/c/other');if(kind==='new-witness')h.data['chatgpt-goal:'+url].markerPending.completionKey='new-answer';});
 assert.equal((await h.run()).pending,true,kind);assert.equal(h.data['chatgpt-goal:'+url].phase,'waiting',kind);
 assert.equal(h.messages.length,0);assert.equal(h.notices.length,0);
}
console.log('Goal marker reconciliation: settle-before-stop, zero early notices/sends, exact terminal dedupe and request/checkpoint/route/witness race fences passed.');

{
 const h=fixture(),fence={requestId:'request',startedAt:500,userId:'native-user',requestSequence:1};
 h.data['chatgpt-goal:'+url].queuedResumeFence=fence;
 h.journal.push({sequence:1,kind:'request.started',tabId:7,sourceUrl:url,requestId:'request',eventAt:500},
  {sequence:2,kind:'request.started',tabId:8,sourceUrl:url,requestId:'newer',eventAt:700});
 Object.assign(h.native,{goalRawExact:true,goalMarkerPending:false});
 assert.equal((await h.run()).pending,true,'a newer request prevents releasing the resumed Goal marker');
 assert.equal(h.data['chatgpt-goal:'+url].phase,'waiting');assert.equal(h.notices.length,0);
 h.journal.pop();
 const result=await h.run();
 assert.equal(result.ok,true,'a fully witnessed unchanged request settles the marker through the actual coordinator');
 assert.equal(h.data['chatgpt-goal:'+url].phase,'completed');assert.equal(h.notices.length,1);
 assert.ok(h.storageReads.some(keys=>Array.isArray(keys)&&keys[0]==='chatgpt-journal:event:000000000001'),'marker completion exercises the exact anchored range reader');
 assert.equal(h.messages.length,0);assert.equal(await h.run(),null,'settled marker is never replayed');
}
console.log('Queued resume marker: same-request journal fence and actual Goal controller passed.');

{
 const h=fixture(),fence={requestId:'request',startedAt:500,userId:'native-user',requestSequence:1};
 h.data['chatgpt-goal:'+url].queuedResumeFence=fence;
 h.journal.push({sequence:1,kind:'request.started',tabId:7,sourceUrl:url,requestId:'request',eventAt:500});
 Object.assign(h.native,{goalRawExact:true,goalMarkerPending:false});
 h.beforeCAS(()=>h.journal.push({sequence:2,kind:'request.started',tabId:8,sourceUrl:url,requestId:'newer',eventAt:700}));
 assert.equal((await h.run()).pending,true,'a new request between native verification and Goal commit keeps the marker pending');
 assert.ok(h.journal.some((e:any)=>e.requestId==='newer'),'regression must reach the CAS boundary');
 assert.equal(h.data['chatgpt-goal:'+url].phase,'waiting');assert.equal(h.messages.length,0);assert.equal(h.notices.length,0);
}
