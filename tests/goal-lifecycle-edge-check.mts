import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Real coordinator transitions with durable storage and synthetic tab delivery.
// These interleavings must not lose handoff identity or renew the send budget.
const source='https://chatgpt.com/c/goal-edge-source';
const target='https://chatgpt.com/c/goal-edge-target';
const key=(url:string)=>'chatgpt-goal:'+url;
function fixture() {
  const data:Record<string,any>={},messages:any[]=[],events:any[]=[];
  let sequence=0;
  const context=createContext({URL});
  for(const name of ['goal-policy','goal-store'])
    runInContext(readFileSync(`extension/${name}.js`,'utf8'),context);
  const options={
    storage:{get:async(name:string)=>({[name]:structuredClone(data[name])}),
      set:async(values:Record<string,unknown>)=>Object.assign(data,structuredClone(values))},
    tabs:{get:async(id:number)=>({id,url:source}),sendMessage:async(_id:number,message:any)=>{
      if(message.type==='CHATGPT_GOAL_READINESS')return {ok:true,idle:true};
      messages.push(message);return {ok:true};
    }},
    appendJournal:async(event:any)=>{events.push(structuredClone(event));},
    now:()=>1000000,uuid:()=>`edge-operation-${++sequence}`
  };
  const fresh=()=>context.ChatGPTGoalStore.create(options);
  const store=fresh();
  const state=(url=source)=>data[key(url)];
  const start=()=>store.start({url:source,tabId:7,goal:'Synthetic lifecycle fixture',rules:'',
    maxContinuations:1,maxMinutes:60});
  async function confirm(promptKey:string) {
    const {id,operation:op}=state();
    await store.intent({url:source,tabId:7,id,operationId:op.id,text:op.text});
    await store.report({url:source,tabId:7,id,operationId:op.id,status:'confirmed',newPromptKey:promptKey});
  }
  const answer=()=>store.completion({url:source,tabId:7,promptKey:state().expectedPromptKey,
    completionKey:state().expectedPromptKey+'|assistant',response:'Still working',nativeVerified:true,rawExact:false});
  async function exhaust() {
    await start();await confirm('/c/goal-edge-source|user-1');await answer();
    await confirm('/c/goal-edge-source|user-2');
    assert.equal(state().continuations,1);
    assert.equal(state().phase,'waiting');
  }
  return {store,fresh,state,start,confirm,answer,exhaust,messages,events};
}

// Pause while handoff is in progress must survive restart and still transfer.
{
  const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
  await env.store.handoffBegin({sourceUrl:source,handoffId:'pause-handoff',tabId:7});
  await env.store.control({action:'pause',url:source,tabId:7});
  assert.equal(env.state().phase,'handoff','pause retains the live transfer binding');
  assert.equal(env.state().preHandoffPhase,'paused');
  await env.fresh().handoffConfirm({sourceUrl:source,targetUrl:target,handoffId:'pause-handoff',
    tabId:7,acceptedUserId:'native-handoff-user'});
  assert.equal(env.state().phase,'moved');
  assert.equal(env.state(target).phase,'paused');
  assert.equal(env.state(target).handoffPending,true);
  assert.equal(env.messages.length,1,'pause cannot dispatch an extra message');
}

// Resume during transfer changes only the destination's eventual pause state.
{
  const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
  await env.store.handoffBegin({sourceUrl:source,handoffId:'resume-handoff',tabId:7});
  await env.store.control({action:'pause',url:source,tabId:7});
  await env.fresh().control({action:'resume',url:source,tabId:7});
  assert.equal(env.state().phase,'handoff');
  assert.equal(env.state().preHandoffPhase,'waiting');
  assert.equal(env.messages.length,1);
  await env.store.handoffConfirm({sourceUrl:source,targetUrl:target,handoffId:'resume-handoff',
    tabId:7,acceptedUserId:'native-handoff-user'});
  assert.equal(env.state(target).phase,'waiting');
}

// A manual intervention does not grant an extra continuation past the limit.
{
  const env=fixture();await env.exhaust();
  await env.store.manual({url:source,tabId:7});
  await env.fresh().control({action:'resume',url:source,tabId:7});
  assert.equal(env.state().phase,'stopped');
  assert.equal(env.state().operation,null);
  assert.equal(env.messages.length,2,'manual Resume preserves the original finite budget');
}

// A delayed acknowledgement from before Start cannot pause the new Goal.
{
  const env=fixture();await env.start();
  const operationId=env.state().operation.id;
  assert.equal((await env.store.manual({url:source,tabId:7,startedAt:999999})).ok,false);
  assert.equal(env.state().phase,'preparing');
  assert.equal(env.state().operation.id,operationId);
  assert.equal((await env.store.manual({url:source,tabId:7,startedAt:1000000})).ok,true);
  assert.equal(env.state().phase,'paused','a current manual request still takes priority');
  assert.equal(env.state().operation,null);
}

