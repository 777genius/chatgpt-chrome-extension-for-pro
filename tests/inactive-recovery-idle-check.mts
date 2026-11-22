import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const policy=createRequire(import.meta.url)('../extension/goal-policy.js');
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('async function proveInactiveRecoveryIdle('),source.indexOf('const goalAckProofs=new Map();'));
const url='https://chatgpt.com/c/idle-recovery-fixture';
async function fixture(extra:any={}){
 const message={operationId:'recovery',attemptId:'1000000',requestId:'request',promptKey:'/c/idle-recovery-fixture|user',alertIndex:0,recoveryBinding:{kind:'user',userId:'user'}};
 const cp={state:'active',url,promptKey:message.promptKey,startedAt:1000000,requestId:'request',requestFailedAt:1000100,...extra.checkpoint};
 const native={url,ok:true,isLatest:true,isReadOnly:false,hasError:true,generating:false,nativeConversationInactive:true,promptKey:message.promptKey,userId:'user',lastUserSentAtMs:999990,...extra.native};
 const receipt={requestId:'request',startedAt:1000000,url:'',submittedUserId:'user',...extra.receipt};let reads=0,probes=0,nativeReads=0;
 const journal:any={ok:true,meta:{sequence:103},events:[{sequence:101,kind:'request.started',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000000,operationId:null},{sequence:102,kind:'request.failed',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000100,operationId:null},{sequence:103,kind:'retry.planned',tabId:7,sourceUrl:url,operationId:'recovery'}],...extra.journal};
 let goal:any=extra.goal||null;extra.mutate?.({journal,receipt,cp,native});
 function controlChatComposer(){}function inspectChatError(){}
 const chrome={tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async(o:any)=>{probes++;extra.onProbe?.({journal,receipt,cp,native,setGoal:(v:any)=>{goal=v;}});return [{result:o.func===controlChatComposer?{ok:extra.editor!==false}:(extra.freshSurface||{needsIdleProof:extra.fresh!==false,editorSubmitIdle:extra.freshSubmitIdle===true})}];}}};
 const fn=new Function('completionCheckpointRead','inspectBoundNativeTurn','chrome','controlChatComposer','inspectChatError','latestRequestReceipt','readJournal','goalController','readRequestReceipt','ChatGPTGoalPolicy',code+';return proveInactiveRecoveryIdle;')(
  async()=>++reads>1&&extra.race?{...cp,requestId:'new'}:cp,async()=>{nativeReads++;return structuredClone(extra.nativeRace&&nativeReads>1?{...native,userId:'other'}:native);},chrome,controlChatComposer,inspectChatError,async()=>extra.requestRace?{}:receipt,async()=>structuredClone(journal),{get:async()=>structuredClone(goal)},async(_tabId:number,query:any)=>{if(extra.savedReceipt)assert.equal(query.requestId,'old-request');return structuredClone(extra.savedReceipt||null);},policy);
 return {result:await fn(7,url,{...message,...extra.message},receipt,extra.surfaceProof||{}),probes};
}
assert.equal((await fixture()).result.proof,'native-inactive-error-editor','a plain draft does not require the voice button');
for(const extra of [{checkpoint:{requestFailedAt:undefined,httpCompleted:false}},
 {native:{generating:true}},{native:{nativeConversationInactive:false}},{native:{hasError:false}},
 {native:{userId:'other'}},{native:{promptKey:'other'}},{native:{isReadOnly:true}},
 {checkpoint:{requestId:'other'}},{editor:false},{fresh:false},{race:true},{requestRace:true},
 {message:{recoveryBinding:{kind:'assistant-only'}}},{url:'https://chatgpt.com/c/other'}])
 assert.equal((await fixture(extra)).result,null,JSON.stringify(extra));
assert.equal((await fixture({checkpoint:{requestFailedAt:undefined,httpCompleted:true}})).result.idle,true);
console.log('Inactive recovery: terminal transport, exact native user/request/controller, fresh surface and race fences; no Stop/Send effects.');

