import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
type V=Record<string,any>;
const url='https://chatgpt.com/c/missing-input-fixture',prefix='/c/missing-input-fixture|';
const worker=readFileSync('extension/service-worker.js','utf8'),helper=worker.slice(worker.indexOf('async function restoreMissingComposerGoal('),worker.indexOf('async function bindNativeComposerGoal('));
async function fixture(witness=false){
 const data:V={},journal:V[]=[],dispatched:V[]=[];let failFinal=false,live=url,clock=1000,after:(()=>void)|null=null;
 const users=[{userId:'follow-1',userText:'First sent clarification',userSentAtMs:20000,promptKey:prefix+'first'},
  {userId:'follow-2',userText:'Second sent clarification',userSentAtMs:40000,promptKey:prefix+'second'}];
 const native:V={ok:true,url,isLatest:true,isReadOnly:false,...users[1],firstServerMessageId:'server-alias',firstTurnMessageIds:['original-native-user'],firstTurnResponseConfirmed:true,
  turnStatus:'in_progress',generating:true,hasError:false};
 const history:V={...native,recoveryTimeline:users};
 const events:V[]=[{kind:'request.started',tabId:7,sourceUrl:'https://chatgpt.com/',requestId:'root-request',eventAt:1100},
  {kind:'tab.updated',tabId:7,sourceUrl:url,changes:{url},recordedAt:1200},
  ...users.map((u,i)=>({kind:'request.started',tabId:7,sourceUrl:url,requestId:'follow-request-'+i,eventAt:u.userSentAtMs}))];
 events.forEach((e,i)=>{e.sequence=i+1;});
 const ctx=createContext({URL,Date,console,readJournal:async()=>({ok:true,meta:{sequence:events.length},events:structuredClone(events)}),inspectCompletedTurn:function(){},
  handoffKey:()=> 'handoff:7',handoffWrites:new Map(),appendJournal:async(e:V)=>{journal.push(e);return {ok:true};},handleHandoffMessage:async(m:V)=>{assert.equal(m.id,'handoff-id','accepted automatic handoff must reconcile its exact operation');return {confirmed:true};},
  chrome:{storage:{local:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>{if(failFinal&&v['handoff:7']?.successorGoalBoundAt){failFinal=false;throw Error('Simulated worker stop before final marker');}return Object.assign(data,structuredClone(v));}}},tabs:{get:async()=>({id:7,url:live}),sendMessage:async()=>({ok:true})},scripting:{executeScript:async({args}:V)=>{const result=structuredClone(args.length>2?history:native);after?.();return [{result}];}}}});
 for(const file of ['goal-policy.js','goal-lineage.js','goal-store.js'])runInContext(readFileSync('extension/'+file,'utf8'),ctx);
 ctx.deps={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))},
  tabs:{get:async()=>({id:7,url:live}),sendMessage:async(id:number,m:V)=>{dispatched.push(m);return {ok:true};}},
  appendJournal:async(e:V)=>{journal.push(e);return {ok:true};},now:()=>clock,uuid:()=> 'root-arm'};
 const store=runInContext('ChatGPTGoalStore.create(deps)',ctx);ctx.goalController=store;
 await store.composerArm({tabId:7,url:'https://chatgpt.com/',rules:'Original criteria',maxContinuations:10,maxMinutes:1440});
 await store.composerIntent({tabId:7,url:'https://chatgpt.com/',armId:'root-arm',eventAt:1000,text:'Exact original objective',baselineKey:''});
 await store.composerRequest({tabId:7,armId:'root-arm',requestId:'root-request',startedAt:1100,url:'https://chatgpt.com/',
  ...(witness?{submission:{userId:'original-native-user',userText:'Exact original objective'}}:{})});
 clock=50000;runInContext(helper,ctx);
 return {data,events,journal,dispatched,native,history,store,users,failFinalOnce:()=>{failFinal=true;},time:(v:number)=>{clock=v;},after:(fn:()=>void)=>{after=fn;},route:(v:string)=>{live=v;},
  successor:(confirmed=false)=>runInContext(`recoverHandoffSuccessor(7,'${url}',${confirmed})`,ctx),recover:(confirmed=false)=>runInContext(`restoreMissingComposerGoal(7,'${url}','root-arm',${confirmed})`,ctx)};
}
{
 const f=await fixture();assert.equal((await f.recover()).pending,true);assert.equal(f.data['chatgpt-goal:'+url],undefined,'legacy intent alone grants no automatic recovery');
 const r=await f.recover(true),g=f.data['chatgpt-goal:'+url];assert.equal(r.ok,true);assert.equal(g.phase,'waiting');
 assert.equal(g.goal,'Exact original objective');assert.equal(g.rules,'Original criteria');assert.equal(g.startedAt,1100);
 assert.equal(g.deadlineAt,1100+1440*60000);assert.equal(g.continuations,0);assert.equal(g.maxContinuations,10);
 assert.deepEqual(g.supplements.map((x:V)=>x.userText),f.users.map(x=>x.userText));assert.equal(g.expectedPromptKey,prefix+'second');
 assert.equal(g.restoredIntent.confirmation,'explicit-user');assert.equal(f.dispatched.length,0,'active response is observed, not interrupted or duplicated');
 await f.recover(true);assert.equal(f.journal.filter(e=>e.kind==='goal.composer_restored').length,1,'a consumed arm cannot restore twice');
}
{
 const f=await fixture(true);assert.equal((await f.recover()).ok,true);assert.equal(f.data['chatgpt-goal:'+url].restoredIntent.confirmation,'request-body');
}
for(const marker of [false,true]){
 const f=await fixture();Object.assign(f.native,{turnStatus:'complete',generating:false,assistantCompleted:true,assistantPhase:'final_answer',
  assistantKey:'final-answer',goalResponse:marker?'GOAL_COMPLETE':'Work remains',goalRawExact:marker});
 await f.recover(true);assert.equal(f.data['chatgpt-goal:'+url].phase,marker?'completed':'preparing');
 assert.equal(f.dispatched.length,marker?0:1,'only one normal guarded continuation, never replay the original send');
 if(!marker)assert.match(f.dispatched[0].text,/Exact original objective/);
}
for(const scenario of ['wrong-allocation','ambiguous-root','unknown-followup','missing-followup','missing-history','server-id','route-race','disarm-race','different-current-user']){
 const f=await fixture(true);
 if(scenario==='wrong-allocation')f.events[1].changes.url='https://chatgpt.com/c/other';
 if(scenario==='ambiguous-root')f.events.push({...f.events[0]});
 if(scenario==='unknown-followup')f.events[2].operationId='unknown-send';
 if(scenario==='missing-followup')f.events.pop();
 if(scenario==='missing-history')f.history.recoveryTimeline=null;
 if(scenario==='server-id')f.native.firstTurnMessageIds=['different-user'];
 if(scenario==='route-race')f.route('https://chatgpt.com/c/other');
 if(scenario==='disarm-race')f.after(()=>{f.data['chatgpt-goal-composer:7'].phase='disabled';});
 if(scenario==='different-current-user')f.native.userId='new-user';
 assert.equal((await f.recover()).pending,true,scenario);assert.equal(f.data['chatgpt-goal:'+url],undefined,scenario);assert.equal(f.dispatched.length,0);
}
{
 const f=await fixture();f.time(1100+1440*60000+1);await f.recover(true);assert.equal(f.data['chatgpt-goal:'+url].phase,'stopped');
 assert.equal(f.dispatched.length,0,'explicit recovery preserves the original expired deadline');
}
console.log('Missing first Goal input: explicit legacy recovery or exact body/server-ID witness, original objective/limits/follow-ups, no original replay, marker and race fences passed.');