// A pending continuation paused before dispatch also keeps its existing count.
{
  const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');await env.answer();
  await env.store.control({action:'pause',url:source,tabId:7});
  assert.equal(env.state().pendingSendKind,'continuation');
  await env.store.control({action:'resume',url:source,tabId:7});
  assert.equal(env.state().operation.kind,'continuation');
  await env.confirm('/c/goal-edge-source|user-2');
  await env.store.control({action:'pause',url:source,tabId:7});await env.answer();
  assert.equal(env.state().phase,'stopped','paused final answer stops at the exhausted budget');
  assert.equal(env.messages.length,3,'only the safe paused reservation is redelivered');
}

// A terminal failed transfer blocks exactly its own Goal and remains durable.
{
  const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
  await env.store.handoffBegin({sourceUrl:source,handoffId:'failed-handoff',tabId:7});
  assert.equal((await env.store.handoffFailed({sourceUrl:source,handoffId:'stale-handoff',
    tabId:7,reason:'stale failure'})).ok,false);
  assert.equal(env.state().phase,'handoff');
  assert.equal((await env.store.handoffFailed({sourceUrl:source,handoffId:'failed-handoff',
    tabId:8,reason:'other tab'})).ok,false);
  const failed=await env.fresh().handoffFailed({sourceUrl:source,handoffId:'failed-handoff',
    tabId:7,reason:'Synthetic reasoning setting unavailable'});
  assert.equal(failed.ok,true);
  assert.equal(env.state().phase,'blocked');
  assert.match(env.state().reason,/Synthetic reasoning setting unavailable/);
  assert.equal((await env.fresh().get(source)).phase,'blocked');
  await env.store.handoffConfirm({sourceUrl:source,targetUrl:target,handoffId:'failed-handoff',
    tabId:7,acceptedUserId:'late-native-user'});
  assert.equal(env.state(target),undefined,'failed transfer cannot later revive the Goal');
  assert.equal(env.messages.length,1,'terminal failure never schedules another send');
}

// Exact worker replay can backfill a legacy transfer's missing tab binding.
{
  const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
  await env.store.handoffBegin({sourceUrl:source,handoffId:'legacy-handoff',tabId:7});
  delete env.state().handoffTabId;
  await assert.rejects(()=>env.fresh().handoffBegin({sourceUrl:source,handoffId:'stale-handoff',tabId:8}));
  assert.equal(env.state().handoffTabId,undefined,'a stale ID cannot claim the legacy binding');
  await env.fresh().handoffBegin({sourceUrl:source,handoffId:'legacy-handoff',tabId:7});
  assert.equal(env.state().handoffTabId,7);
  await env.store.handoffBegin({sourceUrl:source,handoffId:'legacy-handoff',tabId:8});
  assert.equal(env.state().handoffTabId,7,'an existing binding is never replaced');
  assert.equal(env.events.filter(event=>event.kind==='goal.handoff_begin').length,1);
  assert.equal(env.messages.length,1,'legacy backfill has no native send effect');
  assert.equal((await env.store.handoffFailed({sourceUrl:source,handoffId:'legacy-handoff',
    tabId:7,reason:'Recovered legacy failure'})).ok,true);
  assert.equal(env.state().phase,'blocked');
}

console.log('Goal lifecycle: handoff pause/resume/failure, legacy binding and finite manual-resume budget passed.');

// Readiness recovery preserves the exact Goal and budget; explicit controls win.
{
 const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
 await env.store.handoffBegin({sourceUrl:source,handoffId:'ready-handoff',tabId:7});
 await env.store.handoffFailed({sourceUrl:source,handoffId:'ready-handoff',tabId:7,reason:'Не удалось дождаться готовности нового чата'});
 const before=structuredClone(env.state());
 assert.equal((await env.store.handoffPreparationReady({sourceUrl:source,handoffId:'other',tabId:7})).ok,false);
 assert.equal((await env.store.handoffPreparationReady({sourceUrl:source,handoffId:'ready-handoff',tabId:8})).ok,false);
 const recovered=await env.store.handoffPreparationReady({sourceUrl:source,handoffId:'ready-handoff',tabId:7});
 assert.equal(recovered.ok,true);assert.equal(env.state().phase,'handoff');
 for(const key of ['goal','deadlineAt','continuations','id','maxContinuations'])assert.equal(env.state()[key],before[key]);
 assert.equal(env.messages.length,1,'preparation recovery never dispatches a Goal message');
 env.state().pauseRequested=true;
 assert.equal((await env.store.handoffPreparationReady({sourceUrl:source,handoffId:'ready-handoff',tabId:7})).ok,false);
}

// A positively refused retry preparation may recover without a Goal send/budget reset.
{
 const env=fixture();await env.start();await env.confirm('/c/goal-edge-source|user');
 await env.store.retry({url:source,tabId:7,kind:'retry.failed',attemptId:'1000000'});
 const before=structuredClone(env.state());
 await env.store.retry({url:source,tabId:7,kind:'retry.preparation_recovered',attemptId:'1000000',promptKey:'/c/goal-edge-source|other'});
 assert.equal(env.state().phase,'blocked');
 await env.store.retry({url:source,tabId:7,kind:'retry.preparation_recovered',attemptId:'1000000',promptKey:before.expectedPromptKey});
 assert.equal(env.state().phase,'recovering');
 assert.equal(env.state().deadlineAt,before.deadlineAt);assert.equal(env.state().continuations,before.continuations);
 assert.equal(env.messages.length,1,'recovery returns control to the shared retry sender');
}