assert.equal((await fixture({native:{nativeConversationInactive:false},surfaceProof:{editorSubmitIdle:true},freshSubmitIdle:true})).result.idle,true,'exact terminal error plus native draft Send readiness is an idle proof');
assert.equal((await fixture({native:{nativeConversationInactive:false},surfaceProof:{editorSubmitIdle:true}})).result,null,'native Send readiness must still be present on the fresh error surface');

const unbound={checkpoint:{promptKey:''},native:{nativeConversationInactive:false},surfaceProof:{editorSubmitIdle:true},freshSubmitIdle:true};
assert.equal((await fixture(unbound)).result?.idle,true,'captured native manual user and contiguous failed-request journal replace only an empty checkpoint binding');
for(const change of [
 (x:any)=>x.receipt.submittedUserId='other', (x:any)=>delete x.receipt.submittedUserId,
 (x:any)=>x.receipt.operationId='unknown-automatic', (x:any)=>x.receipt.startedAt++,
 (x:any)=>x.receipt.requestId='other', (x:any)=>x.receipt.tabId=8, (x:any)=>x.receipt.url='https://chatgpt.com/c/other',
 (x:any)=>x.journal.events[0].operationId='unknown-automatic', (x:any)=>x.journal.events[0].sourceUrl='https://chatgpt.com/',
 (x:any)=>x.journal.events[1].eventAt++, (x:any)=>x.journal.events[1].requestId='other',
 (x:any)=>x.journal.events[1].sequence=104, (x:any)=>x.journal.events.splice(1,1),
 (x:any)=>x.journal.events[1].previousWriteError='missing-event',
 (x:any)=>x.journal.meta.sequence++, (x:any)=>x.journal.storageError='failure', (x:any)=>x.journal.ok=false,
 (x:any)=>x.native.lastUserSentAtMs=1, (x:any)=>x.native.url='https://chatgpt.com/c/other',
 (x:any)=>x.journal.meta.active={8:{chatUrl:url,operationId:'other'}},
 (x:any)=>x.journal.meta.retryPreparingByChat={[url]:{operationId:'other'}},
 (x:any)=>x.journal.meta.retrySendClaims={claim:{sourceUrl:url,operationId:'recovery',phase:'consumed'}},
 (x:any)=>x.journal.meta.handoffSourceClaims={[url]:{operationId:'handoff'}}
])assert.equal((await fixture({...unbound,mutate:change})).result,null,'unbound proof refuses '+String(change));
for(const kind of ['request.started','goal.paused','goal.stopped','goal.stop_requested','goal.send_intent','handoff.sending','send.authorized','send.dispatched','retry.clicked','goal.clicked','handoff.navigating']) {
 assert.equal((await fixture({...unbound,mutate:({journal}:any)=>{journal.events.push({sequence:104,kind,tabId:7,sourceUrl:url,operationId:'recovery'});journal.meta.sequence=104;}})).result,null,kind);
}
assert.equal((await fixture({...unbound,mutate:({journal}:any)=>{journal.events.push({sequence:104,kind:'draft.saved',tabId:7,sourceUrl:url,operationId:'other'});journal.meta.sequence=104;}})).result,null,'another operation never inherits an unbound failed request');
for(const goal of [{phase:'paused'},{phase:'stopped'},{phase:'waiting',stopRequested:true},{phase:'waiting',pauseRequested:true},{phase:'preparing',operation:{id:'other'}}])
 assert.equal((await fixture({...unbound,goal})).result,null,JSON.stringify(goal));
for(const onProbe of [
 ({receipt}:any)=>{receipt.submittedUserId='other';},
 ({journal}:any)=>{journal.events.push({sequence:104,kind:'request.started',tabId:8,sourceUrl:url});journal.meta.sequence=104;},
 ({setGoal}:any)=>setGoal({phase:'paused'}),
 ({native}:any)=>{native.generating=true;}
])assert.equal((await fixture({...unbound,onProbe})).result,null,'proof is rechecked after editor inspection');
assert.equal((await fixture({...unbound,nativeRace:true})).result,null,'a newer native user invalidates the unbound proof');
assert.equal((await fixture({...unbound,checkpoint:{promptKey:'different'}})).result,null,'a conflicting nonempty checkpoint never uses the unbound exception');
console.log('Unbound inactive recovery: exact captured native user, contiguous manual failed request, Stop/Pause/other-operation and fresh proof fences; no rebind or click.');

