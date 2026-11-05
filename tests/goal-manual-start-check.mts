import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const root='https://chatgpt.com/';
const saved='https://chatgpt.com/c/manual-goal-source';
const other='https://chatgpt.com/c/manual-goal-other';
const goalKey=(url:string)=>'chatgpt-goal:'+url;
const composerKey=(tabId:number)=>'chatgpt-goal-composer:'+tabId;
const objective='  Explicit user objective\n\nKeep exact whitespace  ';
function fixture() {
  const data:Record<string,any>={},events:any[]=[],messages:any[]=[],writes:Record<string,any>[]=[];
  let time=1000000,sequence=0,failSet=false,failJournal=false;
  const context=createContext({URL});
  for(const name of ['goal-policy','goal-store'])runInContext(readFileSync(`extension/${name}.js`,'utf8'),context);
  const options={
    storage:{get:async(name:string)=>structuredClone({[name]:data[name]}),set:async(values:Record<string,any>)=>{
      if(failSet)throw Error('Synthetic atomic write failure');
      writes.push(structuredClone(values));Object.assign(data,structuredClone(values));
    }},
    tabs:{get:async(id:number)=>({id,url:saved}),sendMessage:async(tabId:number,message:any)=>{
      messages.push({tabId,message});return {ok:true};
    }},
    appendJournal:async(event:any)=>{if(failJournal)throw Error('Synthetic journal failure');events.push(structuredClone(event));},
    now:()=>time,uuid:()=>`manual-arm-${++sequence}`
  };
  const fresh=()=>context.ChatGPTGoalStore.create(options),store=fresh();
  async function intent(tabId=7,url=root,text=objective) {
    const armed=await store.composerArm({tabId,url,rules:'  Complete the synthetic fixture  '});
    await store.composerIntent({tabId,url,armId:armed.record.id,eventAt:time,text,
      baselineKey:url===root?'':new URL(url).pathname+'|old-user'});
    return armed.record.id;
  }
  function proof(armId:string,tabId=7,url=saved) {
    return {tabId,armId,url,requestId:'native-request-'+tabId,startedAt:1000100,
      promptKey:new URL(url).pathname+'|manual-user',userId:'native-user-'+tabId,userText:objective,
      userSentAtMs:1000200,firstTurn:true,nativeVerified:true};
  }
  return {data,events,messages,writes,store,fresh,intent,proof,
    clock:(next:number)=>{time=next;},failSet:(next:boolean)=>{failSet=next;},
    failJournal:(next:boolean)=>{failJournal=next;}};
}

// Arming and exact send intent are durable authorization only, with no draft
// reads, page calls or automated initial send. Defaults are finite and shared.
{
  const env=fixture();
  assert.equal(await env.store.composerGet({tabId:7}),null);
  const armed=await env.store.composerArm({tabId:7,url:root+'?model=fixture'});
  assert.equal(armed.record.url,root);
  assert.equal(armed.record.phase,'armed');
  assert.deepEqual(structuredClone(armed.record.config),{rules:'',maxContinuations:30,maxMinutes:1440});
  assert.equal((await env.fresh().composerGet({tabId:7})).id,armed.record.id);
  assert.equal(env.data[goalKey(root)],undefined);
  const first={tabId:7,url:root,armId:armed.record.id,eventAt:1000000,text:objective,baselineKey:''};
  await env.store.composerIntent(first);
  env.clock(1020000);
  assert.equal((await env.fresh().composerIntent(first)).record.phase,'intent','exact delayed duplicate is idempotent');
  await assert.rejects(()=>env.store.composerIntent({...first,text:'Different objective'}));
  await assert.rejects(()=>env.store.composerArm({tabId:7,url:root}));
  assert.equal(env.messages.length,0);
  await env.store.composerDisarm({tabId:7});
  assert.equal(await env.fresh().composerGet({tabId:7}),null);
  await assert.rejects(()=>env.store.composerBind(env.proof(armed.record.id)));
  assert.equal(env.messages.length,0);
}

