import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/manual-goal-fixture',baseline='/c/manual-goal-fixture|u-initial';
const worker=readFileSync('extension/service-worker.js','utf8');
const helper=worker.slice(worker.indexOf('async function bindNativeManualSupplement('),worker.indexOf('chrome.runtime.onMessage.addListener',worker.indexOf('async function bindNativeManualSupplement(')));
type Value=Record<string,any>;
async function fixture(phase='waiting') {
 const data:Value={},events:Value[]=[],messages:Value[]=[],probes:Value[]=[];
 let time=100030,live=url,request:Value|null={requestId:'manual-2',startedAt:100020,url},afterProbe:(()=>void)|null=null;
 let native:Value={ok:true,url,isLatest:true,isReadOnly:false,userId:'u-followup',userText:'  Additional task\nkeep exact  ',userSentAtMs:100020,
  promptKey:'/c/manual-goal-fixture|u-followup',turnStatus:'in_progress',generating:true,hasError:false,assistantCompleted:false,assistantPhase:'final_answer',assistantKey:'a-followup',goalResponse:'GOAL_COMPLETE',goalRawExact:true};
 const context=createContext({URL,console,latestRequestReceipt:async()=>structuredClone(request),inspectCompletedTurn:function(){},chrome:{tabs:{get:async()=>({id:7,url:live})},scripting:{executeScript:async(options:Value)=>{probes.push(options);const result=structuredClone(native);afterProbe?.();return [{result}];}}}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),context);
 const dependencies={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:Value)=>Object.assign(data,structuredClone(v))},tabs:{get:async()=>({id:7,url:live}),sendMessage:async(tabId:number,message:Value)=>{messages.push({tabId,message});return {ok:true,idle:true};}},appendJournal:async(e:Value)=>events.push(e),now:()=>time,uuid:()=> 'op-'+messages.length};
 context.dependencies=dependencies;const store=runInContext('ChatGPTGoalStore.create(dependencies)',context);context.goalController=store;
 data['chatgpt-goal:'+url]={schema:1,id:'original-goal-id',url,originUrl:url,goal:'Original immutable objective',rules:'Original criteria',phase,continuations:3,maxContinuations:10,maxMinutes:1440,startedAt:100000,manualStartedAt:100000,deadlineAt:86500000,expectedPromptKey:baseline,lastCompletionKey:'',operation:null,pauseRequested:false,stopRequested:false};
 runInContext(helper,context);
 const args=()=>({url,tabId:7,startedAt:request?.startedAt,requestId:request?.requestId,eventAt:100010,text:'  Additional task\nkeep exact  ',baselineKey:baseline});
 return {data,events,messages,probes,store,context,args,record:()=>data['chatgpt-goal:'+url],manual:()=>store.manual(args()),bind:()=>runInContext(`bindNativeManualSupplement(7,${JSON.stringify(url)})`,context) as Promise<Value>,native:()=>native,setNative:(v:Value)=>Object.assign(native,v),setRequest:(v:Value|null)=>{request=v;},route:(v:string)=>{live=v;},onProbe:(fn:()=>void)=>{afterProbe=fn;},clock:(n:number)=>{time=n;},fresh:()=>runInContext('ChatGPTGoalStore.create(dependencies)',context)};
}
for(const phase of ['waiting','paused']) {
 const h=await fixture(phase),original=structuredClone(h.record());
 await h.manual();assert.equal(h.record().phase,phase);assert.equal(h.record().goal,original.goal);assert.equal(h.messages.length,0);
 assert.equal((await h.bind()).pending,false);assert.equal(h.record().supplements.length,1);assert.equal(h.record().supplements[0].userText,h.native().userText);
 for(const k of ['id','goal','deadlineAt','maxContinuations','maxMinutes','continuations'])assert.equal(h.record()[k],original[k],k+' is retained');
 assert.equal(h.record().phase,phase);assert.equal(h.record().expectedPromptKey,h.native().promptKey);
 await h.manual();await h.bind();assert.equal(h.record().supplements.length,1,'duplicate acknowledgement cannot append twice');
 const policy=runInContext('ChatGPTGoalPolicy',h.context);const text=policy.continuationText(h.record()),handoff=policy.handoffText(h.record());
 assert.ok(text.indexOf(original.goal)<text.indexOf(h.native().userText));assert.ok(handoff.includes(h.native().userText));
 h.setNative({turnStatus:'complete',generating:false,assistantCompleted:true,goalResponse:'Still working',goalRawExact:false});await h.store.completion({url,tabId:7,promptKey:h.native().promptKey,completionKey:h.native().promptKey+'|a-followup',response:'Still working',userId:h.native().userId,nativeVerified:true,rawExact:false});
 assert.equal(h.messages.length,phase==='paused'?0:1,'active manual send continues automatically; explicit Pause remains paused');
 if(phase==='paused'){await h.store.control({url,tabId:7,action:'resume'});assert.equal(h.messages.length,1);}
 assert.match(h.messages[0].message.text,/Original immutable objective/);assert.match(h.messages[0].message.text,/Additional task/);
}
{
 const h=await fixture();await h.manual();
 // A completion can race the native sent-message proof and worker restart.
 await h.store.completion({url,tabId:7,promptKey:h.native().promptKey,completionKey:h.native().promptKey+'|a-followup',response:'GOAL_COMPLETE',userId:h.native().userId,nativeVerified:true,rawExact:true});
 assert.equal(h.record().phase,'waiting');assert.equal(h.messages.length,0);assert.equal(h.record().supplements,undefined);
 h.context.goalController=h.fresh();await h.bind();assert.equal(h.record().phase,'completed');assert.equal(h.record().supplements.length,1);assert.equal(h.messages.length,0);
}
for(const patch of [{userText:'Other text'},{userSentAtMs:80000},{userId:''},{promptKey:baseline},{isLatest:false},{isReadOnly:true}]) {
 const h=await fixture();await h.manual();h.setNative(patch);await h.bind();assert.ok(h.record().manualPending);assert.equal(h.record().supplements,undefined);assert.equal(h.messages.length,0);
}
{
 const h=await fixture('paused');await h.manual();
 const original=structuredClone(h.record());
 h.setRequest(null);
 h.setNative({isLatest:false,historicalUserBound:true,userText:'[Additional task](https://example.com) keep exact',
   userVisibleText:'  Additional task\n\nkeep exact  '});
 assert.equal((await h.bind()).pending,false,'historic native user survives superseded request cache');
 assert.equal(h.record().supplements.length,1);
 assert.equal(h.record().supplements[0].text,original.manualPending.text,'preserve original user wording');
 for(const key of ['id','goal','deadlineAt','maxContinuations','continuations'])assert.equal(h.record()[key],original[key]);
 assert.equal(h.messages.length,0,'historical adoption never sends a user draft');
 assert.equal(h.record().phase,'paused','historical adoption preserves pause');
}
for(const request of [null,{requestId:'wrong',startedAt:100020,url},{requestId:'manual-2',startedAt:100020,url:'https://chatgpt.com/c/other'}]) {
 const h=await fixture();await h.manual();h.setRequest(request);await h.bind();assert.equal(h.record().supplements,undefined);assert.equal(h.probes.length,1,'a historical read cannot adopt a latest-turn fixture after cache supersession');
}
{
 const h=await fixture();await h.manual();h.onProbe(()=>h.setRequest({requestId:'newer',startedAt:100030,url}));await h.bind();assert.equal(h.record().supplements,undefined);assert.equal(h.messages.length,0);
}
{
 const h=await fixture();await h.manual();h.setNative({userText:'  [Additional](https://example.test/task) task\nkeep exact  ',userVisibleText:h.args().text});await h.bind();assert.equal(h.record().goal,'Original immutable objective');assert.match(h.record().supplements[0].userText,/https:\/\/example.test/);
 const previous=structuredClone(h.record());await h.store.manual({...h.args(),startedAt:100019});assert.deepEqual(h.record(),previous,'stale manual request cannot replace a newer binding');
 await assert.rejects(()=>h.store.manual({...h.args(),text:'Rewritten payload'}),/другим текстом/);
}
{
 const h=await fixture('preparing');h.record().operation={id:'reserved',kind:'continuation',tabId:7,status:'reserved',createdAt:100005,text:'Old continuation'};
 await h.manual();assert.equal(h.record().operation,null);assert.equal(h.record().phase,'waiting');
 assert.equal((await h.store.check({url,tabId:7,id:h.record().id,operationId:'reserved'})).ok,false);
 await h.bind();assert.equal(h.record().phase,'waiting');assert.equal(h.messages.length,0);
}
for(const confirmed of [false,true]) {
 const h=await fixture('sending');h.record().operation={id:'consumed',kind:'continuation',tabId:7,status:'intent',createdAt:100005,baselineKey:baseline,text:'Old continuation'};
 await h.manual();await h.bind();assert.equal(h.record().operation.id,'consumed');assert.equal(h.record().phase,'sending');assert.equal(h.messages.length,0);
 await assert.rejects(()=>h.store.authorize({url,tabId:7,id:h.record().id,operationId:'consumed',text:'Old continuation'}),/более не разрешена/,'verified newer manual message cannot reauthorize the older consumed send');
 if(confirmed){await h.store.report({url,tabId:7,id:h.record().id,operationId:'consumed',status:'confirmed',newPromptKey:'/c/manual-goal-fixture|old-auto'});assert.equal(h.record().expectedPromptKey,h.native().promptKey);assert.equal(h.record().phase,'waiting');}
 else {await h.store.report({url,tabId:7,id:h.record().id,operationId:'consumed',status:'blocked',reason:'Unknown consumed send'});assert.equal(h.record().phase,'blocked');assert.equal(h.record().operation.id,'consumed');}
}
{
 const h=await fixture();await h.manual();await h.bind();await h.store.handoffBegin({sourceUrl:url,handoffId:'handoff',tabId:7});
 await h.store.handoffConfirm({sourceUrl:url,targetUrl:'https://chatgpt.com/c/manual-target',handoffId:'handoff',tabId:7,acceptedUserId:'handoff-user'});
 const moved=h.data['chatgpt-goal:https://chatgpt.com/c/manual-target'];assert.equal(moved.goal,'Original immutable objective');assert.equal(moved.supplements.length,1);assert.equal(moved.id,'original-goal-id');assert.equal(moved.continuations,3);assert.equal(moved.deadlineAt,86500000);
}
{
 const h=await fixture();await h.manual();
 await assert.rejects(()=>h.store.handoffBegin({sourceUrl:url,handoffId:'early-handoff',tabId:7}),/ещё не подтверждено/);
 const original=structuredClone(h.record());h.route('https://chatgpt.com/c/other');await h.bind();assert.equal(h.record().supplements,undefined);assert.equal(h.record().id,original.id);
}
{
 const h=await fixture();await h.manual();await h.bind();
 h.setRequest({requestId:'manual-3',startedAt:100040,url});h.clock(100050);
 await h.store.manual({...h.args(),startedAt:100040,requestId:'manual-3',eventAt:100035,text:'Second verified follow-up',baselineKey:h.native().promptKey});
 h.setNative({userId:'u-followup-2',userText:'Second verified follow-up',userSentAtMs:100040,promptKey:'/c/manual-goal-fixture|u-followup-2'});
 await h.bind();assert.deepEqual(h.record().supplements.map((s:Value)=>s.userText),['  Additional task\nkeep exact  ','Second verified follow-up']);
 const policy=runInContext('ChatGPTGoalPolicy',h.context),text=policy.handoffText(h.record());
 assert.ok(text.indexOf('Original immutable objective')<text.indexOf('Additional task'));assert.ok(text.indexOf('Additional task')<text.indexOf('Second verified follow-up'));
}
{
 const h=await fixture();const initial=structuredClone(h.record());
 await h.store.manual({...h.args(),text:'x'.repeat(10001)});
 assert.equal(h.record().goal,initial.goal);assert.equal(h.record().supplements,undefined);assert.equal(h.record().manualPending,undefined);
 assert.equal(h.record().phase,'paused','unsupported unverified payload fails closed without silently appending text');assert.equal(h.messages.length,0);
}
console.log('Manual Goal follow-ups: exact native request/text binding, immutable original, chronological payloads, pause/budget retention, early ACK/reload and unknown-send fences passed.');

