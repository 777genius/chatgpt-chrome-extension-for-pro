import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

// The coordinator and policy are the actual classic scripts loaded by Chrome.
const require=createRequire(import.meta.url);
const policy:any=require('../extension/goal-policy.js');
const {create}:any=require('../extension/goal-store.js');

const URL_A='https://chatgpt.com/c/goal-fixture-a';
const URL_B='https://chatgpt.com/c/goal-fixture-b';
let sequence=0;
type Env={data:Record<string,any>;messages:{tabId:number,message:any}[];events:any[];
  tabs:Record<number,string>;time:number;store:any;fresh:()=>any;failWrite:boolean;busy:boolean};
function fixture():Env {
  const env:Env={data:{},messages:[],events:[],tabs:{7:URL_A,8:URL_A},time:1000000,store:null,
    fresh:()=>null,failWrite:false,busy:false};
  const storage={
    async get(key:string){return {[key]:structuredClone(env.data[key])};},
    async set(value:Record<string,unknown>){
      if(env.failWrite)throw Error('Synthetic storage failure');
      Object.assign(env.data,structuredClone(value));
    }
  };
  const tabs={
    async get(tabId:number){return {id:tabId,url:env.tabs[tabId]};},
    async sendMessage(tabId:number,message:any){
      if(message?.type==='CHATGPT_GOAL_READINESS')return {ok:true,idle:!env.busy,reason:'Synthetic manual response is active'};
      env.messages.push({tabId,message});return {ok:true};
    }
  };
  const journal=async(event:any)=>{env.events.push(structuredClone(event));return {ok:true};};
  env.fresh=()=>create({storage,tabs,appendJournal:journal,now:()=>env.time,
    uuid:()=>`fixture-operation-${++sequence}`});
  env.store=env.fresh();
  return env;
}
const key=(url:string)=>'chatgpt-goal:'+url;
const state=(env:Env,url=URL_A)=>env.data[key(url)];
async function begin(env:Env) {
  const response=await env.store.start({url:URL_A,tabId:7,goal:'Complete review, CI and merge',
    rules:'All changes must actually be merged',maxContinuations:2,maxMinutes:60});
  assert.equal(response.ok,true);
  assert.equal(env.messages.length,1);
  assert.match(env.messages[0].message.text,/GOAL_COMPLETE/);
  return state(env);
}
async function confirm(env:Env,promptKey='/c/goal-fixture-a|user-1',url=URL_A) {
  const record=state(env,url),op=record.operation;
  assert.ok(op,'one reserved operation');
  assert.equal((await env.store.check({url,tabId:op.tabId,id:record.id,operationId:op.id})).ok,true);
  assert.equal((await env.store.check({url,tabId:8,id:record.id,operationId:op.id})).ok,false);
  await env.store.intent({url,tabId:op.tabId,id:record.id,operationId:op.id,text:op.text,
    baselineKey:'/c/goal-fixture-a|old-user'});
  assert.equal((await env.store.authorize({url,tabId:op.tabId,id:record.id,operationId:op.id,text:op.text})).ok,true);
  await assert.rejects(()=>env.store.intent({url,tabId:op.tabId,id:record.id,operationId:op.id,text:op.text}),/разрешённой/);
  await env.store.report({url,tabId:op.tabId,id:record.id,operationId:op.id,status:'clicked'});
  await env.store.report({url,tabId:op.tabId,id:record.id,operationId:op.id,status:'confirmed',newPromptKey:promptKey});
  assert.equal(state(env,url).expectedPromptKey,promptKey);
  assert.equal(state(env,url).phase,'waiting');
}
const answer=(env:Env,values:Record<string,unknown>={})=>{
  const record=state(env),promptKey=record.expectedPromptKey;
  return env.store.completion({url:URL_A,tabId:7,completionKey:promptKey+'|assistant-1',
    promptKey,response:'Still working',nativeVerified:true,rawExact:false,...values});
};

assert.equal(policy.exactMarker('GOAL_COMPLETE',true,true),true);
for(const value of [' GOAL_COMPLETE','GOAL_COMPLETE ','GOAL_COMPLETE\nDone','`GOAL_COMPLETE`','Done GOAL_COMPLETE'])
  assert.equal(policy.exactMarker(value,true,true),false);
