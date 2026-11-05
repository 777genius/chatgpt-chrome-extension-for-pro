import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Exercise the real worker handoff handler, not a replica of its branches.
// This probes the storage/Goal crash boundary without navigating a live chat.
const code=readFileSync('extension/service-worker.js','utf8');
const start=code.indexOf('function handoffKey(tabId)');
const end=code.indexOf('chrome.runtime.onMessage.addListener',start);
assert.ok(start>=0&&end>start,'handoff handler is present');
const saved:Record<string,any>={};
const journals:Record<string,any>[]=[];
const inflight=new Map<number,Promise<any>>();
let failGoal=true;
let failFailedRecordWrite=false;
let failGoalFailureCallback=false;
let sequence=0;
const dispatches:any[]=[];
const storage={
  async get(names:string|string[]) {
    return structuredClone(Object.fromEntries((Array.isArray(names)?names:[names]).map(name=>[name,saved[name]])));
  },
  async set(values:Record<string,any>) {
    if(failFailedRecordWrite&&Object.values(values).some(value=>value?.stage==='failed'))
      throw Error('Synthetic failed-record storage failure');
    Object.assign(saved,structuredClone(values));
  },
  async remove(name:string){delete saved[name];}
};
const appendJournal=async(event:Record<string,any>)=>{journals.push(event);return {ok:true};};
const context=createContext({URL});
for(const name of ['goal-policy','goal-store'])
  runInContext(readFileSync(`extension/${name}.js`,'utf8'),context);
const goals=context.ChatGPTGoalStore.create({storage,appendJournal,now:()=>1000000,
  uuid:()=>`worker-handoff-operation-${++sequence}`,
  tabs:{get:async(id:number)=>({id,url:saved[`fixture-tab:${id}`]}),
    sendMessage:async(_id:number,message:any)=>{dispatches.push(message);return {ok:true};}}
});
const handler=(new Function('chrome','ChatGPTHandoffTitle','goalController','appendJournal','handoffWrites',
  code.slice(start,end)+'\nreturn handleHandoffMessage;')(
  {storage:{local:storage}},
  {chatUrl:(url:unknown)=>typeof url==='string'&&url.startsWith('https://chatgpt.com/c/')?url:null,
    planNext:()=>({title:'Handoff fixture'})},
  {get:goals.get,
    handoffBegin:async(options:any)=>{if(failGoal)throw Error('Original Goal transition refused');return goals.handoffBegin(options);},
    handoffConfirm:goals.handoffConfirm,
    handoffFailed:async(options:any)=>{
      assert.equal(saved[`chatgpt-handoff:${options.tabId}`].stage,'failed',
        'the failed handoff must be durable before its Goal callback');
      assert.equal(saved[`chatgpt-handoff:${options.tabId}`].id,options.handoffId);
      if(failGoalFailureCallback)throw Error('Synthetic interruption before Goal failure write');
      return goals.handoffFailed(options);
    }},
  appendJournal,
  inflight
)) as (message:Record<string,any>,tabId:number)=>Promise<any>;
const sourceUrl='https://chatgpt.com/c/goal-handoff-crash';
const marker=(tab:number)=>`chatgpt-handoff:${tab}:source:${sourceUrl}`;
const record=(id:string)=>({reasoningEffort:'max',reasoningModel:'gpt-6-thinking',id,sourceUrl,sourceTitle:'Goal fixture',text:'handoff text',prompt:'handoff prompt',asFile:false});

await assert.rejects(()=>handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('first')},7),
  /Original Goal transition refused/);
assert.equal(saved[marker(7)],undefined,'pre-navigation failure clears its handoff marker');
assert.equal(saved['chatgpt-handoff:7'].stage,'failed','handoff failure is visible');

failGoal=false;
const retry=await handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('second')},7);
assert.equal(retry.ok,true,'same chat can retry after a failed preparation');
assert.equal(saved[marker(7)],'second');

failGoal=true;
failFailedRecordWrite=true;
await assert.rejects(()=>handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('third')},8),
  /Original Goal transition refused/,
  'cleanup write failure must not replace the original Goal error');
