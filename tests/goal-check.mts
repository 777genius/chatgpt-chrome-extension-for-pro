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
function fixture(beforeDispatch:(record:any)=>Promise<void>=async()=>{}):Env {
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
  env.fresh=()=>create({storage,tabs,appendJournal:journal,beforeDispatch,now:()=>env.time,
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

// A delayed older manual ACK must not cancel a reservation created after a
// newer verified manual request was paused and explicitly resumed.
{
  const env=fixture();await begin(env);await confirm(env);
  env.time+=20;
  assert.equal((await env.store.manual({url:URL_A,tabId:7,startedAt:env.time})).ok,true);
  await env.store.control({action:'resume',url:URL_A,tabId:7});
  const before=structuredClone(state(env)),messages=env.messages.length;
  assert.equal((await env.store.manual({url:URL_A,tabId:7,startedAt:env.time-10})).ok,false);
  assert.deepEqual(state(env),before,'older ACK preserves the newer reserved continuation and manual cutoff');
  assert.equal(env.messages.length,messages);
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

// A failed dispatch of an unclaimed reservation never wrote a send intent.
// Explicit Stop can release it; this is different from the unknown-click fence.
{
  const env=fixture();await begin(env);
  const rec=state(env),op=rec.operation;
  assert.equal(op.status,'reserved');
  await env.store.report({url:URL_A,tabId:7,id:rec.id,operationId:op.id,
    status:'blocked',reason:'Content script unavailable'});
  assert.equal(state(env).phase,'blocked');
  assert.equal(state(env).operation.status,'reserved');
  await env.store.control({action:'stop',url:URL_A,tabId:7});
  assert.equal(state(env).phase,'stopped');
  assert.equal(state(env).operation,null,'unclaimed dispatch is safe to release after Stop');
  const restarted=await env.store.start({url:URL_A,tabId:7,goal:'Explicitly restarted',
    rules:'',maxContinuations:1,maxMinutes:20});
  assert.equal(restarted.ok,true);
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

// A burst of unrelated destination answers cannot evict a saved accepted
// handoff answer. Native user IDs are the durable selector; no first/last-N
// truncation may silently change which answer completes Goal.
{
  const env=fixture();await begin(env);await confirm(env);
  await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'burst-handoff',tabId:7});
  const stage=async(userId:string,answer:string)=>env.store.stageHandoffCompletion({
    sourceUrl:URL_A,targetUrl:URL_B,handoffId:'burst-handoff',tabId:7,
    completionKey:'/c/goal-fixture-b|'+userId+'|assistant-1',
    promptKey:'/c/goal-fixture-b|'+userId,response:answer,userId,nativeVerified:true,rawExact:answer==='GOAL_COMPLETE'});
  assert.equal((await stage('accepted-first','GOAL_COMPLETE')).ok,true);
  for(let n=0;n<9;n++)assert.equal((await stage('unrelated-'+n,'Not complete')).ok,true);
  assert.equal(state(env).handoffEarlyCompletions.length,10);
  await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,
    handoffId:'burst-handoff',tabId:7,acceptedUserId:'accepted-first'});
  assert.equal(state(env,URL_B).phase,'completed');
  assert.equal(env.messages.length,1);
}

// Store errors are fail-closed and do not click.
{
  const env=fixture();
  env.failWrite=true;
  await assert.rejects(()=>begin(env),/Synthetic storage failure/);
  assert.equal(env.messages.length,0);
}

console.log('Goal policy, durable lifecycle, dedupe, marker, recovery and handoff checks passed.');

// Native rename preparation is a delivery barrier; stopping during it wins.
for(const stop of [false,true]) {
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const env=fixture(async record=>{assert.equal(record.operation.status,'reserved');entered();await gate;});
  const pending=env.store.start({url:URL_A,tabId:7,goal:'Barrier canary',rules:'',maxContinuations:2,maxMinutes:60});
  await started;assert.equal(env.messages.length,0,'no continuation may reach the composer while native title UI is preparing');
  if(stop)await env.store.control({url:URL_A,tabId:7,action:'stop'});
  release();await pending;
  assert.equal(env.messages.length,stop?0:1,'stop during title preparation cancels the exact reserved dispatch');
}

// A refusal mentioning the completion token is an ordinary answer, never a stop.
for(const response of ['Маркер `GOAL_COMPLETE` не выдаю.','Маркер GOAL_COMPLETE не выдаю.',
 'GOAL_COMPLETE не выдаю.','Не завершено: GOAL_COMPLETE','"GOAL_COMPLETE"']) {
 const env=fixture();await begin(env);await confirm(env);
 await answer(env,{response,rawExact:true});
 assert.equal(state(env).phase,'preparing','a quoted/negated token does not complete Goal');
 assert.equal(env.messages.length,2,'exactly one continuation is scheduled');
 assert.match(env.messages[1].message.text,/Всё сообщение должно состоять только из этой строки/);
 assert.doesNotMatch(env.messages[1].message.text,/«Итог:»|1–3 коротких пункта/);
 await confirm(env,'/c/goal-fixture-a|continued-user');
 await answer(env,{response:'GOAL_COMPLETE',rawExact:true});
 assert.equal(state(env).phase,'completed');
 assert.equal(env.messages.length,2,'standalone completion never schedules another continuation');
}

// A positively verified whole-answer blocker stops before limits or dispatch,
// survives coordinator recreation and cannot be replayed as a continuation.
assert.deepEqual(policy.DEFAULTS,{maxContinuations:30,maxMinutes:1440});
assert.match(policy.initialText({goal:'Test',rules:''}),/GOAL_BLOCKED/);
// A historical no-navigation block may be restored only after the worker has
// proven the same native turn completed; owner stop/pause always wins.
for(const variant of ['ok','stopped','paused','new-goal','pending','expired'] as const) {
 const env=fixture();await begin(env);await confirm(env);const g=state(env),goalId=g.id,oldPromptKey=g.expectedPromptKey;
 Object.assign(g,{phase:'blocked',handoffId:'saved-handoff',handoffTabId:7,preHandoffPhase:'waiting',
  reason:'Передача Goal остановлена: В исходном чате идёт генерация; переход отменён'});
 if(variant==='stopped')g.stopRequested=true;if(variant==='paused')g.pauseRequested=true;
 if(variant==='new-goal')g.id='replacement';if(variant==='pending')g.manualPending={id:'manual'};
 if(variant==='expired')env.time=g.deadlineAt;
 const outcome=await env.store.handoffSourceCompleted({sourceUrl:URL_A,handoffId:'saved-handoff',tabId:7,goalId,
  oldPromptKey,promptKey:'/c/goal-fixture-a|verified-user',userId:'verified-user'});
 assert.equal(outcome.ok,variant==='ok',variant);
 assert.equal(state(env).phase,variant==='ok'?'waiting':'blocked',variant);
 assert.equal(env.messages.length,1,'restoration itself never sends a message');
}
assert.match(policy.continuationText({goal:'Test'}),/штатные способы/);
assert.equal(policy.exactBlockedMarker('GOAL_BLOCKED',true,true),true);
for(const value of [' GOAL_BLOCKED','GOAL_BLOCKED ','`GOAL_BLOCKED`','GOAL_BLOCKED\nReason','Не выдаю GOAL_BLOCKED','GOAL_BLOCKED is the marker'])
 assert.equal(policy.exactBlockedMarker(value,true,true),false);
for(const [rawExact,nativeVerified] of [[false,true],[true,false]])
 assert.equal(policy.exactBlockedMarker('GOAL_BLOCKED',rawExact,nativeVerified),false);
{
 const env=fixture();await begin(env);await confirm(env);
 env.time=state(env).deadlineAt+1;
 const result=await answer(env,{response:'GOAL_BLOCKED',rawExact:true});
 assert.equal(result.ok,true);assert.equal(state(env).phase,'blocked');
 assert.match(state(env).reason,/GOAL_BLOCKED/);assert.equal(state(env).operation,null);
 assert.equal(env.messages.length,1,'blocked marker never dispatches another message');
 assert.equal((await env.fresh().get(URL_A)).phase,'blocked','block survives restart');
 assert.equal((await answer(env,{response:'GOAL_BLOCKED',rawExact:true})).ok,false);
 assert.equal(env.messages.length,1);
 assert.ok(env.events.some(e=>e.kind==='goal.answer_blocked'));
}
for(const response of ['Маркер `GOAL_BLOCKED` не выдаю.','GOAL_BLOCKED не выдаю.','"GOAL_BLOCKED"']) {
 const env=fixture();await begin(env);await confirm(env);
 await answer(env,{response,rawExact:false});
 assert.equal(state(env).phase,'preparing','discussion of blocked marker is ordinary progress');
 assert.equal(env.messages.length,2);
}
console.log('GOAL_BLOCKED: exact verified stop, restart, duplicate refusal and finite defaults passed');

// A blocker can arrive before handoff acceptance. Compact proof must retain
// that exact terminal response, select the accepted user and never continue.
{
 const env=fixture();await begin(env);await confirm(env);
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'early-blocked',tabId:7});
 for(const [userId,response,rawExact] of [['unrelated','GOAL_COMPLETE',true],['accepted','GOAL_BLOCKED',true],['quoted','GOAL_BLOCKED',false]]) {
  assert.equal((await env.store.stageHandoffCompletion({sourceUrl:URL_A,targetUrl:URL_B,
   handoffId:'early-blocked',tabId:7,userId,response,rawExact,nativeVerified:true,
   promptKey:'/c/goal-fixture-b|'+userId,completionKey:'/c/goal-fixture-b|'+userId+'|assistant'})).ok,true);
 }
 assert.equal(state(env).handoffEarlyCompletions.find((x:any)=>x.userId==='accepted').response,'GOAL_BLOCKED');
 assert.equal(state(env).handoffEarlyCompletions.find((x:any)=>x.userId==='quoted').response,'');
 await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'early-blocked',tabId:7,acceptedUserId:'accepted'});
 assert.equal(state(env,URL_B).phase,'blocked');assert.match(state(env,URL_B).reason,/GOAL_BLOCKED/);
 assert.equal(env.messages.length,1,'early blocker cannot be replaced with an empty response and continued');
 await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'early-blocked',tabId:7,acceptedUserId:'accepted'});
 assert.equal(env.messages.length,1);
}