assert.equal(policy.exactMarker('GOAL_COMPLETE',false,true),false);
assert.equal(policy.exactMarker('GOAL_COMPLETE',true,false),false);
assert.equal(policy.canonical('https://chatgpt.com/c/goal-fixture-a/'),URL_A);
assert.equal(policy.canonical('https://evil.example/c/goal-fixture-a'),'');
assert.throws(()=>policy.settings({goal:'',maxContinuations:20,maxMinutes:90}));
assert.throws(()=>policy.settings({goal:'x',maxContinuations:0,maxMinutes:90}));
assert.throws(()=>policy.settings({goal:'x',maxContinuations:1,maxMinutes:Infinity}));

// Initial goal persisted before dispatch; restart never creates a second click.
{
  const env=fixture(),record=await begin(env);
  assert.equal(record.phase,'preparing');
  assert.equal((await env.fresh().get(URL_A))?.goal,record.goal);
  await assert.rejects(()=>env.store.start({url:URL_A,tabId:8,goal:'duplicate',rules:'',
    maxContinuations:2,maxMinutes:60}),/(не подтверждена|уже запущена)/);
  assert.equal(env.messages.length,1);
  await confirm(env);
  assert.equal(state(env).continuations,0);
  const done=await answer(env,{response:'GOAL_COMPLETE',rawExact:true});
  assert.equal(done.ok,true);
  assert.equal(state(env).phase,'completed');
  assert.equal(env.messages.length,1,'exact final answer sends no continuation');
  assert.equal((await answer(env,{response:'GOAL_COMPLETE',rawExact:true})).ok,false);
}

// Partial marker, Markdown marker and unverified transport may not stop.
{
  const env=fixture();await begin(env);await confirm(env);
  await answer(env,{response:'GOAL_COMPLETE is the marker',rawExact:false});
  assert.equal(state(env).phase,'preparing');
  assert.equal(env.messages.length,2);
  await Promise.all([answer(env),answer(env)]);
  assert.equal(env.messages.length,2,'duplicate completion cannot cause another click');
  await confirm(env,'/c/goal-fixture-a|user-2');
  assert.equal(state(env).continuations,1);
  await env.store.completion({url:URL_A,tabId:7,completionKey:'/c/goal-fixture-a|user-2|assistant-2',
    promptKey:'/c/goal-fixture-a|user-2',response:'GOAL_COMPLETE',nativeVerified:true,rawExact:false});
  assert.equal(state(env).phase,'preparing','formatted/partial marker is not exact');
  assert.equal(env.messages.length,3);
  await confirm(env,'/c/goal-fixture-a|user-3');
  assert.equal(state(env).continuations,2);
  await env.store.completion({url:URL_A,tabId:7,completionKey:'/c/goal-fixture-a|user-3|assistant-3',
    promptKey:'/c/goal-fixture-a|user-3',response:'Still not done',nativeVerified:true,rawExact:false});
  assert.equal(state(env).phase,'stopped','finite continuation budget');
  assert.equal(env.messages.length,3);
}
{
  const env=fixture();await begin(env);await confirm(env);
  await answer(env,{response:'GOAL_COMPLETE',rawExact:true,nativeVerified:false});
  assert.equal(state(env).phase,'blocked','transport fallback cannot complete Goal');
  assert.equal(env.messages.length,1);
}

// Two tabs delivering the same bound completion race through one durable claim.
{
  const env=fixture();await begin(env);await confirm(env);
  const result=await Promise.all([answer(env),env.store.completion({
    url:URL_A,tabId:8,completionKey:'/c/goal-fixture-a|user-1|assistant-1',
    promptKey:'/c/goal-fixture-a|user-1',response:'Still working',nativeVerified:true,rawExact:false})]);
  assert.equal(result.filter((item:any)=>item.ok).length,1);
  assert.equal(env.messages.length,2);
  assert.equal(state(env).operation.tabId===7||state(env).operation.tabId===8,true);
}

