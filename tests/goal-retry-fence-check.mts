import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,type Context} from 'node:vm';

// Actual worker broker, journal and Goal coordinator. No native messages are
// sent: tab delivery acknowledges the persisted reservation only.
const url='https://chatgpt.com/c/manual-retry-fence';
const meta='chatgpt-journal:meta';
const goalKey='chatgpt-goal:'+url;
const worker=readFileSync('extension/service-worker.js','utf8');
const listenerSource=worker.slice(worker.indexOf('chrome.runtime.onMessage.addListener'),
  worker.indexOf('chrome.tabs.onRemoved.addListener'));
type Value=Record<string,any>;
function fixture() {
  const data:Value={},dispatches:Value[]=[];
  let clock=1000000,sequence=0,context:Context;
  let listener:(message:Value,sender:Value,respond:(value:Value)=>void)=>unknown;
  const boot=()=>{
    const chrome={runtime:{getManifest:()=>({version:'fixture'}),
      onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},
      storage:{local:{
        get:async(keys:string|string[])=>structuredClone(Object.fromEntries(
          (Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]]))),
        set:async(values:Value)=>Object.assign(data,structuredClone(values))
      }},
      tabs:{get:async(id:number)=>({id,url}),sendMessage:async(_id:number,message:Value)=>{
        if(message.type==='CHATGPT_GOAL_READINESS')return {ok:true,idle:true};
        dispatches.push(message);return {ok:true};
      }}
    };
    context=createContext({chrome,URL,console,setTimeout,clearTimeout,bindNativeManualSupplement:async()=>({ok:true,pending:false}),
      crypto:{randomUUID:()=>`fence-operation-${++sequence}`},
      Date:class extends Date {static now(){return clock;}},
      messageChatUrl:(message:Value)=>message.url,
      statusReceipt:()=>({epoch:'fixture',order:1}),
      visitChatNotifications:async()=>({}),broadcastChatStatus:async()=>{}});
    for(const name of ['journal-store','request-receipts','handoff-title','goal-policy','goal-store'])
      runInContext(readFileSync(`extension/${name}.js`,'utf8'),context);
    runInContext('const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal});',context);
    runInContext(listenerSource,context);
  };
  boot();
  const evaluate=(code:string,values:Value={})=>{Object.assign(context,values);return runInContext(code,context);};
  const message=(value:Value,tabId=7)=>new Promise<Value>(resolve=>
    listener(value,{tab:{id:tabId,url},frameId:0},resolve));
  const append=(event:Value,tabId=7)=>evaluate('appendJournal(event,tab)',{
    event:{sourceUrl:url,...event},tab:{id:tabId,url}});
  const log=(event:Value,tabId=7)=>message({type:'CHATGPT_LOG_EVENT',event:{sourceUrl:url,...event}},tabId);
  const manual=async(startedAt:number,confirmed=true,tabId=7)=>{
    const requestId='manual-'+startedAt;
    if(confirmed)await evaluate('rememberRequestReceipt(tabId,request)',{
      tabId,request:{startedAt,requestId,url,receipt:{epoch:'fixture',order:startedAt}}});
    return message({type:'CHATGPT_MANUAL_SEND',url,requestId,startedAt},tabId);
  };
  const waitingGoal=async()=>{
    await evaluate('goalController.start(options)',{options:{url,tabId:7,goal:'Synthetic request fence',
      rules:'',maxContinuations:3,maxMinutes:60}});
    const record=data[goalKey],operation=record.operation;
    const options={url,tabId:7,id:record.id,operationId:operation.id,text:operation.text};
    await evaluate('goalController.intent(options)',{options});
    await evaluate('goalController.report(options)',{options:{...options,status:'confirmed',
      newPromptKey:'/c/manual-retry-fence|goal-'+record.id}});
  };
  const retryIntent=async(operationId:string,attemptId:string,promptKey:string,tabId=7)=>{
    const event={operationId,attemptId,promptKey};
    await append({kind:'retry.planned',...event},tabId);
    await append({kind:'retry.send_intent',...event},tabId);
    await append({kind:'send.authorized',operationId},tabId);
  };
  return {data,dispatches,boot,evaluate,message,append,log,manual,waitingGoal,retryIntent,
    active:(tabId=7)=>data[meta].active[tabId],
    clock:(value:number)=>{clock=value;}};
}