// Native terminal source can settle before its rendered plain paragraph. Hold
// that exact answer without consuming its completion or sending a continuation.
for(const marker of ['GOAL_COMPLETE','GOAL_BLOCKED']) {
 const env=fixture();await begin(env);await confirm(env);
 const before=structuredClone(state(env));
 const held=await answer(env,{response:marker,rawExact:false,nativeMarkerPending:true,userId:'same-user'});
 assert.equal(held.ok,false);assert.equal(held.pendingMarker,true);
 assert.equal(state(env).phase,'waiting');assert.equal(state(env).lastCompletionKey,before.lastCompletionKey);
 assert.equal(state(env).continuations,before.continuations);assert.equal(env.messages.length,1);
 assert.equal(state(env).markerPending.promptKey,before.expectedPromptKey);
 assert.equal((await env.fresh().get(URL_A)).markerPending.completionKey,state(env).markerPending.completionKey);
 await answer(env,{response:marker,rawExact:true,nativeMarkerPending:false,userId:'same-user'});
 assert.equal(state(env).phase,marker==='GOAL_COMPLETE'?'completed':'blocked');
 assert.equal(state(env).markerPending,null);assert.equal(env.messages.length,1);
}
{
 const env=fixture();await begin(env);await confirm(env);
 await env.store.control({url:URL_A,tabId:7,action:'pause'});
 await answer(env,{response:'GOAL_COMPLETE',rawExact:false,nativeMarkerPending:true});
 assert.equal(state(env).phase,'paused');assert.equal(env.messages.length,1);
 await env.store.control({url:URL_A,tabId:7,action:'stop'});
 assert.equal((await answer(env,{response:'GOAL_COMPLETE',rawExact:true})).ok,false);
 assert.equal(state(env).phase,'stopped');assert.equal(env.messages.length,1);
}
// A definitive formatted/ordinary settled body can replace the candidate and
// continue normally; merely mentioning the marker never enters pending state.
{
 const env=fixture();await begin(env);await confirm(env);
 await answer(env,{response:'GOAL_COMPLETE',rawExact:false,nativeMarkerPending:true});
 await answer(env,{response:'`GOAL_COMPLETE`',rawExact:false,nativeMarkerPending:false});
 assert.equal(state(env).phase,'preparing');assert.equal(state(env).markerPending,null);assert.equal(env.messages.length,2);
}
// The pending bit survives an early answer before native send acceptance.
{
 const env=fixture();await begin(env);const rec=state(env),op=rec.operation;
 await env.store.intent({url:URL_A,tabId:7,id:rec.id,operationId:op.id,text:op.text});
 const payload={url:URL_A,tabId:7,promptKey:'/c/goal-fixture-a|render-user',
 completionKey:'/c/goal-fixture-a|render-user|answer',userId:'render-user',response:'GOAL_COMPLETE',nativeVerified:true,rawExact:false,nativeMarkerPending:true};
 await env.store.completion(payload);
 assert.equal(state(env).earlyCompletions[0].nativeMarkerPending,true);
 await env.store.report({url:URL_A,tabId:7,id:rec.id,operationId:op.id,status:'confirmed',newPromptKey:payload.promptKey});
 assert.equal(state(env).phase,'waiting');assert.ok(state(env).markerPending);assert.equal(env.messages.length,1);
 await env.store.completion({...payload,rawExact:true,nativeMarkerPending:false});
 assert.equal(state(env).phase,'completed');assert.equal(env.messages.length,1);
}
// An exact settled update can replace the buffered pending answer before ACK.
{
 const env=fixture();await begin(env);const rec=state(env),op=rec.operation;
 await env.store.intent({url:URL_A,tabId:7,id:rec.id,operationId:op.id,text:op.text});
 const payload={url:URL_A,tabId:7,promptKey:'/c/goal-fixture-a|settled-user',completionKey:'/c/goal-fixture-a|settled-user|answer',userId:'settled-user',response:'GOAL_BLOCKED',nativeVerified:true,rawExact:false,nativeMarkerPending:true};
 await env.store.completion(payload);await env.store.completion({...payload,rawExact:true,nativeMarkerPending:false});
 assert.equal(state(env).earlyCompletions.length,1);
 await env.store.report({url:URL_A,tabId:7,id:rec.id,operationId:op.id,status:'confirmed',newPromptKey:payload.promptKey});
 assert.equal(state(env).phase,'blocked');assert.equal(env.messages.length,1);
}
{
 const env=fixture();await begin(env);await confirm(env);await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'pending-marker-handoff',tabId:7});
 const payload={sourceUrl:URL_A,targetUrl:URL_B,handoffId:'pending-marker-handoff',tabId:7,promptKey:'/c/goal-fixture-b|pending',completionKey:'/c/goal-fixture-b|pending|answer',response:'GOAL_COMPLETE',userId:'pending-user',nativeVerified:true,rawExact:false,nativeMarkerPending:true};
 await env.store.stageHandoffCompletion(payload);
 assert.equal(state(env).handoffEarlyCompletions[0].nativeMarkerPending,true);
 await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:payload.handoffId,tabId:7,acceptedUserId:payload.userId});
 assert.equal(state(env,URL_B).phase,'waiting');assert.ok(state(env,URL_B).markerPending);assert.equal(env.messages.length,1);
 await env.store.completion({...payload,url:URL_B,rawExact:true,nativeMarkerPending:false});
 assert.equal(state(env,URL_B).phase,'completed');assert.equal(env.messages.length,1);
}
console.log('Terminal marker render-settle: persisted pending, no continuation, same-key settle, pause/stop and early/handoff ACK passed');
// Manual follow-up acceptance must also carry an early pending marker.
{
 const env=fixture();await begin(env);await confirm(env);
 const promptKey='/c/goal-fixture-a|manual-pending-marker',requestId='manual-pending-request',startedAt=env.time+100;
 await env.store.manual({url:URL_A,tabId:7,requestId,startedAt,eventAt:startedAt,text:'Clarify existing goal',baselineKey:state(env).expectedPromptKey});
 const payload={url:URL_A,tabId:7,promptKey,completionKey:promptKey+'|answer',response:'GOAL_BLOCKED',userId:'manual-pending-user',nativeVerified:true,rawExact:false,nativeMarkerPending:true};
 await env.store.completion(payload);
 assert.equal(state(env).manualEarlyCompletions[0].nativeMarkerPending,true);
 await env.store.manualBind({url:URL_A,tabId:7,id:state(env).id,requestId,startedAt,promptKey,userId:payload.userId,userText:'Clarify existing goal',userSentAtMs:startedAt,nativeVerified:true});
 assert.equal(state(env).phase,'waiting');assert.ok(state(env).markerPending);assert.equal(env.messages.length,1);
 await env.store.completion({...payload,rawExact:true,nativeMarkerPending:false});
 assert.equal(state(env).phase,'blocked');assert.equal(env.messages.length,1);
}
// A native new-chat action may carry a Goal whose ordinary retry failed.
// It must not drop the original objective/clarifications or reset its budget.
{
 const env=fixture();await begin(env);await confirm(env);
 Object.assign(state(env),{phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',continuations:1,
  supplements:[{userId:'saved-user',userText:'Keep this clarification',text:'Keep this clarification'}]});
 const before=structuredClone(state(env));
 assert.match(await env.store.context(URL_A),/Complete review, CI and merge/);
 assert.match(await env.store.context(URL_A),/Keep this clarification/);
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'recoverable-retry-handoff',tabId:7});
 assert.equal(state(env).phase,'handoff');assert.equal(state(env).preHandoffPhase,'recovering');
 await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'recoverable-retry-handoff',tabId:7,acceptedUserId:'accepted-transfer-user'});
 const moved=state(env,URL_B);assert.equal(moved.phase,'waiting');
 for(const k of ['id','goal','rules','startedAt','deadlineAt','continuations','maxContinuations','maxMinutes','supplements'])
  assert.deepEqual(moved[k],before[k],k+' survives retry-blocked handoff unchanged');
 assert.equal(env.messages.length,1,'carrying recovery context does not authorize an extra send');
}
for(const patch of [
 {reason:'Модель ответила точным маркером GOAL_BLOCKED'},
 {reason:'Неподтверждённая отправка пережила перезапуск; автоматический повтор запрещён'},
 {operation:{id:'unknown-click',status:'clicked'}},
 {operation:{id:'reserved-goal-send',status:'reserved'}},
 {manualPending:{requestId:'pending-manual'}},{pauseRequested:true},{stopRequested:true},{manualOverride:true},
 {phase:'stopped'}, {phase:'completed'}
]){
 const env=fixture();await begin(env);await confirm(env);
 Object.assign(state(env),{phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',...patch});
 const before=structuredClone(state(env));
 assert.equal(await env.store.context(URL_A),'','terminal/uncertain state cannot inject Goal context');
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'refused-handoff',tabId:7});
 assert.deepEqual(state(env),before,'terminal/uncertain state cannot migrate');assert.equal(env.messages.length,1);
}
console.log('Retry-blocked Goal handoff: shared exact eligibility, immutable objective/limits and model/unknown/manual stop fences passed');