assert.equal(saved[marker(8)],undefined,'marker removal is still attempted if failed-record write fails');
assert.deepEqual(journals.map(event=>event.kind),[
  'handoff.navigating','handoff.pre_navigation_cancelled',
  'handoff.navigating','handoff.navigating'
], 'only the proven pre-navigation failure releases its durable source claim');

failGoal=false;
failFailedRecordWrite=false;
async function waitingGoal(url:string,tabId:number) {
  saved[`fixture-tab:${tabId}`]=url;
  await goals.start({url,tabId,goal:'Synthetic transfer fixture',rules:'',maxContinuations:1,maxMinutes:60});
  const current=saved['chatgpt-goal:'+url],op=current.operation;
  await goals.intent({url,tabId,id:current.id,operationId:op.id,text:op.text});
  await goals.report({url,tabId,id:current.id,operationId:op.id,status:'confirmed',
    newPromptKey:new URL(url).pathname+'|user'});
}

// The normal failed UPDATE must also terminate the actual matching Goal.
{
  const url='https://chatgpt.com/c/goal-handoff-failed-update';
  await waitingGoal(url,9);
  await handler({type:'CHATGPT_HANDOFF_BEGIN',record:{...record('failed-update'),sourceUrl:url}},9);
  assert.equal(saved['chatgpt-goal:'+url].phase,'handoff');
  const failure=await handler({type:'CHATGPT_HANDOFF_UPDATE',id:'failed-update',stage:'failed',
    reason:'Synthetic reasoning control unavailable'},9);
  assert.equal(failure.ok,true);
  assert.equal(failure.record.stage,'failed');
  assert.equal(saved['chatgpt-goal:'+url].phase,'blocked');
  assert.match(saved['chatgpt-goal:'+url].reason,/Synthetic reasoning control unavailable/);
  assert.equal(dispatches.length,1,'a failed UPDATE cannot dispatch another Goal send');
}

// Suspension between durable failed UPDATE and Goal callback leaves enough
// evidence for GET to backfill an older binding and replay only the failure.
{
  const url='https://chatgpt.com/c/goal-handoff-failed-replay';
  await waitingGoal(url,10);
  await handler({type:'CHATGPT_HANDOFF_BEGIN',record:{...record('failed-replay'),sourceUrl:url}},10);
  failGoalFailureCallback=true;
  await assert.rejects(()=>handler({type:'CHATGPT_HANDOFF_UPDATE',id:'failed-replay',stage:'failed',
    reason:'Synthetic attachment preparation failure'},10),/Synthetic interruption/);
  assert.equal(saved['chatgpt-handoff:10'].stage,'failed');
  assert.equal(saved['chatgpt-goal:'+url].phase,'handoff');
  delete saved['chatgpt-goal:'+url].handoffTabId;
  failGoalFailureCallback=false;
  const recovered=await handler({type:'CHATGPT_HANDOFF_GET'},10);
  assert.equal(recovered.record.id,'failed-replay');
  assert.equal(recovered.record.stage,'failed');
  assert.equal(saved['chatgpt-goal:'+url].phase,'blocked');
  assert.equal(saved['chatgpt-goal:'+url].handoffTabId,10,'GET replays binding before terminal failure');
  assert.match(saved['chatgpt-goal:'+url].reason,/Synthetic attachment preparation failure/);
  const failures=journals.filter(event=>event.kind==='goal.handoff_failed').length;
  await handler({type:'CHATGPT_HANDOFF_GET'},10);
  assert.equal(journals.filter(event=>event.kind==='goal.handoff_failed').length,failures,
    'repeat GET consumes the terminal transition once');
  assert.equal(dispatches.length,2,'failed replay cannot send either Goal again');
}

// Old failed recovery copies belong to their historical transfer, never a new
// Goal started later in the same chat and tab. GET must leave that Goal intact.
{
  const url='https://chatgpt.com/c/goal-after-historical-failure';
  saved['chatgpt-handoff:11']={...record('historical-failed-handoff'),sourceUrl:url,stage:'failed',
    reason:'Historical preparation failure'};
  await waitingGoal(url,11);
  const before=structuredClone(saved['chatgpt-goal:'+url]);
  assert.equal(before.phase,'waiting');
  const recovered=await handler({type:'CHATGPT_HANDOFF_GET'},11);
  assert.equal(recovered.record.id,'historical-failed-handoff','the original recovery copy remains accessible');
  assert.deepEqual(saved['chatgpt-goal:'+url],before,'historical failed GET cannot rebind or block the new Goal');
  assert.equal(dispatches.length,3,'reading historical failure cannot dispatch another message');
}