// The first user-sent native turn allocates a root-page Goal atomically. A
// later final answer, not the initial bind, creates the first continuation.
{
  const env=fixture(),armId=await env.intent();
  env.clock(1000300);
  const proof=env.proof(armId),bound=await env.fresh().composerBind(proof);
  assert.equal(bound.record.phase,'bound');
  assert.equal(bound.record.url,root,'retain the original explicit authorization route');
  assert.equal(bound.record.binding.url,saved);
  assert.equal(bound.goal.phase,'waiting');
  assert.equal(bound.goal.operation,null);
  assert.equal(bound.goal.goal,objective);
  assert.equal(bound.goal.rules,'Complete the synthetic fixture');
  assert.equal(bound.goal.continuations,0);
  assert.equal(bound.goal.expectedPromptKey,proof.promptKey);
  assert.equal(bound.goal.startedAt,proof.startedAt);
  assert.equal(bound.goal.deadlineAt,proof.startedAt+1440*60000);
  assert.equal(env.messages.length,0);
  const write=env.writes.at(-1)!;
  assert.ok(Object.hasOwn(write,goalKey(saved))&&Object.hasOwn(write,composerKey(7)),
    'the Goal and bound composer are persisted in one storage operation');
  const before=structuredClone(env.data),journalCount=env.events.length;
  await env.fresh().composerBind(proof);
  assert.deepEqual(env.data,before);assert.equal(env.events.length,journalCount);
  assert.equal(env.events.at(-1).kind,'goal.manual_started');
  assert.equal(env.events.at(-1).text,objective);
  assert.equal(env.events.at(-1).userId,proof.userId);
  assert.equal((await env.store.manual({url:saved,tabId:7,startedAt:proof.startedAt})).ok,false,
    'the delayed seed manual ACK must not pause its own Goal');
  assert.equal(env.data[goalKey(saved)].phase,'waiting');
  const seeded=structuredClone(env.data[goalKey(saved)]);
  for(const kind of ['retry.failed','retry.blocked','retry.confirmed']) {
    await env.fresh().retry({url:saved,tabId:7,kind,promptKey:'/c/manual-goal-source|stale-user'});
    assert.deepEqual(env.data[goalKey(saved)],seeded,'an unbound old retry cannot alter the verified native seed Goal');
  }
  assert.equal(seeded.manualStartedAt,proof.startedAt,'native adoption installs its verified manual-request fence');
  await env.store.retry({url:saved,tabId:7,kind:'retry.planned',attemptId:String(proof.startedAt)});
  assert.equal(env.data[goalKey(saved)].phase,'recovering','the current bound native request can still recover');
  await env.store.retry({url:saved,tabId:7,kind:'retry.confirmed',attemptId:String(proof.startedAt),promptKey:proof.promptKey});
  assert.equal(env.data[goalKey(saved)].phase,'waiting');
  await env.store.completion({url:saved,tabId:7,promptKey:proof.promptKey,
    completionKey:proof.promptKey+'|assistant',response:'Still working',nativeVerified:true,rawExact:false});
  assert.equal(env.messages.length,1);
  assert.equal(env.messages[0].message.type,'CHATGPT_GOAL_DISPATCH');
  assert.equal(env.data[goalKey(saved)].operation.kind,'continuation');
  assert.match(env.messages[0].message.text,/GOAL_COMPLETE/);
}

// An explicit switch-on in another chat supersedes an unbound intent from a
// saved source. Keep its exact authorization history and fence its old binder.
for(const target of [root,other]) {
  const env=fixture(),oldArmId=await env.intent(7,saved);
  const previous=structuredClone(env.data[composerKey(7)]);
  const armed=await env.store.composerArm({tabId:7,url:target});
  assert.equal(armed.record.phase,'armed');assert.equal(armed.record.url,target);
  assert.notEqual(armed.record.id,oldArmId);
  const cancelled=env.events.at(-1);
  assert.equal(cancelled.kind,'goal.composer_superseded');
  assert.equal(cancelled.oldArmId,oldArmId);assert.equal(cancelled.sourceUrl,saved);
  assert.deepEqual(cancelled.oldIntent,previous.intent);
  assert.equal(cancelled.targetUrl,target);assert.ok(cancelled.reason);
  const fresh=structuredClone(env.data[composerKey(7)]);
  await assert.rejects(()=>env.store.composerBind({...env.proof(oldArmId),firstTurn:false}));
  assert.deepEqual(env.data[composerKey(7)],fresh,'late old proof cannot replace or alter the new authorization');
  assert.equal(env.data[goalKey(saved)],undefined);assert.equal(env.data[goalKey(other)],undefined);
  assert.equal(env.messages.length,0,'switching the arm never sends either objective');
}