// Retry failure after an actual user Pause cannot silently resume the Goal
// when a conversation-length error later moves it to a new chat.
for(const kind of ['retry.failed','retry.blocked','draft.restore_failed']) {
 const env=fixture();await begin(env);await confirm(env);
 await env.store.control({url:URL_A,tabId:7,action:'pause'});
 assert.equal(state(env).phase,'paused');const before=structuredClone(state(env));
 await env.store.retry({url:URL_A,tabId:7,kind,attemptId:String(env.time)});
 assert.equal(state(env).phase,'paused',kind+' preserves explicit pause');
 assert.match(await env.store.context(URL_A),/Complete review, CI and merge/);
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId:'paused-retry-handoff',tabId:7});
 assert.equal(state(env).preHandoffPhase,'paused');
 await env.store.handoffConfirm({sourceUrl:URL_A,targetUrl:URL_B,handoffId:'paused-retry-handoff',tabId:7,acceptedUserId:'paused-accepted-user'});
 assert.equal(state(env,URL_B).phase,'paused');
 for(const k of ['id','goal','rules','startedAt','deadlineAt','continuations','maxContinuations','maxMinutes'])
  assert.deepEqual(state(env,URL_B)[k],before[k],k+' remains unchanged through paused recovery');
 await env.store.completion({url:URL_B,tabId:7,promptKey:'/c/goal-fixture-b|paused-user',completionKey:'/c/goal-fixture-b|paused-user|answer',
  userId:'paused-accepted-user',response:'More work remains',nativeVerified:true,rawExact:false});
 assert.equal(state(env,URL_B).phase,'paused');assert.equal(state(env,URL_B).operation,null);assert.equal(env.messages.length,1,'paused transferred reply never auto-continues');
}
console.log('Actual Pause → retry failure → handoff preserves paused state and original limits');