// Pause during response, preserve pending result, resume exactly once.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.control({action:'pause',url:URL_A,tabId:7});
  assert.equal(state(env).phase,'paused');
  await answer(env);
  assert.equal(env.messages.length,1);
  assert.ok(state(env).pendingCompletion);
  await env.store.control({action:'resume',url:URL_A,tabId:7});
  assert.equal(env.messages.length,2);
  assert.equal(state(env).phase,'preparing');
  await assert.rejects(()=>env.store.control({action:'resume',url:URL_A,tabId:7}),/Нельзя/);
}

// A user manual send after a Goal answer interrupts auto-continue, then an
// explicit resume requires an idle chat and creates a single continuation.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.manual({url:URL_A,tabId:7});
  assert.equal(state(env).phase,'paused');
  assert.equal(state(env).manualOverride,true);
  env.busy=true;
  await assert.rejects(()=>env.store.control({action:'resume',url:URL_A,tabId:7}),/Synthetic manual/);
  assert.equal(state(env).phase,'paused');
  env.busy=false;
  await env.store.control({action:'resume',url:URL_A,tabId:7});
  assert.equal(state(env).phase,'preparing');
  assert.equal(state(env).operation.kind,'continuation');
  assert.equal(env.messages.length,2);
}

// A fully completed assistant answer can race the native send acknowledgement.
// It is persisted against the same operation, then processed only after its
// exact new prompt is confirmed, without requiring a second completion event.
{
  const env=fixture();await begin(env);
  const rec=state(env),op=rec.operation;
  await env.store.intent({url:URL_A,tabId:7,id:rec.id,operationId:op.id,text:op.text,
    baselineKey:'/c/goal-fixture-a|previous'});
  const fast=await env.store.completion({url:URL_A,tabId:7,
    completionKey:'/c/goal-fixture-a|fast-user|fast-assistant',
    promptKey:'/c/goal-fixture-a|fast-user',response:'Still in progress',
    userId:'native-fast-user',nativeVerified:true,rawExact:false});
  assert.equal(fast.ok,true);
  assert.equal(state(env).phase,'sending','completion does not bypass send acknowledgement');
  assert.equal(env.messages.length,1);
  const duplicate=await env.store.completion({url:URL_A,tabId:7,
    completionKey:'/c/goal-fixture-a|fast-user|fast-assistant',
    promptKey:'/c/goal-fixture-a|fast-user',response:'Still in progress',
    userId:'native-fast-user',nativeVerified:true,rawExact:false});
  assert.equal(duplicate.ok,false);
  await env.store.report({url:URL_A,tabId:7,id:rec.id,operationId:op.id,
    status:'confirmed',newPromptKey:'/c/goal-fixture-a|fast-user'});
  assert.equal(state(env).phase,'preparing');
  assert.equal(env.messages.length,2,'saved fast completion schedules only one continuation');
  await env.store.recoverTab({id:7,url:URL_A});
  assert.equal(state(env).phase,'preparing','already consumed early result is not replayed');
}

// A restarted worker must not dispatch the same newly reserved continuation
// twice when it replays a completed answer left in durable waiting state.
{
  const env=fixture();await begin(env);await confirm(env);
  const promptKey=state(env).expectedPromptKey;
  state(env).earlyCompletion={url:URL_A,tabId:7,
    completionKey:promptKey+'|early-assistant',promptKey,response:'Continue',
    nativeVerified:true,rawExact:false,userId:'native-user'};
  const recovery=await env.fresh().recoverTab({id:7,url:URL_A});
  assert.equal(recovery.replayed,true);
  assert.equal(state(env).phase,'preparing');
  assert.equal(env.messages.length,2,'one replay creates exactly one dispatcher');
}

