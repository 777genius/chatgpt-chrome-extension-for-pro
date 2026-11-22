import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {createRequire} from 'node:module';
const policy=createRequire(import.meta.url)('../extension/goal-policy.js');
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('const retryReadinessRecoveries=new Map();'),source.indexOf('const goalAckProofs=new Map();'));
const url='https://chatgpt.com/c/retry-readiness-fixture',promptKey='/c/retry-readiness-fixture|user-1',attemptId='1000000';
const baseState={reason:'native-not-ready',blocked:true,blockedAttemptId:attemptId,lastAttemptId:attemptId,lastPromptKey:promptKey,failures:[999999],recentErrors:[{at:999999}],sameErrorCount:1};
async function fixture(extra:any={}) {
 let state:any={...structuredClone(baseState),...extra.state},writes=0,calls=0,goalCalls=0,goalPrompt='',lateGrantAdded=false,nativeChanged=false;
 const events:any[]=[...(extra.rebound?[{kind:'request.started',operationId:'handoff',tabId:7,requestId:'request',eventAt:1000000,recordedAt:1000000},{kind:'send.dispatched',operationId:'handoff',tabId:7,text:'Synthetic handoff'}]:[]),...(extra.legacy||extra.unbound||extra.completedProof?[{kind:'request.started',operationId:null,sourceUrl:url,tabId:7,requestId:'request',eventAt:1000000,recordedAt:1000000},{kind:'request.failed',sourceUrl:url,tabId:7,requestId:'request',eventAt:1000050,recordedAt:1000050}]:[]),{kind:'retry.planned',operationId:'op',sourceUrl:url,tabId:7,retryUserId:'user',promptKey:extra.rebound||extra.legacy?'/c/retry-readiness-fixture':promptKey,attemptId,requestId:'request',recordedAt:1000100},
  ...(extra.unbound?[{kind:'recovery.stop_intent',operationId:'op',recoveryBinding:{kind:'user',url,entryId:'native-turn',userId:'user'}}]:[]),
  ...(extra.cleanupOnly||extra.unbound?[]:[{kind:'retry.send_intent',operationId:'op'},{kind:'send.authorized',operationId:'op'}]),
  ...(extra.noRefusal?[]:[{kind:'send.not_clicked',operationId:'op',promptKey:extra.rebound||extra.legacy?'/c/retry-readiness-fixture':promptKey}]),
  {kind:extra.cleanupOnly?'draft.restore_failed':'retry.failed',sourceUrl:url,tabId:7,operationId:'op',attemptId,error:'native-not-ready',clicked:extra.cleanupOnly?undefined:extra.clicked??false},
  {kind:'retry.finished',operationId:'op',clicked:false},...(extra.events||[])];
 if(extra.completedProof){
  extra.goal||={id:'completed-goal',phase:'completed',expectedPromptKey:'/c/retry-readiness-fixture|old-alias',lastCompletionKey:'completed-key',deadlineAt:1,lastConfirmedOperation:{id:'old-operation',tabId:7}};
  events.unshift({kind:'request.started',sourceUrl:url,tabId:7,requestId:'old-request',eventAt:500000,operationId:'old-operation'},
   {kind:'goal.confirmed',sourceUrl:url,tabId:7,goalId:extra.goal.id,operationId:'old-operation'},
   {kind:'goal.answer_complete',sourceUrl:url,tabId:7,goalId:extra.goal.id,completionKey:extra.goal.lastCompletionKey,nativeVerified:true,exactMarker:true});
 }
 if(extra.refusalBeforeGrant){const index=events.findIndex(e=>e.kind==='send.not_clicked');const [refusal]=events.splice(index,1);events.splice(events.findIndex(e=>e.kind==='send.authorized'),0,refusal);}
 events.forEach((e,i)=>{e.sequence=i+1;e.tabId??=7;e.sourceUrl??=url;});
 if(extra.foreignRefusal)events.find(e=>e.kind==='send.not_clicked').tabId=8;
 if(extra.wrongRefusalPrompt)events.find(e=>e.kind==='send.not_clicked').promptKey='different';
 if(extra.unboundGap)events[1].sequence++;
 if(extra.unboundLater){events.push({kind:'request.started',sourceUrl:url,tabId:8,sequence:events.length+1,eventAt:1000200});}
 const native={url,ok:true,isLatest:true,isReadOnly:false,hasError:true,userId:'user',promptKey,lastUserSentAtMs:999990,...(extra.rebound?{generating:false,userText:'Synthetic handoff'}:{}),...(extra.unbound?{generating:false,nativeConversationInactive:false}:{}),...extra.native};
 const appendJournal=async(e:any)=>{writes++;state={...state,blocked:false,preparationRecovered:true};events.push(e);};
 const handoff={id:'handoff',stage:'sent',targetUrl:url,acceptance:{targetUrl:url,messageId:'user'}};
 const chrome={storage:{local:{get:async()=>({handoff:extra.rebound?{...handoff,...extra.handoff}:undefined})}},tabs:{get:async()=>({url:extra.url||url,status:extra.status||'complete'})},scripting:{executeScript:async(o:any)=>{
  calls++;
  if(o.func?.name==='restoreNoClickAttemptBinding')return [{result:extra.bindingRace!==true}];
  if(o.func===inspectCompletedTurn)return [{result:structuredClone(native)}];
  if(extra.unbound&&o.func===inspectChatError&&o.args[2]==='inspect-recovery')assert.deepEqual(o.args[5],{kind:'user',url,entryId:'native-turn',userId:'user'},'recovery reuses the exact persisted native error binding');
  if(o.func===inspectChatError)return [{result:{action:extra.action||'retry',deliveryUserSentAtMs:extra.deliveryTime,...(extra.unbound?{needsIdleProof:true,editorSubmitIdle:true}:{})}}];
  if(extra.unbound&&o.func===controlChatComposer)assert.equal(o.args[0].action,'inspect-plain-retry-draft','unbound recovery never edits or submits the owner draft');
  if(o.func===controlChatComposer){
   if(extra.unrelatedDuringProbe&&!lateGrantAdded){lateGrantAdded=true;events.push({kind:'watcher.started',operationId:'unrelated',tabId:8,sourceUrl:'https://chatgpt.com/c/unrelated-fixture',sequence:events.length+1});}
   if(extra.lateGrantDuringProbe&&!lateGrantAdded){lateGrantAdded=true;events.push({kind:'send.authorized',operationId:'op',tabId:7,sourceUrl:url,sequence:events.length+1});}
   if(extra.nativeNoLongerInactive&&!nativeChanged){nativeChanged=true;native.nativeConversationInactive=false;}
   return [{result:{ok:extra.empty!==false}}];
  }
  return [{result:extra.runtimeEmpty?{}:{attemptId:extra.runtimeAttempt||attemptId,requestId:'request'}}];
 }}};
 function inspectCompletedTurn(){}function inspectChatError(){}function controlChatComposer(){}
 const identity=source.slice(source.indexOf('function proveHandoffRetryIdentity('),source.indexOf('const retryReadinessRecoveries='));
 const [prove,proveLegacy]=new Function(identity+';return [proveHandoffRetryIdentity,proveLegacyNoClickRoute];')();
 const receipt=extra.legacy||extra.unbound||extra.completedProof?{url:extra.unbound?'':url,requestId:'request',startedAt:1000000,submittedUserId:'user',...extra.receipt}:null;
 const fn=new Function('readRetryState','readRetryDraft','readJournal','chrome','goalController','inspectCompletedTurn','inspectChatError','controlChatComposer','appendJournal','completionCheckpointRead','inspectBoundNativeTurn','handoffKey','proveHandoffRetryIdentity','proveLegacyNoClickRoute','latestRequestReceipt','ChatGPTGoalPolicy','readRequestReceipt',
  code+';return recoverNoClickRetry;')(
  async()=>structuredClone(state),async()=>extra.draftRecord|| (extra.draft?{draft:'owner'}:null),async()=>({ok:true,storageError:'',meta:{sequence:events.length},events}),chrome,
  {get:async()=>extra.goal||null,retry:async(e:any)=>{goalCalls++;goalPrompt=e.promptKey;}},inspectCompletedTurn,inspectChatError,controlChatComposer,appendJournal,async()=>({state:'active',url:extra.rebound?'https://chatgpt.com/':url,promptKey:extra.rebound||extra.unbound?'':promptKey,startedAt:1000000,requestId:'request',requestFailedAt:extra.noTransportFailure?undefined:1000050,httpCompleted:extra.httpCompleted!==false,...extra.checkpoint}),async()=>structuredClone(native),()=> 'handoff',prove,proveLegacy,async()=>receipt,policy,async(_tabId:number,query:any)=>{assert.equal(query.requestId,'old-request');return extra.missingReceipt?null:{requestId:'old-request',startedAt:500000,operationId:'old-operation',url:'',submittedUserId:extra.sameCompletedUser?'user':'old-native-user',tabId:7};});
 const result=await fn(7,url);return {result,get writes(){return writes;},calls,goalCalls,goalPrompt,fn,events};
}
const safe=await fixture();assert.equal(safe.writes,1);assert.equal(safe.result.blocked,false);
const legacy=await fixture({legacy:true,state:{lastPromptKey:'/c/retry-readiness-fixture'},deliveryTime:999990,native:{generating:false},goal:{phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',expectedPromptKey:promptKey,deadlineAt:Date.now()+60000}});
assert.equal(legacy.writes,1,'an exact no-click route-only failure may recover with native and request proof');
assert.equal(legacy.goalPrompt,promptKey,'recovery rebinds the proven native user instead of sending a route-only retry');
assert.equal((await fixture({legacy:true,state:{lastPromptKey:'/c/retry-readiness-fixture'},deliveryTime:999980,native:{generating:false},goal:{phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',expectedPromptKey:promptKey,deadlineAt:Date.now()+60000}})).writes,0,'unmatched delivery error cannot recover');
const rebound=await fixture({rebound:true,runtimeEmpty:true,deliveryTime:999990,goal:{phase:'waiting',expectedPromptKey:null,deadlineAt:Date.now()+60000}});
assert.equal(rebound.writes,1,'accepted handoff, failed root request and current message restore the no-click retry');
assert.equal(rebound.result.blocked,false);
assert.equal(rebound.goalPrompt,promptKey,'Goal receives the confirmed rebound prompt key');
for(const extra of [{handoff:{stage:'awaiting-confirmation'}},{native:{userId:'other'}},{noTransportFailure:true},{deliveryTime:999980},{goal:{phase:'paused',deadlineAt:Date.now()+60000}}])
 assert.equal((await fixture({rebound:true,runtimeEmpty:true,deliveryTime:999990,goal:{phase:'waiting',expectedPromptKey:null,deadlineAt:Date.now()+60000},...extra})).writes,0);
await safe.fn(7,url);assert.equal(safe.result.preparationRecovered,true);
for(const extra of [{clicked:true},{noRefusal:true},{draft:true},{empty:false},{status:'unloaded'},
 {state:{reason:'budget exhausted'}},{state:{terminal:true}},{state:{remainingRetries:0}},{state:{preparationRecoveries:2}},
 {native:{userId:'different-user'}},{native:{hasError:false}},{native:{isLatest:false}},{native:{isReadOnly:true}},{native:{lastUserSentAtMs:500000}},
 {native:{promptKey:'other'}},{runtimeAttempt:'2000000'},{action:'new-chat'},
 {goal:{phase:'stopped'}},{goal:{phase:'paused'}},{goal:{phase:'blocked',operation:{status:'clicked'}}},
 {events:[{kind:'send.dispatched',operationId:'op'}]},
 {events:[{kind:'request.started',operationId:'other',sourceUrl:url,tabId:8,recordedAt:1000200}]},
 {events:[{kind:'retry.failed',sourceUrl:url,tabId:8,operationId:'unknown',attemptId,clicked:true}]},
 {events:[{kind:'draft.restore_failed',sourceUrl:url,tabId:7,operationId:'op',attemptId}]}]) {
 const test=await fixture(extra);assert.equal(test.writes,0,JSON.stringify(extra));
}
const emptyTerminal={hasError:false,terminalEmptyResponse:true,nativeConversationInactive:true};
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal})).writes,1,'no-click own-text cleanup may recover a verified empty terminal response');
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal,httpCompleted:false})).writes,0);
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal,events:[{kind:'draft.saved',operationId:'op'}]})).writes,0,'an historical owner draft remains fenced');
assert.equal((await fixture({cleanupOnly:true,native:{hasError:true}})).writes,0);
// Real reducer preserves historical failures/limits and makes the grant one-use.
const ctx=createContext({URL,Date});runInContext(readFileSync('extension/journal-store.js','utf8'),ctx);
ctx.state={[new URL(url).pathname.split('/').at(-1)!]:{...baseState,remainingRetries:2}};
ctx.event={kind:'retry.preparation_recovered',sourceUrl:url,promptKey,attemptId,preparationDraftOperationId:'op',preparationDraftSequence:12};
const recovered=runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!];
assert.equal(recovered.blocked,false);assert.equal(recovered.remainingRetries,2);
assert.deepEqual(recovered.failures,baseState.failures);assert.equal(recovered.preparationRecoveries,1);
assert.equal(recovered.preparationDraftOperationId,'op');assert.equal(recovered.preparationDraftSequence,12);
ctx.state={fixture:1,[new URL(url).pathname.split('/').at(-1)!]:recovered};
ctx.event={kind:'retry.planned',sourceUrl:url,operationId:'fresh'};
const planned=runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!];
assert.equal(planned.preparationRecovered,false);assert.equal(planned.remainingRetries,1);
console.log('No-click retry recovery: exact native/journal proof; unknown sends, cross-tab failures, drafts, Stop and budgets remain fenced.');