// Only a positively identified failure before navigation can re-arm the same
// Goal handoff when its native new-chat control becomes available again.
{
 const env=fixture();await begin(env);await confirm(env);
 const original=structuredClone(state(env));const handoffId='no-navigation-button';
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId,tabId:7});
 await env.store.handoffFailed({sourceUrl:URL_A,handoffId,tabId:7,reason:'Кнопка нового чата недоступна'});
 const before=structuredClone(state(env));
 assert.equal((await env.store.handoffPreparationReady({sourceUrl:URL_A,handoffId,tabId:7})).ok,false,'old generic wait path cannot reclassify a navigation failure');
 assert.deepEqual(state(env),before);
 assert.equal((await env.store.handoffPreparationReady({sourceUrl:URL_A,handoffId,tabId:7,reason:'Кнопка нового чата недоступна'})).ok,true);
 assert.equal(state(env).phase,'handoff');
 for(const k of ['id','goal','startedAt','deadlineAt','maxMinutes','maxContinuations','continuations'])assert.deepEqual(state(env)[k],original[k]);
 assert.equal(env.messages.length,1,'Goal readiness alone creates no send or navigation');
}
for(const scenario of ['wrong-id','wrong-tab','operation','manual','pause','stop','prepaused','deadline','draft-changed','model-blocked','generic-reason']){
 const env=fixture();await begin(env);await confirm(env);const handoffId='navigation-fence';
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId,tabId:7});
 await env.store.handoffFailed({sourceUrl:URL_A,handoffId,tabId:7,reason:'Кнопка нового чата недоступна'});
 if(scenario==='operation')state(env).operation={id:'unknown',status:'clicked'};
 if(scenario==='manual')state(env).manualPending={requestId:'owner-edit'};
 if(scenario==='pause')state(env).pauseRequested=true;
 if(scenario==='stop')state(env).stopRequested=true;
 if(scenario==='prepaused')state(env).preHandoffPhase='paused';
 if(scenario==='deadline')env.time=state(env).deadlineAt;
 if(scenario==='draft-changed')state(env).reason='Передача Goal остановлена: Черновик изменился';
 if(scenario==='model-blocked')state(env).reason='Модель ответила точным маркером GOAL_BLOCKED';
 const before=structuredClone(state(env));
 const result=await env.store.handoffPreparationReady({sourceUrl:URL_A,handoffId:scenario==='wrong-id'?'other':handoffId,
  tabId:scenario==='wrong-tab'?8:7,reason:scenario==='generic-reason'?'Любая другая ошибка':'Кнопка нового чата недоступна'});
 assert.equal(result.ok,false,scenario);assert.deepEqual(state(env),before,scenario);assert.equal(env.messages.length,1);
}
console.log('No-navigation handoff Goal recovery: explicit reason allowlist and same operation/tab/manual/Pause/Stop/deadline fences passed');