// A restored objective follows observed operation-bound allocations, preserving
// later manual instructions. A confirmed manual successor retires the old
// uncertain grant without accepting or replaying that historical payload.
function transfer(f:any,stage='awaiting-confirmation') {
 const source='https://chatgpt.com/c/source-fixture';f.events[1].changes.url=source;f.events[1].sourceUrl=source;
 f.events.splice(2,0,{kind:'handoff.navigating',tabId:7,sourceUrl:source,operationId:'handoff-id',recordedAt:2000},
  {kind:'request.started',tabId:7,sourceUrl:'https://chatgpt.com/',requestId:'handoff-request',eventAt:3000,operationId:'handoff-id'},
  {kind:'tab.updated',tabId:7,changes:{url},operationId:'handoff-id',recordedAt:3100});
 f.events.forEach((e:V,i:number)=>e.sequence=i+1);
 f.data['handoff:7']={id:'handoff-id',stage,sourceUrl:source,targetUrl:stage==='sent'?url:'https://chatgpt.com/',...(stage==='sent'?{acceptance:{messageId:'accepted-handoff-user',targetUrl:url}}:{}),text:'Retained recovery copy',draft:'Retained private draft',sendReceipt:{operationId:'handoff-id',clickedAt:2900}};
 return source;
}
{
 const f=await fixture(),source=transfer(f);assert.equal((await f.recover()).pending,true,'legacy consent still needs explicit restore');
 assert.equal((await f.recover(true)).ok,true);const g=f.data['chatgpt-goal:'+url],h=f.data['handoff:7'];
 assert.equal(g.goal,'Exact original objective');assert.equal(g.originUrl,source);assert.equal(g.deadlineAt,1100+1440*60000);assert.equal(g.maxContinuations,10);
 assert.equal(g.supplements.length,2);assert.equal(h.stage,'superseded');assert.equal(h.draft,'Retained private draft');assert.equal(h.text,'Retained recovery copy');
 assert.equal(f.data['chatgpt-handoff-archive:handoff-id'].draft,'Retained private draft','unknown draft retained independently before another transfer');assert.equal(h.acceptance,undefined,'supersession does not invent native acceptance');assert.equal(f.dispatched.length,0,'active answer not interrupted');
 assert.equal(f.journal.filter(e=>e.kind==='handoff.superseded').length,1);
}
{
 const f=await fixture(true);const origin=transfer(f,'sent');
 await f.store.composerObserveOrigin({tabId:7,armId:'root-arm',url:origin,requestId:'root-request',startedAt:1100,userId:'original-native-user',userText:'Exact original objective',userSentAtMs:1100,firstMessageVerified:true,nativeVerified:true});
 assert.equal((await f.recover()).ok,true,'captured original request plus native origin authorizes accepted lineage recovery');
 assert.equal(f.data['chatgpt-goal:'+url].restoredIntent.confirmation,'request-body');
}
for(const broken of ['foreign-source','wrong-operation','missing-request','manual-request','wrong-receipt','source-goal']) {
 const f=await fixture(true),source=transfer(f);
 if(broken==='foreign-source')f.events[2].sourceUrl='https://chatgpt.com/c/unrelated';
 if(broken==='wrong-operation')f.events[4].operationId='different';
 if(broken==='missing-request')f.events.splice(3,1);
 if(broken==='manual-request')f.events[3].operationId=null;
 if(broken==='wrong-receipt')f.data['handoff:7'].sendReceipt.operationId='different';
 if(broken==='source-goal')f.data['chatgpt-goal:'+source]={phase:'handoff',id:'another-goal'};
 f.events.forEach((e:V,i:number)=>e.sequence=i+1);
 assert.equal((await f.recover()).pending,true,broken);assert.equal(f.data['chatgpt-goal:'+url],undefined);assert.equal(f.dispatched.length,0);
}
console.log('Goal restoration across handoff: exact operation lineage, explicit legacy/exact-body consent, original budgets, manual successor supersession and unknown-send fences passed.');
{
 const f=await fixture(true);const origin=transfer(f,'sent');
 await f.store.composerObserveOrigin({tabId:7,armId:'root-arm',url:origin,requestId:'root-request',startedAt:1100,userId:'original-native-user',userText:'Exact original objective',userSentAtMs:1100,firstMessageVerified:true,nativeVerified:true});
 f.events.splice(5);f.events.push({kind:'send.dispatched',tabId:7,operationId:'handoff-id',sourceUrl:'https://chatgpt.com/',text:'Exact submitted handoff payload'});
 f.events.forEach((e:V,i:number)=>e.sequence=i+1);
 const u={userId:'accepted-handoff-user',userText:'Exact submitted handoff payload',userSentAtMs:3000,promptKey:prefix+'handoff-user'};
 Object.assign(f.native,u,{firstTurnMessageIds:['accepted-handoff-user']});Object.assign(f.history,u,{recoveryTimeline:[u]});
 assert.equal((await f.recover()).ok,true,'an already accepted handoff can restore before any additional manual message');
 const g=f.data['chatgpt-goal:'+url];assert.equal(g.expectedPromptKey,u.promptKey);assert.equal(g.restoredAnchor.operationId,'handoff-id');
 assert.equal(g.supplements.length,0,'automatic handoff payload is not relabeled as a user clarification');assert.equal(f.dispatched.length,0);
}