// Several final responses can race the same Goal send acknowledgement.
// Keep their identities separate and replay only the confirmed Goal prompt.
{
  const env=fixture();await begin(env);
  const current=state(env),op=current.operation;
  await env.store.intent({url:URL_A,tabId:7,id:current.id,operationId:op.id,text:op.text,
    baselineKey:'/c/goal-fixture-a|old'});
  const stage=(promptKey:string,userId:string,completionKey:string)=>
    env.store.completion({url:URL_A,tabId:7,promptKey,userId,completionKey,
      response:'Still working',nativeVerified:true,rawExact:false});
  assert.equal((await stage('/c/goal-fixture-a|manual-user','manual-native',
    '/c/goal-fixture-a|manual-user|assistant-1')).ok,true);
  assert.equal((await stage('/c/goal-fixture-a|goal-user','goal-native',
    '/c/goal-fixture-a|goal-user|assistant-2')).ok,true);
  assert.equal(state(env).earlyCompletions.length,2);
  await env.store.report({url:URL_A,tabId:7,id:current.id,operationId:op.id,
    status:'confirmed',newPromptKey:'/c/goal-fixture-a|goal-user'});
  assert.equal(state(env).phase,'preparing');
  assert.equal(env.messages.length,2,'only confirmed Goal prompt produces one continuation');
}

// The fast completion of the exact goal marker is also replayed, without
// dispatching a continuation before or after the send acknowledgement.
{
  const env=fixture();await begin(env);
  const rec=state(env),op=rec.operation;
  await env.store.intent({url:URL_A,tabId:7,id:rec.id,operationId:op.id,text:op.text});
  await env.store.completion({url:URL_A,tabId:7,
    completionKey:'/c/goal-fixture-a|fast-user|fast-assistant',
    promptKey:'/c/goal-fixture-a|fast-user',response:'GOAL_COMPLETE',userId:'fast-native-user',
    nativeVerified:true,rawExact:true});
  await env.store.report({url:URL_A,tabId:7,id:rec.id,operationId:op.id,
    status:'confirmed',newPromptKey:'/c/goal-fixture-a|fast-user'});
  assert.equal(state(env).phase,'completed');
  assert.equal(env.messages.length,1,'final marker never causes another send');
}

// Pause or stop after the send intent never clears the unknown-operation fence.
{
  const env=fixture();await begin(env);
  const record=state(env),op=record.operation;
  await env.store.intent({url:URL_A,tabId:7,id:record.id,operationId:op.id,text:op.text,
    baselineKey:'/c/goal-fixture-a|old-user'});
  await env.store.control({action:'pause',url:URL_A,tabId:7});
  await assert.rejects(()=>env.store.authorize({url:URL_A,tabId:7,id:record.id,operationId:op.id,text:op.text}),/не разрешена/);
  await env.store.report({url:URL_A,tabId:7,id:record.id,operationId:op.id,
    status:'blocked',reason:'Lost click acknowledgement'});
  assert.equal(state(env).phase,'blocked');
  assert.equal(env.messages.length,1);
  await assert.rejects(()=>env.store.control({action:'resume',url:URL_A,tabId:7}));
}

// Pausing a reserved (not yet clicked) send releases its claim. Resume gets
// a fresh ID and a queued old dispatcher cannot authorize itself.
{
  const env=fixture();await begin(env);
  const first=state(env).operation.id;
  await env.store.control({action:'pause',url:URL_A,tabId:7});
  assert.equal(state(env).phase,'paused');
  assert.equal(state(env).operation,null);
  assert.equal(state(env).pendingSendKind,'initial');
  assert.equal((await env.store.check({url:URL_A,tabId:7,id:state(env).id,operationId:first})).ok,false);
  await env.store.control({action:'resume',url:URL_A,tabId:7});
  assert.equal(state(env).phase,'preparing');
  assert.notEqual(state(env).operation.id,first);
  assert.equal(env.messages.length,2);
  assert.equal(state(env).operation.kind,'initial');
}

// Worker restart can safely redeliver only the SAME reserved operation. Once
// the intent is persisted, recovery must not re-authorize a possible click.
{
  const env=fixture();await begin(env);
  const op=state(env).operation;
  await env.fresh().recoverTab({id:8,url:URL_A});
  assert.equal(env.messages.length,1,'other tab cannot steal reserved dispatch');
  await env.fresh().recoverTab({id:7,url:URL_A});
  assert.equal(env.messages.length,2,'same reserved operation is re-delivered');
  assert.equal(env.messages[0].message.operationId,env.messages[1].message.operationId);
  await env.store.intent({url:URL_A,tabId:7,id:state(env).id,operationId:op.id,text:op.text});
  await env.fresh().recoverTab({id:7,url:URL_A});
  assert.equal(env.messages.length,2,'intent may have clicked, recovery cannot retry');
}
{
  const env=fixture();await begin(env);
  env.time+=3600001;
  await env.fresh().recoverTab({id:7,url:URL_A});
  assert.equal(state(env).phase,'stopped');
  assert.equal(state(env).operation,null);
  assert.equal(env.messages.length,1,'expired reserved send cannot recover');
}