// A failed no-click handoff followed by a verified manual successor must carry
// the existing Goal rather than starting a fresh Goal or resending history.
for(const scenario of ['success','stop','pause','expired','changed','occupied','missing-proof']) {
 const env=fixture();await begin(env);await confirm(env);
 const id=state(env).id,handoffId='manual-successor';
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId,tabId:7});
 await env.store.handoffFailed({sourceUrl:URL_A,handoffId,tabId:7,reason:'Не удалось дождаться готовности нового чата'});
 env.data['chatgpt-goal-composer:7']={id,phase:'bound',binding:{url:URL_A}};
 const old=structuredClone(state(env)),composer=structuredClone(env.data['chatgpt-goal-composer:7']);
 const latest={userId:'native-user',userText:'Manual follow-up',requestId:'native-request',startedAt:env.time+10,
  userSentAtMs:env.time+10,promptKey:'/c/goal-fixture-b|manual',url:URL_B};
 if(scenario==='stop')state(env).stopRequested=true;
 if(scenario==='pause')state(env).pauseRequested=true;
 if(scenario==='expired')env.time=old.deadlineAt;
 if(scenario==='changed')state(env).reason='Changed';
 if(scenario==='occupied')env.data[key(URL_B)]={id:'another',phase:'waiting'};
 const args={tabId:7,sourceUrl:URL_A,targetUrl:URL_B,handoffId,expectedGoal:scenario==='stop'||scenario==='pause'||scenario==='changed'?structuredClone(state(env)):old,
  expectedComposer:composer,sourceContexts:[{url:URL_A,text:'Preserved history'}],supplements:[latest],latest,nativeVerified:scenario!=='missing-proof'};
 if(scenario!=='success'){
  await assert.rejects(()=>env.store.restoreBoundHandoff(args));assert.equal(env.messages.length,1,scenario);continue;
 }
 await env.store.restoreBoundHandoff(args);const restored=state(env,URL_B);
 for(const field of ['id','goal','rules','startedAt','deadlineAt','maxContinuations','continuations'])assert.deepEqual(restored[field],old[field],field);
 assert.equal(restored.supplements.at(-1).userText,'Manual follow-up');assert.equal(state(env).phase,'moved');
 assert.equal(env.data['chatgpt-goal-composer:7'].binding.url,URL_B);assert.equal(env.messages.length,1,'no original-message replay');
 await assert.rejects(()=>env.store.restoreBoundHandoff(args));
 env.tabs[7]=URL_B;env.time+=20;
 const completion={url:URL_B,tabId:7,completionKey:latest.promptKey+'|answer',promptKey:latest.promptKey,
  userId:latest.userId,response:'Work remains',nativeVerified:true,rawExact:false};
 await env.store.completion(completion);
 assert.equal(env.messages.length,2,'the completed successor answer starts one guarded continuation');
 assert.match(env.messages.at(-1)!.message.text,/Manual follow-up/);
 await env.store.completion(completion);assert.equal(env.messages.length,2,'duplicate completion cannot dispatch twice');
}
console.log('Bound Goal recovery: original limits, manual additions and duplicate/stop/pause/expiry fences passed.');