// Same-route and unsaved-root allocation intents remain fenced until explicit
// disarm; a pending root allocation is not an arbitrary cross-chat intent.
{
  const env=fixture();await env.intent(7,saved);
  const before=structuredClone(env.data);
  await assert.rejects(()=>env.store.composerArm({tabId:7,url:saved+'/?model=fixture'}));
  assert.deepEqual(env.data,before);assert.equal(env.events.length,0);
}
{
  const env=fixture();await env.intent();const before=structuredClone(env.data);
  for(const url of [root,saved,other])await assert.rejects(()=>env.store.composerArm({tabId:7,url}));
  assert.deepEqual(env.data,before);assert.equal(env.events.length,0);assert.equal(env.messages.length,0);
}
{
  const env=fixture(),armId=await env.intent();await env.store.composerBind(env.proof(armId));
  const before=structuredClone(env.data);
  await assert.rejects(()=>env.store.composerArm({tabId:7,url:other}));
  assert.deepEqual(env.data,before,'cross-route arming cannot supersede an already adopted active Goal');
}
{
  const env=fixture();await env.intent(7,saved);const before=structuredClone(env.data);
  env.failJournal(true);
  await assert.rejects(()=>env.store.composerArm({tabId:7,url:other}),/journal failure/);
  assert.deepEqual(env.data,before,'failed cancellation history cannot publish a replacement arm');
  assert.equal(env.messages.length,0);
}

// Saved-chat manual start is bound to that same route. A later real manual
// request retains priority; explicit disarming stops only the adopted Goal.
{
  const env=fixture(),armId=await env.intent(7,saved);
  const proof={...env.proof(armId),firstTurn:false};
  await env.store.composerBind(proof);
  await env.store.manual({url:saved,tabId:7,startedAt:1000500});
  assert.equal(env.data[goalKey(saved)].phase,'paused');
  await env.store.composerDisarm({tabId:7});
  assert.equal(env.data[goalKey(saved)].phase,'stopped');
  assert.equal(env.data[goalKey(saved)].goal,objective,'the durable objective remains available');
  assert.equal(env.messages.length,0);
}

// Native rich links serialize as Markdown after the user sends them. Their
// request-bound rendered bubble proves the visible authorization; the Goal
// retains the actual sent Markdown, including full link destinations.
{
  const visible='  Finish PR #681, #682 and #683.\n\nKeep exact text  ';
  const raw='  Finish PR [#681](https://example.invalid/repo/pull/681?source=fixture), '+
    '[#682](https://example.invalid/repo/pull/682) and [#683](https://example.invalid/repo/pull/683).\n\nKeep exact text  ';
  const env=fixture(),armId=await env.intent(7,saved,visible);
  const proof={...env.proof(armId),firstTurn:false,userText:raw,userVisibleText:visible};
  const bound=await env.store.composerBind(proof);
  assert.equal(bound.goal.goal,raw,'the objective preserves every actual native Markdown URL');
  assert.equal(bound.record.intent.text,visible,'the explicit visible authorization remains exact');
  assert.equal(bound.record.binding.userText,raw);
  assert.equal(bound.record.binding.userVisibleText,visible);
  assert.equal(env.events.at(-1).text,raw,'the durable event records what was actually submitted');
  assert.equal(env.messages.length,0,'rich-link adoption does not send an initial message');
  const before=structuredClone(env.data),events=env.events.length;
  await env.fresh().composerBind(proof);
  assert.deepEqual(env.data,before);assert.equal(env.events.length,events);
  await assert.rejects(()=>env.store.composerBind({...proof,userText:raw.replace('/681?', '/999?')}),
    'an identical visible label cannot change the historical native link target on replay');
  await assert.rejects(()=>env.store.composerBind({...proof,userVisibleText:visible+' altered'}));
  await assert.rejects(()=>env.store.composerBind({...proof,userVisibleText:undefined}));
  assert.deepEqual(env.data,before);
}