// A real newer manual request supersedes only the old retry's chat slot.
// Its operation/turn remain consumed even after restart and late callbacks.
{
  const env=fixture(),oldPrompt='/c/manual-retry-fence|old-user',newPrompt='/c/manual-retry-fence|manual-user';
  await env.retryIntent('old-retry','1000010',oldPrompt);
  assert.equal((await env.manual(1000020,false)).ok,false);
  assert.equal(env.data[meta].active[7].operationId,'old-retry','unconfirmed input cannot release a grant');
  env.boot();
  assert.equal((await env.manual(1000020)).ok,true);
  assert.equal(env.data[meta].active[7],undefined);
  assert.ok(env.data[meta].retryConsumedOperations['old-retry']);
  assert.equal(env.data[meta].retrySendClaims[JSON.stringify([url,oldPrompt])].phase,'consumed');
  env.boot();
  await assert.rejects(()=>env.append({kind:'send.authorized',operationId:'old-retry'}));
  await assert.rejects(()=>env.append({kind:'retry.send_intent',operationId:'old-retry',
    attemptId:'1000010',promptKey:oldPrompt}));
  await assert.rejects(()=>env.append({kind:'retry.planned',operationId:'old-turn-new-id',
    attemptId:'1000020',promptKey:oldPrompt}),'manual intervention never rearms the consumed old turn');
  await env.retryIntent('new-retry','1000020',newPrompt);
  await env.log({kind:'retry.failed',operationId:'old-retry',attemptId:'1000010',clicked:true});
  assert.equal(env.active().operationId,'new-retry','late old outcome cannot clear the new grant');
  await assert.rejects(()=>env.append({kind:'send.authorized',operationId:'new-retry'}),
    'a new-turn retry is still authorized only once');
}

// A delayed acknowledgement cannot lift automation for a newer request, and
// a manual request in another tab can retire only an older shared-chat retry.
{
  const env=fixture();
  await env.retryIntent('newer-retry','1000030','/c/manual-retry-fence|newer',8);
  await env.manual(1000020);
  assert.equal(env.data[meta].active[8].operationId,'newer-retry');
  await env.manual(1000040);
  assert.equal(env.data[meta].active[8],undefined);
  assert.ok(env.data[meta].retryConsumedOperations['newer-retry']);
}

// Legacy retry grants need a provable attempt binding. A legacy reservation
// supplies it; a grant without either timestamp remains safely unresolved.
{
  const env=fixture();
  await env.retryIntent('legacy-with-preparation','1000010','/c/manual-retry-fence|legacy');
  delete env.active().attemptId;
  await env.manual(1000020);
  assert.equal(env.data[meta].active[7],undefined);
  await env.retryIntent('legacy-unknown','1000030','/c/manual-retry-fence|unknown');
  delete env.active().attemptId;
  delete env.data[meta].retryPreparingByChat[url].attemptId;
  await env.manual(1000040);
  assert.equal(env.active().operationId,'legacy-unknown');
}

// Goal unknown operations must never be released by the retry reset branch.
{
  const env=fixture();
  await env.evaluate('goalController.start(options)',{options:{url,tabId:7,goal:'Unknown Goal fixture',
    rules:'',maxContinuations:3,maxMinutes:60}});
  const record=env.data[goalKey],operation=record.operation;
  await env.evaluate('goalController.intent(options)',{options:{url,tabId:7,id:record.id,
    operationId:operation.id,text:operation.text}});
  await env.append({kind:'send.authorized',operationId:operation.id});
  await env.manual(1000020);
  assert.equal(env.data[meta].active[7].operationId,operation.id);
  assert.equal(env.data[meta].active[7].consumed,true);
  assert.equal(env.data[goalKey].operation.id,operation.id);
  assert.equal(env.data[goalKey].phase,'sending');
}

// Handoff grants share the same chat slot but have their own reconciliation;
// acknowledging a manual request must not claim their unknown send outcome.
{
  const env=fixture();
  await env.append({kind:'handoff.sending',operationId:'unknown-handoff',
    sourceUrl:'https://chatgpt.com/c/handoff-source',targetUrl:url},8);
  await env.append({kind:'send.authorized',operationId:'unknown-handoff'},8);
  await env.manual(1000020);
  assert.equal(env.active(8).operationId,'unknown-handoff');
  assert.equal(env.active(8).consumed,true);
}