{
 const h=await fixture('paused');await h.manual();
 h.setRequest({requestId:'manual-3',startedAt:130040,url});h.clock(130050);
 await h.store.manual({...h.args(),eventAt:130035,text:'Second pending follow-up',baselineKey:'/c/manual-goal-fixture|u-followup'});
 assert.equal(h.record().manualPending.requestId,'manual-2','earliest unbound request must survive a second send');
 h.setNative({isLatest:false,historicalUserBound:true});
 assert.equal((await h.bind()).pending,true,'drain pauses safely when next native user is not yet available');
 assert.equal(h.record().supplements.length,1);
 h.setNative({isLatest:true,userId:'u-second',userText:'Second pending follow-up',userSentAtMs:130040,promptKey:'/c/manual-goal-fixture|second'});
 assert.equal((await h.bind()).pending,false);
 assert.deepEqual(h.record().supplements.map((item:Value)=>item.text),['  Additional task\nkeep exact  ','Second pending follow-up']);
 assert.equal(h.record().phase,'paused');assert.equal(h.messages.length,0);
}

{
 const h=await fixture('paused');await h.manual();h.setRequest(null);
 h.setNative({isLatest:true,historicalUserBound:true});
 assert.equal((await h.bind()).pending,false,'exact historical user can share the latest native aggregate');
 assert.equal(h.record().supplements.length,1);assert.equal(h.messages.length,0);
}

{
 const h=await fixture();await h.manual();
 h.setRequest({requestId:'manual-3',startedAt:130040,url});h.clock(130050);
 await h.store.manual({...h.args(),eventAt:130035,text:'Second pending follow-up',baselineKey:'/c/manual-goal-fixture|u-followup'});
 const latestPrompt='/c/manual-goal-fixture|second';
 await h.store.completion({url,tabId:7,promptKey:latestPrompt,completionKey:latestPrompt+'|answer',response:'GOAL_COMPLETE',userId:'u-second',nativeVerified:true,rawExact:true});
 h.context.goalController=h.fresh();
 h.setNative({isLatest:false,historicalUserBound:true});await h.bind();
 assert.equal(h.record().manualPending.requestId,'manual-3','reload preserves the remaining request');
 assert.equal(h.messages.length,0,'binding earlier clarification never dispatches while newer one awaits proof');
 h.setNative({isLatest:true,userId:'u-second',userText:'Second pending follow-up',userSentAtMs:130040,promptKey:latestPrompt});
 await h.bind();assert.equal(h.record().phase,'completed','only latest buffered completion replays after all clarifications bind');
 assert.equal(h.record().supplements.length,2);assert.equal(h.messages.length,0);
}