// A rendered-text fallback tolerates layout whitespace and requires native proof;
// it cannot adopt another visible message, a draft, or an invalid native text.
{
  const visible='Explicit PR #681',raw='Explicit PR [#681](https://example.invalid/pull/681)';
  for(const changes of [
    {userVisibleText:'Different PR #681'}, {userVisibleText:undefined},
    {nativeVerified:false}, {userText:''}, {userText:'x'.repeat(10001)},
    {startedAt:999999}, {promptKey:'/c/wrong-chat|user'}
  ]) {
    const env=fixture(),armId=await env.intent(7,saved,visible);
    const proof={...env.proof(armId),firstTurn:false,userText:raw,userVisibleText:visible,...changes};
    await assert.rejects(()=>env.store.composerBind(proof));
    assert.equal(env.data[goalKey(saved)],undefined);assert.equal(env.messages.length,0);
  }
  const env=fixture(),armId=await env.intent(7,saved,visible);
  const bound=await env.store.composerBind({...env.proof(armId),firstTurn:false,userText:raw,userVisibleText:visible+'\n'});
  assert.equal(bound.record.binding.userText,raw,'layout whitespace never rewrites the actual native goal');
  assert.equal(env.messages.length,0);
}

// Clearing the switch and binding the native request share one serialization
// boundary. Either order ends with no active automatic continuation.
{
  const env=fixture(),armId=await env.intent();
  const bound=env.store.composerBind(env.proof(armId));
  const off=env.store.composerDisarm({tabId:7,armId});
  await Promise.all([bound,off]);
  assert.equal(env.data[goalKey(saved)].phase,'stopped');
  assert.equal(env.data[composerKey(7)],null);
  const atomic=env.writes.at(-1)!;
  assert.equal(atomic[goalKey(saved)].phase,'stopped');
  assert.equal(atomic[composerKey(7)],null,'disarm and adopted-Goal stop are atomic');
  assert.equal(env.messages.length,0);
}
{
  const env=fixture(),armId=await env.intent();
  const off=env.store.composerDisarm({tabId:7,armId});
  const bind=env.store.composerBind(env.proof(armId));
  const result=await Promise.allSettled([off,bind]);
  assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');
  assert.equal(env.data[composerKey(7)],null);assert.equal(env.data[goalKey(saved)],undefined);
  assert.equal(env.messages.length,0);
}

// An old switch-off callback cannot clear a newer authorization. Completed
// native Goals can be armed afresh on their exact bound chat without cleanup.
{
  const env=fixture(),armId=await env.intent();
  const proof=env.proof(armId);await env.store.composerBind(proof);
  await env.store.completion({url:saved,tabId:7,promptKey:proof.promptKey,
    completionKey:proof.promptKey+'|assistant',response:'GOAL_COMPLETE',nativeVerified:true,rawExact:true});
  const rearmed=await env.store.composerArm({tabId:7,url:saved});
  assert.notEqual(rearmed.record.id,armId);assert.equal(rearmed.record.phase,'armed');
  await assert.rejects(()=>env.store.composerDisarm({tabId:7,armId}));
  assert.equal(env.data[composerKey(7)].id,rearmed.record.id);
  assert.equal(env.messages.length,0);
}

// Disarming an adopted Goal never stops a newer Goal that reused its chat,
// while a continuation already at intent keeps its unknown-send fence.
{
  const env=fixture(),armId=await env.intent();await env.store.composerBind(env.proof(armId));
  await env.store.control({action:'stop',url:saved,tabId:7});
  await env.store.start({url:saved,tabId:7,goal:'Newer explicit popup Goal',rules:'',maxContinuations:1,maxMinutes:30});
  const before=structuredClone(env.data[goalKey(saved)]),sends=env.messages.length;
  await assert.rejects(()=>env.store.composerBind(env.proof(armId)));
  await env.store.composerDisarm({tabId:7,armId});
  assert.deepEqual(env.data[goalKey(saved)],before);
  assert.equal(env.messages.length,sends);
}