const carry={operationId:'op',attemptId,phase:'not-clicked',savedSequence:12,draft:'Synthetic owner draft'};
assert.equal((await fixture({draftRecord:carry,native:{generating:false,nativeConversationInactive:true}})).writes,1,'proven no-click backup is carried into the same protected retry');
for(const draftRecord of [{...carry,phase:'unknown'},{...carry,claimedAt:1},{...carry,operationId:'other'},{...carry,attemptId:'other'}])
 assert.equal((await fixture({draftRecord,native:{generating:false,nativeConversationInactive:true}})).writes,0);
assert.equal((await fixture({draftRecord:carry,native:{generating:true,nativeConversationInactive:true}})).writes,0);

ctx.state={[new URL(url).pathname.split('/').at(-1)!]:recovered};ctx.event={kind:'retry.confirmed',sourceUrl:url};
assert.equal(runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!].preparationDraftOperationId,null,'a confirmed retry retires the carry reference');

assert.equal((await fixture({runtimeEmpty:true,draftRecord:carry,native:{generating:false,nativeConversationInactive:true}})).writes,1,'restart restores only the failed durable request with positive native idle evidence');
assert.equal((await fixture({runtimeEmpty:true,draftRecord:carry,bindingRace:true,native:{generating:false,nativeConversationInactive:true}})).writes,0);
assert.equal((await fixture({runtimeEmpty:true,draftRecord:carry,native:{generating:true,nativeConversationInactive:true}})).writes,0);