for(const field of ['clicked','confirmed'])assert.equal((await fixture({...unbound,mutate:({journal}:any)=>{journal.events.push({sequence:104,kind:'retry.finished',operationId:'recovery',tabId:7,[field]:true});journal.meta.sequence=104;}})).result,null,'unknown automatic '+field+' cannot use a missing prompt binding');

{
 const completed={phase:'completed',expectedPromptKey:'/c/idle-recovery-fixture|earlier-user',deadlineAt:1};
 assert.equal((await fixture({...unbound,goal:completed})).result,null,'a different rendered key cannot prove independent native identity after Goal completion');
 for(const patch of [{phase:'stopped'},{phase:'paused'},{stopRequested:true},{pauseRequested:true},
  {operation:{id:'unknown'}},{expectedPromptKey:'/c/idle-recovery-fixture|user'},
  {expectedPromptKey:''},{phase:'waiting'}])
  assert.equal((await fixture({...unbound,goal:{...completed,...patch}})).result,null,'completed Goal exception preserves '+JSON.stringify(patch));
}

for(const deadlineAt of [1,Date.now()+60000]) {
 const goal={phase:'completed',expectedPromptKey:'/c/idle-recovery-fixture|older-alias',deadlineAt,
  manualStart:{userId:'user'},lastConfirmedOperation:{id:'last-continuation',tabId:7}};
 assert.equal((await fixture({...unbound,goal})).result,null,'same native user with different prompt aliases remains terminal');
 goal.manualStart.userId='initial-user';
 assert.equal((await fixture({...unbound,goal})).result,null,'initial native user does not identify the final automatic continuation');
}

function completedProof(automatic=true):any {
 const goal:any={id:'completed-goal',phase:'completed',expectedPromptKey:'/c/idle-recovery-fixture|old-alias',lastCompletionKey:'old-completion',deadlineAt:1};
 const oldRequest={sequence:98,kind:'request.started',tabId:7,sourceUrl:url,requestId:'old-request',eventAt:500000,operationId:automatic?'old-operation':null};
 const bound:any=automatic?{sequence:99,kind:'goal.confirmed',tabId:7,sourceUrl:url,goalId:goal.id,operationId:'old-operation'}:
  {sequence:99,kind:'goal.manual_started',tabId:7,sourceUrl:url,goalId:goal.id,requestId:'old-request',startedAt:500000,userId:'old-native-user'};
 const complete={sequence:100,kind:'goal.answer_complete',sourceUrl:url,goalId:goal.id,completionKey:goal.lastCompletionKey,nativeVerified:true,exactMarker:true};
 if(automatic)goal.lastConfirmedOperation={id:'old-operation',tabId:7};
 else goal.manualStart={tabId:7,url,sourceUrl:url,requestId:'old-request',startedAt:500000,userId:'old-native-user'};
 return {...unbound,goal,savedReceipt:automatic?{requestId:'old-request',startedAt:500000,operationId:'old-operation',submittedUserId:'old-native-user',url:'',tabId:7}:undefined,
  mutate:({journal}:any)=>journal.events.unshift(oldRequest,bound,complete)};
}
for(const automatic of [false,true]) {
 const options=completedProof(automatic);assert.equal((await fixture(options)).result?.idle,true,'different native IDs and the exact completed Goal history permit a newer manual failed request');
 options.goal.expectedPromptKey='/c/idle-recovery-fixture|user';
 assert.equal((await fixture(options)).result?.idle,true,'equal rendered keys do not defeat independently proven distinct native users');
}
for(const scenario of ['same-user-alias','missing-receipt','wrong-operation','wrong-tab','wrong-time','wrong-request','missing-complete','duplicate-complete','missing-confirmed','gap','later-request','stale-initial-user']) {
 const options=completedProof();const setup=options.mutate;
 if(scenario==='same-user-alias'||scenario==='stale-initial-user')options.savedReceipt.submittedUserId='user';
 if(scenario==='stale-initial-user')options.goal.manualStart={userId:'different-initial-user'};
 if(scenario==='missing-receipt')options.savedReceipt=null;
 if(scenario==='wrong-operation')options.savedReceipt.operationId='different';
 if(scenario==='wrong-tab')options.savedReceipt.tabId=8;
 if(scenario==='wrong-time')options.savedReceipt.startedAt++;
 if(scenario==='wrong-request')options.savedReceipt.requestId='other';
 options.mutate=(x:any)=>{setup(x);const rows=x.journal.events;
  if(scenario==='missing-complete')rows[2].kind='other';
  if(scenario==='duplicate-complete')rows.unshift({...rows[2]});
  if(scenario==='missing-confirmed')rows[1].kind='other';
  if(scenario==='gap')rows.splice(1,1);
  if(scenario==='later-request'){rows.push({sequence:104,kind:'request.started',tabId:8,sourceUrl:url});x.journal.meta.sequence=104;}
 };
 assert.equal((await fixture(options)).result,null,'completed successor proof rejects '+scenario);
}
{
 const options=completedProof(false),setup=options.mutate;
 options.goal.manualStart.userId='user';options.mutate=(x:any)=>{setup(x);x.journal.events[1].userId='user';};
 assert.equal((await fixture(options)).result,null,'same initial native user with different aliases remains terminal');
}
{
 const options=completedProof();options.onProbe=()=>{options.savedReceipt.submittedUserId='user';};
 assert.equal((await fixture(options)).result,null,'historical receipt identity is rechecked after native probes');
}