// The journal's stale-event decision must also fence downstream Goal changes.
{
  const env=fixture();await env.waitingGoal();
  await env.log({kind:'retry.planned',operationId:'earlier-retry',attemptId:'1000010',
    promptKey:env.data[goalKey].expectedPromptKey});
  assert.equal(env.data[goalKey].phase,'recovering');
  await env.manual(1000020);env.boot();
  const before=structuredClone(env.data[goalKey]);
  for(const kind of ['retry.failed','retry.blocked','retry.confirmed']) {
    const result=await env.log({kind,operationId:'earlier-retry',attemptId:'1000010',
      newPromptKey:'/c/manual-retry-fence|stale',reason:'stale outcome'});
    assert.equal(result.superseded,true);
    assert.deepEqual(env.data[goalKey],before,kind+' cannot alter the manually paused Goal');
  }
  assert.equal((await env.log({kind:'retry.planned',operationId:'stale-plan',attemptId:'1000010',
    promptKey:'/c/manual-retry-fence|stale'})).duplicate,true);
  assert.equal(await env.evaluate('readRetryState(url)',{url}),null);
  assert.equal(env.dispatches.length,1);
}

// A callback may already have passed the journal before manual() reaches its
// own writer. Queue both transitions without awaiting; the Goal fence must be
// checked after serialization, and must persist after worker restart.
{
  const env=fixture();await env.waitingGoal();
  const accepted=await env.append({kind:'retry.failed',operationId:'already-journaled',
    attemptId:'1000010',reason:'old failure'});
  assert.equal(accepted.superseded,undefined);
  const manual=env.evaluate('goalController.manual(options)',{options:{url,tabId:7,startedAt:1000020}});
  const callback=env.evaluate('goalController.retry(options)',{options:{url,tabId:7,kind:'retry.failed',attemptId:'1000010'}});
  await Promise.all([manual,callback]);
  assert.equal(env.data[goalKey].phase,'paused');
  env.boot();
  await env.evaluate('goalController.retry(options)',{options:{url,tabId:7,kind:'retry.confirmed',
    attemptId:'1000010',promptKey:'/c/manual-retry-fence|wrong'}});
  assert.equal(env.data[goalKey].phase,'paused');
  assert.notEqual(env.data[goalKey].expectedPromptKey,'/c/manual-retry-fence|wrong');
  await env.evaluate('goalController.retry(options)',{options:{url,tabId:7,kind:'retry.failed'}});
  assert.equal(env.data[goalKey].phase,'paused','an unbound legacy callback cannot bypass the manual fence');
}

// A delayed callback from the previous Goal is older than the new Goal even
// when no manual-request fence was installed between Stop and Start.
{
  const env=fixture();await env.waitingGoal();
  await env.evaluate('goalController.control(options)',{options:{action:'stop',url,tabId:7}});
  env.clock(1000100);await env.waitingGoal();env.boot();
  const before=structuredClone(env.data[goalKey]);
  await env.log({kind:'retry.failed',operationId:'prior-goal-retry',attemptId:'1000010'});
  assert.deepEqual(env.data[goalKey],before);
  // Stop/Start is an automatic Goal send, not a confirmed manual request:
  // it must not reset the independently bounded recovery policy.
  assert.equal((await env.evaluate('readRetryState(url)',{url})).blocked,true);
  await env.log({kind:'retry.planned',operationId:'current-goal-retry',attemptId:'1000101',
    promptKey:env.data[goalKey].expectedPromptKey});
  assert.equal(env.data[goalKey].phase,'recovering','current request recovery remains enabled');
}