assert.equal((await fixture({runtimeEmpty:true,noTransportFailure:true,draftRecord:carry,native:{generating:false,nativeConversationInactive:true}})).writes,0,'an absent runtime alone never authorizes retry recovery');

assert.equal((await fixture({goal:{phase:'completed',expectedPromptKey:'prior-prompt'}})).writes,0,'a different rendered key alone cannot establish a new native request after Goal completion');
assert.equal((await fixture({goal:{phase:'completed',expectedPromptKey:promptKey}})).writes,0,'the completed Goal response itself stays terminal');

assert.equal((await fixture({draftRecord:carry,deliveryTime:999990,native:{generating:false,nativeConversationInactive:false}})).writes,1,'exact native input-delivery failure may recover a parked draft despite stale aggregate turn state');
assert.equal((await fixture({draftRecord:carry,deliveryTime:999980,native:{generating:false,nativeConversationInactive:false}})).writes,0,'different delivery error user is not idle proof');

{
 const f=await fixture({unbound:true,draftRecord:carry});
 assert.equal(f.writes,1,'failed manual request before checkpoint bind recovers a no-click preparation with its saved draft');
 assert.equal(f.goalPrompt,promptKey);
 const event=f.events.at(-1);assert.equal(event.kind,'retry.preparation_recovered');
 assert.equal(event.legacyNoClick.newPromptKey,promptKey,'existing atomic journal fence guards the independently proven request');
 assert.equal(event.legacyNoClick.expectedSequence,f.events.length-1);
 assert.equal(event.preparationDraftOperationId,'op');assert.equal(event.preparationDraftSequence,12);
 await f.fn(7,url);assert.equal(f.writes,1,'the recovered reservation is not released twice');
}
for(const extra of [{clicked:true},{unboundGap:true},{unboundLater:true},
 {receipt:{operationId:'unknown-automatic'}},{receipt:{submittedUserId:'other'}},
 {goal:{phase:'paused'}},{goal:{phase:'stopped'}},{state:{remainingRetries:0}},{state:{preparationRecoveries:2}},
 {events:[{kind:'send.dispatched',operationId:'op'}]},
 {events:[{kind:'goal.stop_requested',operationId:'op',sourceUrl:url,tabId:7}]}])
 assert.equal((await fixture({unbound:true,draftRecord:carry,...extra})).writes,0,'unbound no-click recovery fence: '+JSON.stringify(extra));