// Reusing a tab for an explicit new-chat arm after completion leaves the old
// Goal immutable and waits for its own first native turn in the new chat.
{
  const env=fixture(),armId=await env.intent(),proof=env.proof(armId);
  await env.store.composerBind(proof);
  await env.store.completion({url:saved,tabId:7,promptKey:proof.promptKey,
    completionKey:proof.promptKey+'|assistant',response:'GOAL_COMPLETE',nativeVerified:true,rawExact:true});
  const previous=structuredClone(env.data[goalKey(saved)]);
  const armed=await env.store.composerArm({tabId:7,url:root});
  assert.notEqual(armed.record.id,armId);assert.equal(armed.record.phase,'armed');
  assert.deepEqual(env.data[goalKey(saved)],previous);
  assert.equal(env.data[goalKey(other)],undefined,'an explicit new arm alone cannot allocate a Goal');
  await env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,eventAt:1000000,
    text:objective,baselineKey:''});
  const next={...env.proof(armed.record.id,7,other),requestId:'new-chat-native-request',userId:'new-chat-native-user'};
  await env.store.composerBind(next);
  assert.equal(env.data[goalKey(other)].id,armed.record.id);
  assert.deepEqual(env.data[goalKey(saved)],previous);
  assert.equal(env.messages.length,0);
}
{
  const env=fixture(),armId=await env.intent(),proof=env.proof(armId);
  await env.store.composerBind(proof);
  await env.store.completion({url:saved,tabId:7,promptKey:proof.promptKey,
    completionKey:proof.promptKey+'|assistant',response:'Continue',nativeVerified:true,rawExact:false});
  const goal=env.data[goalKey(saved)],op=goal.operation;
  await env.store.intent({url:saved,tabId:7,id:goal.id,operationId:op.id,text:op.text});
  const sends=env.messages.length;
  await env.store.composerDisarm({tabId:7,armId});
  assert.equal(env.data[goalKey(saved)].phase,'sending');
  assert.equal(env.data[goalKey(saved)].stopRequested,true);
  assert.equal(env.data[goalKey(saved)].operation.id,op.id);
  await assert.rejects(()=>env.store.authorize({url:saved,tabId:7,id:goal.id,operationId:op.id,text:op.text}));
  assert.equal(env.messages.length,sends,'disarm never sends or recreates an uncertain operation');
}

// Neither stale/replaced intent nor a merely similar native turn may bind.
{
  const env=fixture(),armId=await env.intent();
  const valid=env.proof(armId),before=structuredClone(env.data);
  for(const bad of [
    {...valid,armId:'stale-arm'}, {...valid,nativeVerified:false}, {...valid,requestId:''},
    {...valid,userId:''}, {...valid,userText:objective.trim()}, {...valid,startedAt:999999},
    {...valid,startedAt:1010001}, {...valid,userSentAtMs:1030000},
    {...valid,promptKey:'/c/wrong-chat|user'}, {...valid,firstTurn:false}
  ])await assert.rejects(()=>env.store.composerBind(bad));
  assert.deepEqual(env.data,before);assert.equal(env.messages.length,0);
  await assert.rejects(()=>env.store.composerBind({...valid,url:root}));
  await assert.rejects(()=>env.store.composerBind({...valid,url:'https://example.invalid/c/goal'}));
}
{
  const env=fixture(),armId=await env.intent(7,saved);
  await assert.rejects(()=>env.store.composerBind({...env.proof(armId,7,other),firstTurn:false}));
  await assert.rejects(()=>env.store.composerBind({...env.proof(armId),promptKey:'/c/manual-goal-source|old-user'}));
  assert.equal(env.data[goalKey(saved)],undefined);
  assert.equal(env.data[goalKey(other)],undefined);
}
{
  for(const changes of [{eventAt:999999},{eventAt:1000001},{eventAt:NaN},{text:'  '},{text:'x'.repeat(10001)},
    {url:other},{armId:'stale-arm'}]) {
    const env=fixture(),armed=await env.store.composerArm({tabId:7,url:saved});
    await assert.rejects(()=>env.store.composerIntent({tabId:7,url:saved,armId:armed.record.id,
      eventAt:1000000,text:objective,baselineKey:'/c/manual-goal-source|old-user',...changes}));
    assert.equal(env.data[composerKey(7)].phase,'armed');
  }
  const env=fixture(),armed=await env.store.composerArm({tabId:7,url:root});env.clock(1010001);
  await assert.rejects(()=>env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,
    eventAt:1000000,text:objective,baselineKey:''}));
  await assert.rejects(()=>env.store.composerArm({tabId:7,url:'https://example.invalid/'}));
}