for(const scenario of ['success','duplicate','stopped','wrong-tab','expired','wrong-reason','no-body']) {
 const env=fixture();await begin(env);await confirm(env);
 const id=state(env).id,handoffId='blocked-observation';
 await env.store.handoffBegin({sourceUrl:URL_A,handoffId,tabId:7});
 await env.store.handoffFailed({sourceUrl:URL_A,handoffId,tabId:7,reason:'Не удалось дождаться готовности нового чата'});
 env.data['chatgpt-goal-composer:7']={id,phase:'bound',binding:{url:URL_A}};
 if(scenario==='stopped')state(env).stopRequested=true;
 if(scenario==='wrong-reason')state(env).reason='Different error';
 if(scenario==='expired')env.time=state(env).deadlineAt;
 const input={tabId:scenario==='wrong-tab'?8:7,requestId:'observed-request',startedAt:env.time,url:'https://chatgpt.com/',
  submission:scenario==='no-body'?null:{userId:'user-123',userText:'Sent by the user'}};
 const result=await env.store.composerObserveBlockedRequest(input);
 if(scenario==='success'||scenario==='duplicate') {
  assert.equal(result.ok,true);if(scenario==='duplicate')await env.store.composerObserveBlockedRequest(input);
  assert.equal(env.data['chatgpt-goal-composer:7'].blockedFollowups.length,1);
 } else assert.equal(result.ok,false,scenario);
 assert.equal(state(env).phase,'blocked','observation cannot authorize the Goal');
 assert.equal(env.messages.length,1,'observation cannot send a message');
}
console.log('Blocked handoff submitted-message witness: durable, idempotent, no authority, stop/expiry fences passed.');
{
 const env=fixture();await begin(env);await confirm(env);
 await answer(env,{response:'GOAL_BLOCKED',rawExact:true});
 const before=state(env),deadline=before.deadlineAt,objective=before.goal;
 env.busy=true;await assert.rejects(()=>env.store.control({url:URL_A,tabId:7,action:'resume'}));
 assert.equal(state(env).phase,'blocked');
 env.busy=false;await env.store.control({url:URL_A,tabId:7,action:'resume'});
 assert.equal(state(env).phase,'preparing');assert.equal(state(env).goal,objective);
 assert.equal(state(env).deadlineAt,deadline);assert.equal(env.messages.length,2);
}