// A trusted manual send in the preparation window must not strand Goal in
// paused-with-operation or allow stale content dispatch to click.
{
  const env=fixture();await begin(env);
  const first=state(env).operation.id;
  await env.store.manual({url:URL_A,tabId:7});
  assert.equal(state(env).phase,'paused');
  assert.equal(state(env).operation,null);
  await env.store.control({action:'resume',url:URL_A,tabId:7});
  assert.notEqual(state(env).operation.id,first);
  assert.equal(env.messages.length,2);
}

// A missing click acknowledgement is not proof of no click. Explicit Stop
// cannot silently give another automatic attempt a fresh operation grant.
{
  const env=fixture();await begin(env);
  const current=state(env),op=current.operation;
  await env.store.intent({url:URL_A,tabId:7,id:current.id,operationId:op.id,text:op.text});
  await env.store.control({action:'stop',url:URL_A,tabId:7});
  assert.equal(state(env).stopRequested,true);
  assert.equal(state(env).phase,'sending');
  assert.equal(env.events.at(-1)?.kind,'goal.stop_requested');
  await env.store.report({url:URL_A,tabId:7,id:current.id,operationId:op.id,
    status:'blocked',reason:'Synthetic lost acknowledgement'});
  assert.equal(state(env).phase,'blocked');
  await env.store.control({action:'stop',url:URL_A,tabId:7});
  await assert.rejects(()=>env.store.start({url:URL_A,tabId:7,goal:'unsafe reset',rules:'',
    maxContinuations:2,maxMinutes:60}),/не подтверждена/);
}

// On resume or viewing the popup after suspension, an unknown-click
// operation fails closed; an unclaimed reserved operation has separate safe recovery. No background re-dispatch happens.
{
  const env=fixture();await begin(env);
  const current=state(env),op=current.operation;
  await env.store.intent({url:URL_A,tabId:7,id:current.id,operationId:op.id,text:op.text});
  env.time+=120001;
  const recovered=await env.fresh().get(URL_A);
  assert.equal(recovered.phase,'blocked');
  assert.match(recovered.reason,/Неподтверждённая/);
  assert.equal(env.messages.length,1);
}

// Deadlines survive restart, never reset due to handoff.
{
  const env=fixture();await begin(env);await confirm(env);
  env.time+=3600001;
  await answer(env);
  assert.equal(state(env).phase,'stopped');
  assert.match(state(env).reason,/Время/);
  assert.equal(env.messages.length,1);
}