console.log('Unbound no-click recovery: same manual failed request, saved draft and atomic journal fence; no click or budget reset.');

assert.equal((await fixture({unbound:true,runtimeEmpty:true,draftRecord:carry})).writes,1,'an extension restart can restore only the already-proven manual runtime binding');

assert.equal((await fixture({unbound:true,draftRecord:carry,goal:{phase:'completed',expectedPromptKey:'/c/retry-readiness-fixture|earlier-user',deadlineAt:1}})).writes,0,'unknown final native identity keeps an expired completed Goal terminal');
assert.equal((await fixture({unbound:true,draftRecord:carry,goal:{phase:'completed',expectedPromptKey:'/c/retry-readiness-fixture|earlier-user',deadlineAt:1,stopRequested:true}})).writes,0,'explicit Stop still blocks independent retry recovery');

for(const unbound of [false,true])for(const initialUserId of ['user','initial-user']) {
 const goal={phase:'completed',expectedPromptKey:'/c/retry-readiness-fixture|earlier-alias',deadlineAt:Date.now()+60000,
  manualStart:{userId:initialUserId},lastConfirmedOperation:{id:'last-continuation',tabId:7}};
 assert.equal((await fixture({unbound,draftRecord:carry,native:{generating:false,nativeConversationInactive:true},goal})).writes,0,
  'completed Goal cannot recover through prompt alias or initial-user identity');
}