// A historical sent copy must not move a fresh Goal or overwrite the exact
// completed Goal already stored at the previous destination.
{
  const url='https://chatgpt.com/c/goal-after-historical-success';
  const destination='https://chatgpt.com/c/previous-goal-destination';
  await waitingGoal(destination,13);
  const promptKey=new URL(destination).pathname+'|user';
  await goals.completion({url:destination,tabId:13,promptKey,completionKey:promptKey+'|assistant',
    response:'GOAL_COMPLETE',nativeVerified:true,rawExact:true});
  assert.equal(saved['chatgpt-goal:'+destination].phase,'completed');
  saved['chatgpt-handoff:12']={...record('historical-sent-handoff'),sourceUrl:url,targetUrl:destination,
    stage:'sent',acceptance:{messageId:'historical-accepted-user'}};
  await waitingGoal(url,12);
  const beforeSource=structuredClone(saved['chatgpt-goal:'+url]);
  const beforeTarget=structuredClone(saved['chatgpt-goal:'+destination]);
  const beforeDispatches=dispatches.length;
  const recovered=await handler({type:'CHATGPT_HANDOFF_GET'},12);
  assert.equal(recovered.record.id,'historical-sent-handoff');
  assert.deepEqual(saved['chatgpt-goal:'+url],beforeSource,'historical sent GET cannot move the fresh source Goal');
  assert.deepEqual(saved['chatgpt-goal:'+destination],beforeTarget,'historical sent GET cannot overwrite the destination Goal');
  assert.equal(dispatches.length,beforeDispatches);
}

// An exact in-progress binding can still finish from its durable sent record;
// subsequent GETs preserve the moved Goal and its target without more sends.
{
  const url='https://chatgpt.com/c/goal-exact-sent-replay';
  const destination='https://chatgpt.com/c/goal-exact-sent-target';
  await waitingGoal(url,14);
  await goals.handoffBegin({sourceUrl:url,handoffId:'exact-sent-handoff',tabId:14});
  saved['chatgpt-handoff:14']={...record('exact-sent-handoff'),sourceUrl:url,targetUrl:destination,
    stage:'sent',acceptance:{messageId:'exact-accepted-user'}};
  const beforeDispatches=dispatches.length;
  await handler({type:'CHATGPT_HANDOFF_GET'},14);
  assert.equal(saved['chatgpt-goal:'+url].phase,'moved');
  assert.equal(saved['chatgpt-goal:'+destination].handoffAcceptedUserId,'exact-accepted-user');
  const before=structuredClone(saved['chatgpt-goal:'+destination]);
  await handler({type:'CHATGPT_HANDOFF_GET'},14);
  assert.deepEqual(saved['chatgpt-goal:'+destination],before,'moved replay remains idempotent');
  assert.equal(dispatches.length,beforeDispatches);
}
console.log('Goal handoff: preparation safety, failed UPDATE, durable GET replay and legacy binding passed.');

{
 const url='https://chatgpt.com/c/completed-file-preparation',tabId=77;
 await waitingGoal(url,tabId);const prompt=new URL(url).pathname+'|user';
 await goals.completion({url,tabId,completionKey:prompt+'|done',promptKey:prompt,response:'GOAL_COMPLETE',nativeVerified:true,rawExact:true});
 assert.equal(saved['chatgpt-goal:'+url].phase,'completed');
 assert.equal((await goals.handoffPreparationReady({sourceUrl:url,handoffId:'ordinary-file-transfer',tabId})).ok,true,
  'an already completed Goal cannot strand an independent ordinary file handoff');
 assert.equal(saved['chatgpt-goal:'+url].phase,'completed','preparation recovery does not resume the old Goal');
}