// Errors and native retry keep the expected prompt in sync; new chat handoff
// transfers the goal identity and budget only after confirmed acceptance.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.retry({url:URL_A,tabId:7,kind:'retry.planned'});
  assert.equal(state(env).phase,'recovering');
  await answer(env);
  assert.equal(env.messages.length,1,'no sending while retry underway');
  await env.store.retry({url:URL_A,tabId:7,kind:'retry.confirmed',promptKey:'/c/goal-fixture-a|retry-1'});
  assert.equal(state(env).phase,'waiting');
  assert.equal(state(env).expectedPromptKey,'/c/goal-fixture-a|retry-1');
  await env.store.retry({url:URL_A,tabId:7,kind:'retry.blocked',goalHandoff:true});
  assert.equal(state(env).phase,'waiting','chat-limit event is not terminal for Goal');
  const id=state(env).id,deadline=state(env).deadlineAt;
  await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'handoff-fixture',tabId:7});
  await env.fresh().handoffBegin({sourceUrl:URL_A,handoffId:'handoff-fixture',tabId:7});
  assert.equal(env.events.filter((event:any)=>event.kind==='goal.handoff_begin').length,1,
    'worker resume reuses the same durable handoff phase and operation');
  assert.equal(state(env).phase,'handoff');
  assert.match(await env.store.context(URL_A),/Активная цель/);
  await env.store.stageHandoffCompletion({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'handoff-fixture',tabId:7,
    completionKey:'/c/goal-fixture-b|handoff-user|handoff-answer',
    promptKey:'/c/goal-fixture-b|handoff-user',response:'Still working',
    userId:'unrelated-user',nativeVerified:true,rawExact:false});
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'handoff-fixture',tabId:7,acceptedUserId:'handoff-user-1'});
  assert.equal(state(env).phase,'moved');
  assert.equal(state(env,URL_B).id,id);
  assert.equal(state(env,URL_B).deadlineAt,deadline);
  assert.equal(state(env,URL_B).handoffPending,true);
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'handoff-fixture',tabId:7,acceptedUserId:'handoff-user-1'});
  assert.equal(state(env,URL_B).phase,'waiting');
  env.tabs[7]=URL_B;
  const unrelated=await env.store.completion({url:URL_B,tabId:7,
    completionKey:'/c/goal-fixture-b|manual-user|assistant-0',
    promptKey:'/c/goal-fixture-b|manual-user',response:'GOAL_COMPLETE',
    userId:'manual-user-id',nativeVerified:true,rawExact:true});
  assert.equal(unrelated.ok,false,'unrelated native final response cannot complete handoff Goal');
  assert.equal(state(env,URL_B).phase,'waiting');
  await env.store.completion({url:URL_B,tabId:7,completionKey:'/c/goal-fixture-b|user-1|assistant-1',
    promptKey:'/c/goal-fixture-b|user-1',response:'GOAL_COMPLETE',userId:'handoff-user-1',nativeVerified:true,rawExact:true});
  assert.equal(state(env,URL_B).phase,'completed');
  assert.equal(env.messages.length,1);
}

// A native-final response arriving before a handoff is confirmed is durable
// and accepted only when its userId matches the native accepted handoff turn.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'early-handoff',tabId:7});
  assert.equal((await env.store.stageHandoffCompletion({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'early-handoff',tabId:7,
    completionKey:'/c/goal-fixture-b|native-hand|native-answer',
    promptKey:'/c/goal-fixture-b|native-hand',response:'GOAL_COMPLETE',
    nativeVerified:true,rawExact:true,userId:'accepted-handoff-user'})).ok,true);
  assert.equal(state(env).phase,'handoff');
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'early-handoff',tabId:7,acceptedUserId:'accepted-handoff-user'});
  assert.equal(state(env,URL_B).phase,'completed','handoff completion is replayed at transfer');
  assert.equal(env.messages.length,1,'handoff marker does not create another send');
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'early-handoff',tabId:7,acceptedUserId:'accepted-handoff-user'});
  assert.equal(env.messages.length,1,'handoff replay is idempotent');
}

// A misleading unrelated destination answer must not evict the accepted
// native handoff answer if both finish before the durable transfer.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'multiple-destination',tabId:7});
  for(const [userId,response,key] of [
    ['unrelated-user','GOAL_COMPLETE','manual-final'],
    ['accepted-user','GOAL_COMPLETE','native-final']
  ]) {
    const result=await env.store.stageHandoffCompletion({sourceUrl:URL_A,targetUrl:URL_B,
      handoffId:'multiple-destination',tabId:7,
      completionKey:'/c/goal-fixture-b|'+key+'|assistant',promptKey:'/c/goal-fixture-b|'+key,
      response,userId,nativeVerified:true,rawExact:true});
    assert.equal(result.ok,true);
  }
  assert.equal(state(env).handoffEarlyCompletions.length,2);
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'multiple-destination',tabId:7,acceptedUserId:'accepted-user'});
  assert.equal(state(env,URL_B).phase,'completed');
  assert.equal(env.messages.length,1,'only matching handoff final result is accepted');
}

// Store errors are fail-closed and do not click.
{
  const env=fixture();
  env.failWrite=true;
  await assert.rejects(()=>begin(env),/Synthetic storage failure/);
  assert.equal(env.messages.length,0);
}

console.log('Goal policy, durable lifecycle, dedupe, marker, recovery and handoff checks passed.');
