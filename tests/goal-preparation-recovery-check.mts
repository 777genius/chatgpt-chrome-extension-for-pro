import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/preparation-recovery-fixture';
const worker=readFileSync('extension/service-worker.js','utf8');
const helper=worker.slice(worker.indexOf('async function reconcileGoalPreparation('),worker.indexOf('async function confirmNativeGoalSend('));
type V=Record<string,any>;
function fixture(){
 const goal:V={schema:1,id:'goal',url,goal:'Complete objective',phase:'blocked',reason:'Editor unavailable',maxContinuations:10,maxMinutes:1440,
  startedAt:100,deadlineAt:100000,continuations:2,operation:{id:'unspent-operation',tabId:7,status:'reserved',kind:'continuation',text:'Exact continuation',createdAt:200}};
 const data:V={['chatgpt-goal:'+url]:goal,'chatgpt-journal:meta':{active:{}}},messages:V[]=[],events:V[]=[];
 const journal:V[]=[{sequence:1,kind:'goal.blocked',operationId:'unspent-operation'},{sequence:2,kind:'goal.dispatch_failed',operationId:'unspent-operation'}];
 let idle=true,live=url,after:(()=>void)|null=null;
 const storage={get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url:live}),sendMessage:async(id:number,m:V)=>{
  if(m.type==='CHATGPT_GOAL_READINESS'){after?.();return {ok:true,idle};}
  messages.push(m);return {ok:true};
 }};
 const ctx=createContext({URL,console,readJournal:async()=>({ok:true,meta:{...structuredClone(data['chatgpt-journal:meta']),sequence:journal.length},events:structuredClone(journal)}),JOURNAL_META:'chatgpt-journal:meta',chrome:{storage:{local:storage},tabs}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.appendJournal=async(e:V)=>{events.push(e);delete data['chatgpt-journal:meta'].active[7];return {ok:true};};
 ctx.deps={storage,tabs,appendJournal:async(e:V)=>{events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'unused'};
 ctx.goalController=runInContext('ChatGPTGoalStore.create(deps)',ctx);
 runInContext(helper,ctx);
 return {goal,data,messages,events,journal,run:()=>runInContext(`reconcileGoalPreparation(7,'${url}')`,ctx),idle:(v:boolean)=>{idle=v;},route:(v:string)=>{live=v;},after:(f:()=>void)=>{after=f;}};
}
{
 const f=fixture();f.idle(false);await f.run();assert.equal(f.messages.length,0);
 f.idle(true);await f.run();assert.equal(f.messages.length,1);assert.equal(f.messages[0].operationId,'unused');
 const g=f.data['chatgpt-goal:'+url];assert.equal(g.phase,'preparing');assert.equal(g.deadlineAt,100000);
 assert.equal(g.continuations,2);assert.equal(g.operation.createdAt,1000);
 await f.run();assert.equal(f.messages.length,1,'one original reservation cannot be redelivered after it resumes');
}
for(const scenario of ['intent','clicked','paused','stopped','pause-requested','stop-requested','manual-pending','manual-override','expired','active-grant','other-tab-grant','other-chat-owner','route-race','state-race','journal-race']){
 const f=fixture();
 if(scenario==='intent'||scenario==='clicked'){f.goal.operation.status=scenario;f.journal.length=0;}
 if(scenario==='paused'||scenario==='stopped')f.goal.phase=scenario;
 if(scenario==='pause-requested')f.goal.pauseRequested=true;
 if(scenario==='stop-requested')f.goal.stopRequested=true;
 if(scenario==='manual-pending')f.goal.manualPending={requestId:'user-request'};
 if(scenario==='manual-override')f.goal.manualOverride=true;
 if(scenario==='expired')f.goal.deadlineAt=999;
 if(scenario==='active-grant')f.data['chatgpt-journal:meta'].active[7]={operationId:'another'};
 if(scenario==='other-tab-grant')f.data['chatgpt-journal:meta'].active[9]={operationId:f.goal.operation.id};
 if(scenario==='other-chat-owner')f.data['chatgpt-journal:meta'].active[9]={operationId:'older-operation',chatUrl:url};
 if(scenario==='journal-race')f.after(()=>{f.data['chatgpt-journal:meta'].active[7]={operationId:'another'};});
 if(scenario==='route-race')f.after(()=>f.route('https://chatgpt.com/c/other'));
 if(scenario==='state-race')f.after(()=>f.goal.phase='stopped');
 await f.run();assert.equal(f.messages.length,0,scenario);
}
console.log('Goal preparation recovery: idle-only unspent reservation, unchanged budget/deadline, intent/click/stop/manual/journal/route fences passed.');

{
 const f=fixture();f.goal.operation.status='intent';

 await f.run();assert.equal(f.messages.length,1,'an intent refused before journal admission has never received a click grant');
 assert.equal(f.data['chatgpt-goal:'+url].operation.id,'unused');
 assert.equal(f.data['chatgpt-goal:'+url].continuations,2);
}
for(const kind of ['goal.send_intent','send.authorized','send.dispatched','request.started','gap','newer-manual']) {
 const f=fixture();f.goal.operation.status='intent';

 if(kind==='gap')f.journal[0].sequence=0;
 else f.journal.push({sequence:3,kind:kind==='newer-manual'?'request.started':kind,
  operationId:kind==='newer-manual'?null:f.goal.operation.id,sourceUrl:url,eventAt:300});
 await f.run();assert.equal(f.messages.length,0,kind+' must preserve the fence');
}

{
 const f=fixture();
 f.journal.push({sequence:3,kind:'request.started',sourceUrl:url,eventAt:300});
 await f.run();
 assert.equal(f.messages.length,0,'a later user request prevents replay of a reserved continuation');
}

{
 const f=fixture();f.goal.operation.status='intent';
 f.data['chatgpt-journal:meta'].active[7]={kind:'goal.send_intent',goalId:'goal',operationId:'unspent-operation',chatUrl:url};
 f.journal.push({sequence:3,kind:'goal.send_intent',operationId:'unspent-operation'},
   {sequence:4,kind:'draft.not_clicked',operationId:'unspent-operation'});
 await f.run();
 assert.equal(f.messages.length,1,'proven unconsumed intent is released and receives a new operation');
 assert.equal(f.messages[0].operationId,'unused');
 assert.ok(f.events.some(e=>e.kind==='goal.unsent_release'));
}
{
 const f=fixture();f.goal.operation.status='intent';
 f.data['chatgpt-journal:meta'].active[7]={kind:'goal.send_intent',goalId:'goal',operationId:'unspent-operation',chatUrl:url,consumed:true};
 f.journal.push({sequence:3,kind:'goal.send_intent',operationId:'unspent-operation'},
   {sequence:4,kind:'draft.not_clicked',operationId:'unspent-operation'});
 await f.run();assert.equal(f.messages.length,0,'consumed grant stays fenced');
}