{const f=await fixture(true);transfer(f,'sent');assert.equal((await f.recover()).pending,true,'request body plus arbitrary first URL is not native origin proof');}

{
 const f=await fixture(),source=transfer(f);const old={schema:1,id:'carried-goal',url:source,originUrl:source,phase:'handoff',handoffId:'handoff-id',preHandoffPhase:'waiting',goal:'Carried original objective',rules:'Original rules',startedAt:1000,manualStartedAt:1100,deadlineAt:86401000,maxContinuations:7,maxMinutes:1440,continuations:3,operation:null,supplements:[{userId:'prior-source',requestId:'prior-request',text:'Keep prior source clarification'}]};
 f.data['chatgpt-goal:'+source]=structuredClone(old);
 assert.equal((await f.successor()).ok,false,'content cannot self-authorize an uncertain predecessor');
 assert.equal((await f.successor(true)).ok,true,'fresh owner-confirmed recovery carries the exact old Goal');
 const g=f.data['chatgpt-goal:'+url];assert.equal(g.id,old.id);assert.equal(g.goal,old.goal);assert.equal(g.deadlineAt,old.deadlineAt);assert.equal(g.continuations,3);assert.equal(g.maxContinuations,7);
 assert.deepEqual(g.supplements.map((s:V)=>s.text),['Keep prior source clarification',...f.users.map(s=>s.userText)]);
 assert.equal(g.expectedPromptKey,f.users.at(-1)!.promptKey);assert.equal(g.handoffPending,false);assert.equal(f.data['chatgpt-goal:'+source].phase,'moved');assert.equal(f.dispatched.length,0);
 assert.equal((await f.successor(true)).ok,true,'replayed successor observation does not duplicate supplements');assert.equal(f.data['chatgpt-goal:'+url].supplements.length,3);
}