// Competing tabs may not overwrite one another's active Goal, even if both
// observe the same allocated chat before either asynchronous bind completes.
{
  const env=fixture(),one=await env.intent(7),two=await env.intent(8);
  const results=await Promise.allSettled([env.store.composerBind(env.proof(one,7)),env.store.composerBind(env.proof(two,8))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const before=structuredClone(env.data[goalKey(saved)]);
  await assert.rejects(()=>env.store.composerBind(env.proof(two,8)));
  assert.deepEqual(env.data[goalKey(saved)],before);assert.equal(env.messages.length,0);
}

// One arm ID cannot allocate another chat, including copied pre-bind state.
{
  const env=fixture(),armId=await env.intent();
  env.data[composerKey(8)]=structuredClone(env.data[composerKey(7)]);
  await env.store.composerBind(env.proof(armId));
  await assert.rejects(()=>env.store.composerBind(env.proof(armId,7,other)));
  await assert.rejects(()=>env.store.composerBind(env.proof(armId,8,other)));
  assert.equal(env.data[goalKey(other)],undefined);assert.equal(env.messages.length,0);
}

// Storage/journal failures cannot publish a partial initial Goal or dispatch.
{
  const env=fixture(),armId=await env.intent(),proof=env.proof(armId);
  const before=structuredClone(env.data);
  env.failJournal(true);await assert.rejects(()=>env.store.composerBind(proof),/journal failure/);
  assert.deepEqual(env.data,before);
  env.failJournal(false);env.failSet(true);
  await assert.rejects(()=>env.store.composerBind(proof),/atomic write failure/);
  assert.deepEqual(env.data,before);
  assert.equal(env.data[goalKey(saved)],undefined);
  env.failSet(false);await env.fresh().composerBind(proof);
  assert.equal(env.data[goalKey(saved)].phase,'waiting');assert.equal(env.messages.length,0);
}

console.log('Goal manual start: explicit arm/intent, exact native root/saved binding, dedupe, atomic persistence and zero initial sends passed.');

// The request observer and trusted inline intent use separate async queues.
// A request seen first is observation only until the exact UI intent persists.
{
 const env=fixture(),armed=await env.store.composerArm({tabId:7,url:root});
 const wire={tabId:7,armId:armed.record.id,url:root,requestId:'wire-first',startedAt:1000100,
  submission:{userId:'native-user-7',userText:objective}};
 assert.equal((await env.store.composerRequest(wire)).ok,true);
 const observed=await env.fresh().composerGet({tabId:7});
 assert.equal(observed.phase,'armed');assert.deepEqual(observed.requestCandidate,{requestId:wire.requestId,startedAt:wire.startedAt,url:wire.url,submission:wire.submission});
 assert.equal(observed.request,undefined);assert.equal(env.data[goalKey(saved)],undefined);assert.equal(env.messages.length,0);
 const count=env.writes.length;await env.fresh().composerRequest(wire);assert.equal(env.writes.length,count,'duplicate observation is idempotent');
 env.clock(1000300);await env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,eventAt:1000000,text:objective,baselineKey:''});
 const pending=await env.fresh().composerGet({tabId:7});
 assert.equal(pending.request.requestId,wire.requestId);assert.deepEqual(pending.request.submission,wire.submission);
 const native={...env.proof(armed.record.id),requestId:wire.requestId};
 await assert.rejects(()=>env.store.composerBind({...native,nativeVerified:false}));
 assert.equal(env.data[goalKey(saved)],undefined,'wire plus intent still needs exact native proof');
 await env.store.composerBind(native);assert.equal(env.data[goalKey(saved)].phase,'waiting');assert.equal(env.data[goalKey(saved)].goal,objective);
 assert.equal(env.messages.length,0,'request-first adoption does not replay the initial message');
}
for(const scenario of ['text','url','before-arm','late-after-intent','no-body','empty-id','large-body','changed-arm','disarmed']) {
 const env=fixture(),armed=await env.store.composerArm({tabId:7,url:root});
 const wire:any={tabId:7,armId:armed.record.id,url:root,requestId:'candidate',startedAt:1000100,submission:{userId:'native-user',userText:objective}};
 if(scenario==='text')wire.submission.userText='Different message';
 if(scenario==='url')wire.url=other;
 if(scenario==='before-arm')wire.startedAt=999999;
 if(scenario==='late-after-intent')wire.startedAt=1010001;
 if(scenario==='no-body')delete wire.submission;
 if(scenario==='empty-id')wire.submission.userId='';
 if(scenario==='large-body')wire.submission.userText='x'.repeat(10001);
 await env.store.composerRequest(wire);
 if(scenario==='changed-arm'){
  await env.store.composerArm({tabId:7,url:other});
  await assert.rejects(()=>env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,eventAt:1000000,text:objective,baselineKey:''}));
  assert.equal((await env.store.composerGet({tabId:7})).requestCandidate,undefined);
 }else if(scenario==='disarmed'){
  await env.store.composerDisarm({tabId:7,armId:armed.record.id});
  assert.equal((await env.store.composerRequest(wire)).ok,false);assert.equal(await env.store.composerGet({tabId:7}),null);
 }else{
  env.clock(1000300);await env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,eventAt:1000000,text:objective,baselineKey:''});
  assert.equal((await env.store.composerGet({tabId:7})).request,undefined,scenario);
 }
 assert.equal(env.data[goalKey(saved)],undefined,scenario);assert.equal(env.messages.length,0,scenario);
}
{
 const env=fixture(),armed=await env.store.composerArm({tabId:7,url:root});
 const wire={tabId:7,armId:armed.record.id,url:root,requestId:'candidate-a',startedAt:1000100,submission:{userId:'native-user-7',userText:objective}};
 await env.store.composerRequest(wire);
 const ambiguous=await env.store.composerRequest({...wire,requestId:'candidate-b',startedAt:1000200});
 assert.equal(ambiguous.ok,false);assert.equal(ambiguous.ambiguous,true);
 env.clock(1000300);await env.store.composerIntent({tabId:7,url:root,armId:armed.record.id,eventAt:1000000,text:objective,baselineKey:''});
 assert.equal((await env.fresh().composerGet({tabId:7})).requestCandidateAmbiguous,true);
 assert.equal((await env.store.composerRequest(wire)).ok,false,'late fallback cannot replace ambiguity with latest request');
 assert.equal((await env.store.composerGet({tabId:7})).request,undefined);
 await assert.rejects(()=>env.store.composerBind({...env.proof(armed.record.id),requestId:wire.requestId}),/несколько запросов/);
 assert.equal(env.messages.length,0);assert.equal(env.data[goalKey(saved)],undefined);
 await env.store.composerDisarm({tabId:7,armId:armed.record.id});
 const fresh=await env.store.composerArm({tabId:7,url:root});assert.notEqual(fresh.record.id,armed.record.id);
 assert.equal(fresh.record.requestCandidateAmbiguous,undefined);assert.equal(fresh.record.requestCandidate,undefined);
 assert.equal((await env.store.composerRequest(wire)).ok,false,'old arm candidate cannot attach to refreshed arm');
}
console.log('Pre-intent request observation: durable exact candidate, intent/native proof gates, ambiguity retention and cancellation passed.');