{
 const env=fixture();await env.waitingGoal();
 const original=structuredClone(env.data[goalKey]);
 env.data[goalKey]={...env.data[goalKey],phase:'blocked',operation:null,reason:'Восстановление запроса завершилось ошибкой'};
 const confirmed={url,tabId:7,kind:'retry.confirmed',attemptId:'1000100',promptKey:'/c/manual-retry-fence|recovered-user'};
 await env.evaluate('goalController.retry(confirmed)',{confirmed});
 assert.equal(env.data[goalKey].phase,'waiting','confirmed recovery resumes a no-operation recovery block');
 assert.equal(env.data[goalKey].expectedPromptKey,confirmed.promptKey);
 for(const key of ['id','goal','deadlineAt','maxContinuations','continuations'])assert.equal(env.data[goalKey][key],original[key]);
 env.data[goalKey]={...env.data[goalKey],phase:'stopped',reason:'Stopped by user'};
 await env.evaluate('goalController.retry(confirmed)',{confirmed});
 assert.equal(env.data[goalKey].phase,'stopped','retry confirmation cannot resume a stopped goal');
 env.data[goalKey]={...env.data[goalKey],phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',operation:{id:'unknown-click'}};
 await env.evaluate('goalController.retry(confirmed)',{confirmed});
 assert.equal(env.data[goalKey].phase,'blocked','unresolved send retains its fence');
}

// A transient prompt probe failure must not prevent the coordinator from
// recovering its persisted state and buffered completion.
{
 let recovered=0;
 let listener!:(message:Value,sender:Value,respond:(result:Value)=>void)=>unknown;
 const context=createContext({
  chrome:{runtime:{onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},tabs:{get:async()=>({url})}},
  ChatGPTGoalPolicy:{canonical:(value:string)=>value},
  bindNativeManualSupplement:async()=>({ok:true}),
  reconcileGoalPromptBinding:async()=>{throw Error('fixture native probe unavailable');},
  goalController:{recoverTab:async()=>{recovered++;return {ok:true};}}
 });
 runInContext(listenerSource,context);
 const result=await new Promise<Value>(resolve=>listener({type:'CHATGPT_GOAL_RECOVER',url},{tab:{id:7,url},frameId:0},resolve));
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(recovered,1,'native reconciliation failure must still reach durable recovery');
}

// Pause/Stop may arrive after recovery preflight or after its durable intent.
for(const action of ['pause','stop']) {
 for(const afterIntent of [false,true]) {
  const env=fixture();await env.waitingGoal();
  const event={operationId:'recovered-retry',attemptId:'1000010',promptKey:env.data[goalKey].expectedPromptKey};
  await env.append({kind:'retry.planned',...event});
  if(afterIntent)await env.append({kind:'retry.send_intent',...event});
  await env.evaluate('goalController.control(options)',{options:{action,url,tabId:7}});
  env.boot();
  await assert.rejects(()=>env.append({kind:afterIntent?'send.authorized':'retry.send_intent',...event}),
    `${action} must fence recovered retries at ${afterIntent?'authorization':'intent'} after restart`);
  assert.notEqual(env.active()?.consumed,true,'refused retry never consumes a click grant');
 }
}

console.log('Goal/retry fences: confirmed manual supersession, stale callbacks, restart, exact consumed grants and new Goal binding passed.');

// The second history probe can yield while a newer manual request starts.
{
 const content=readFileSync('extension/content-script.js','utf8');
 const route=content.slice(content.indexOf('  async function routeError('),content.indexOf('  function scheduleHandoffReadiness('));
 let handoffs=0,probes=0;
 const context=createContext({location:{pathname:'/c/source'},__chatgptNotifierAttemptId:'old',__chatgptNotifierRequestId:'old-request',
  document:{querySelectorAll:()=>[]},ERROR_SELECTOR:'error',normalize:(v:string)=>v,
  retryState:()=>({repeatedError:'failure',sameErrorCount:3,blocked:false}),audit:async()=>{},
  beginHandoff:async()=>{handoffs++;},notifyOperationWarning:()=>{},
  runtimeMessage:async()=>{if(++probes===2){context.__chatgptNotifierAttemptId='new';context.__chatgptNotifierRequestId='new-request';}
    return {ok:true,action:'retry',messages:[{role:'user',text:'Synthetic context'}]};}
 });
 runInContext(route,context);
 await runInContext("routeError({response:'failure'},'/c/source|old',{})",context);
 assert.equal(handoffs,0,'a newer request during history inspection cancels stale escalation');
}

{
 const env=fixture();
 env.evaluate(`chrome.scripting={executeScript:async()=>{throw Error('fixture native unavailable');}};inspectCompletedTurn=()=>{};`);
 const result=await env.log({kind:'retry.planned',operationId:'probe-fallback',attemptId:'1000010',promptKey:'/c/manual-retry-fence|user'});
 assert.equal(result.ok,true,'optional native claim enrichment cannot cancel guarded retry planning');
}
{
 const env=fixture();await env.waitingGoal();
 env.evaluate(`reconcileNativeGoalAcknowledgement=reconcileAcceptedHandoffGoal=reconcileGoalPreparation=async()=>{throw Error('fixture unavailable');};`);
 const result=await env.message({type:'CHATGPT_GOAL_INLINE',action:'get',url});
 assert.equal(result.ok,true,'failed opportunistic reconciliation must retain Goal controls');
 assert.equal(result.record.id,env.data[goalKey].id);
}

for(const action of ['pause','stop']) {
 const env=fixture();await env.waitingGoal();
 await env.evaluate('goalController.control(options)',{options:{action,url,tabId:7}});
 await assert.rejects(()=>env.append({kind:'retry.preparation_recovered',operationId:'late-recovery',attemptId:'1000010'}),
  'Pause/Stop also fences composer preparation recovery');
}