{
 const f=await fixture(true),origin=transfer(f,'sent');
 assert.equal((await f.store.composerObserveOrigin({tabId:7,armId:'root-arm',url:origin,requestId:'root-request',startedAt:1100,userId:'foreign-user',userText:'Exact original objective',userSentAtMs:1100,firstMessageVerified:true,nativeVerified:true})).ok,false);
 await f.store.composerObserveOrigin({tabId:7,armId:'root-arm',url:origin,requestId:'root-request',startedAt:1100,userId:'original-native-user',userText:'Exact original objective',userSentAtMs:1100,firstMessageVerified:true,nativeVerified:true});
 const sent={tabId:7,url:origin,requestId:'prior-source-request',startedAt:1500,submission:{userId:'prior-source-user',userText:'Keep this earlier source instruction'}};
 assert.equal((await f.store.composerFollowup(sent)).ok,true);assert.equal((await f.store.composerFollowup(sent)).ok,true);
 f.events.splice(2,0,{kind:'request.started',tabId:7,sourceUrl:origin,requestId:sent.requestId,eventAt:1500});f.events.forEach((e:V,i:number)=>e.sequence=i+1);
 assert.equal((await f.recover()).ok,true);const g=f.data['chatgpt-goal:'+url];assert.equal(g.supplements[0].text,sent.submission.userText);assert.equal(g.supplements.length,3);
}
{
 const f=await fixture(true),origin=transfer(f,'sent');await f.store.composerObserveOrigin({tabId:7,armId:'root-arm',url:origin,requestId:'root-request',startedAt:1100,userId:'original-native-user',userText:'Exact original objective',userSentAtMs:1100,firstMessageVerified:true,nativeVerified:true});
 f.events.splice(2,0,{kind:'request.started',tabId:7,sourceUrl:origin,requestId:'unknown-prior-source',eventAt:1500});f.events.forEach((e:V,i:number)=>e.sequence=i+1);
 assert.equal((await f.recover()).pending,true,'automatic restore cannot silently drop an unverified source clarification');
}

{
 const f=await fixture(),source=transfer(f);f.data['chatgpt-goal:'+source]={schema:1,id:'crash-carried-goal',url:source,originUrl:source,phase:'handoff',handoffId:'handoff-id',preHandoffPhase:'waiting',goal:'Keep objective across worker stop',rules:'',startedAt:1000,manualStartedAt:1100,deadlineAt:86401000,maxContinuations:7,maxMinutes:1440,continuations:3,operation:null,supplements:[]};
 f.failFinalOnce();await assert.rejects(()=>f.successor(true),/Simulated worker stop/);
 assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2);const original=structuredClone(f.data['chatgpt-handoff-archive:handoff-id']);assert.equal(original.stage,'awaiting-confirmation');
 assert.equal((await f.successor(true)).ok,true);assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2,'exact persisted supplements are not duplicated or reordered');
 assert.deepEqual(f.data['chatgpt-handoff-archive:handoff-id'],original,'original unknown-send snapshot stays immutable');assert.equal(f.dispatched.length,0);
}