{
 const recoveryBinding={kind:'user',url,entryId:'native-entry',userId:'user'};
 const voice={ok:true,idle:true,stopped:false,proof:'native-voice-idle',recoveryBinding};
 const options={...unbound,message:{recoveryBinding},surfaceProof:voice,freshSurface:voice};
 assert.equal((await fixture(options)).result?.idle,true,'matching positive native Voice idle needs no extra needsIdleProof flag');
 for(const patch of [{recoveryBinding:{...recoveryBinding,userId:'other'}},{recoveryBinding:{...recoveryBinding,entryId:'other'}},
  {ok:false},{idle:false},{stopped:true},{proof:'other'}])
  assert.equal((await fixture({...options,freshSurface:{...voice,...patch}})).result,null,'only exact positive native Voice idle is accepted');
}
{
 let appended=false;const options={...unbound,onProbe:({journal}:any)=>{if(!appended){appended=true;journal.events.push({sequence:104,kind:'draft.saved',tabId:8,sourceUrl:'https://chatgpt.com/c/another-fixture',operationId:'unrelated'});journal.meta.sequence=104;}}};
 const result=(await fixture(options)).result;assert.equal(result?.idle,true,'unrelated durable appends do not change the failed request proof');
 assert.equal(result.requestProof.expectedSequence,104,'the returned commit fence uses the fully revalidated final journal head');
}

{
 const options=completedProof();let appended=false;
 options.onProbe=({journal}:any)=>{if(!appended){appended=true;journal.events.push({sequence:104,kind:'request.started',tabId:8,sourceUrl:'https://chatgpt.com/c/another-fixture',requestId:'unrelated',eventAt:1000200});journal.meta.sequence=104;}};
 const result=(await fixture(options)).result;assert.equal(result?.idle,true,'unrelated append also preserves the completed-user identity proof');
 assert.equal(result.requestProof.expectedSequence,104);
}

for(const urls of [{sourceUrl:'https://chatgpt.com/',observedTabUrl:'https://chatgpt.com/'},{sourceUrl:'',observedTabUrl:''},{sourceUrl:url+'?model=pro',observedTabUrl:'https://chatgpt.com/c/another-fixture'}]) {
 let appended=false;
 assert.equal((await fixture({...unbound,onProbe:({journal}:any)=>{if(!appended){appended=true;journal.events.push({sequence:104,kind:'request.started',tabId:8,requestId:'unknown',...urls});journal.meta.sequence=104;}}})).result,null,
  'unknown-source cross-tab request may belong to the current chat and is never unrelated growth');
}