for(const unbound of [false,true]) {
 const result=await fixture({unbound,completedProof:true,draftRecord:carry,native:{generating:false,nativeConversationInactive:true}});
 assert.equal(result.writes,1,'a completed automatic continuation with a different captured native ID permits a new failed manual retry');
 assert.equal(result.events.at(-1).legacyNoClick.expectedSequence,result.events.length-1,'both paths commit through the atomic journal fence');
 for(const extra of [{sameCompletedUser:true},{missingReceipt:true}])
  assert.equal((await fixture({unbound,completedProof:true,draftRecord:carry,native:{generating:false,nativeConversationInactive:true},...extra})).writes,0,'same-user alias or missing receipt stays terminal');
}

for(const extra of [
 {native:{generating:false,nativeConversationInactive:false}},
 {noTransportFailure:true,httpCompleted:false},
 {checkpoint:{requestId:'another'}},{checkpoint:{startedAt:900000}},
 {checkpoint:{state:'completed'}},{checkpoint:{promptKey:'other'}},
 {checkpoint:{url:'https://chatgpt.com/c/other'}}
])assert.equal((await fixture({completedProof:true,native:{generating:false,nativeConversationInactive:true},...extra})).writes,0,
 'completed Goal identity never replaces terminal bound checkpoint and native inactivity: '+JSON.stringify(extra));
for(const extra of [
 {refusalBeforeGrant:true},{foreignRefusal:true},{wrongRefusalPrompt:true},
 {events:[{kind:'send.authorized',operationId:'op'}]},
 {events:[{kind:'retry.send_intent',operationId:'op'}]},
 {events:[{kind:'send.not_clicked',operationId:'op'}]}
])assert.equal((await fixture({completedProof:true,native:{generating:false,nativeConversationInactive:true},...extra})).writes,0,
 'no-click refusal cannot excuse an ambiguous later grant: '+JSON.stringify(extra));

for(const extra of [{lateGrantDuringProbe:true},{nativeNoLongerInactive:true}])
 assert.equal((await fixture({completedProof:true,native:{generating:false,nativeConversationInactive:true},...extra})).writes,0,
  'bound completed retry rechecks grant order and inactivity after page probes: '+JSON.stringify(extra));
assert.equal((await fixture({completedProof:true,noTransportFailure:true,native:{generating:false,nativeConversationInactive:true}})).writes,1,
 'an exact HTTP-completed checkpoint plus native inactivity remains a valid bound terminal proof');

{
 const result=await fixture({unbound:true,draftRecord:carry,unrelatedDuringProbe:true});
 assert.equal(result.writes,1,'unrelated journal growth preserves the exact no-click request proof');
 assert.equal(result.events.at(-1).legacyNoClick.expectedSequence,result.events.length-1,'atomic consumer receives the last verified head');
}
