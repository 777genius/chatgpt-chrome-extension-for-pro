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
 let idle=true,live=url,after:(()=>void)|null=null;
 const storage={get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url:live}),sendMessage:async(id:number,m:V)=>{
  if(m.type==='CHATGPT_GOAL_READINESS'){after?.();return {ok:true,idle};}
  messages.push(m);return {ok:true};
 }};
 const ctx=createContext({URL,console,JOURNAL_META:'chatgpt-journal:meta',chrome:{storage:{local:storage},tabs}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.deps={storage,tabs,appendJournal:async(e:V)=>{events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'unused'};
 ctx.goalController=runInContext('ChatGPTGoalStore.create(deps)',ctx);
 runInContext(helper,ctx);
 return {goal,data,messages,events,run:()=>runInContext(`reconcileGoalPreparation(7,'${url}')`,ctx),idle:(v:boolean)=>{idle=v;},route:(v:string)=>{live=v;},after:(f:()=>void)=>{after=f;}};
}
{
 const f=fixture();f.idle(false);await f.run();assert.equal(f.messages.length,0);
 f.idle(true);await f.run();assert.equal(f.messages.length,1);assert.equal(f.messages[0].operationId,'unspent-operation');
 const g=f.data['chatgpt-goal:'+url];assert.equal(g.phase,'preparing');assert.equal(g.deadlineAt,100000);
 assert.equal(g.continuations,2);assert.equal(g.operation.createdAt,1000);
 await f.run();assert.equal(f.messages.length,1,'one original reservation cannot be redelivered after it resumes');
}
for(const scenario of ['intent','clicked','paused','stopped','pause-requested','stop-requested','manual-pending','manual-override','expired','active-grant','other-tab-grant','route-race','state-race','journal-race']){
 const f=fixture();
 if(scenario==='intent'||scenario==='clicked')f.goal.operation.status=scenario;
 if(scenario==='paused'||scenario==='stopped')f.goal.phase=scenario;
 if(scenario==='pause-requested')f.goal.pauseRequested=true;
 if(scenario==='stop-requested')f.goal.stopRequested=true;
 if(scenario==='manual-pending')f.goal.manualPending={requestId:'user-request'};
 if(scenario==='manual-override')f.goal.manualOverride=true;
 if(scenario==='expired')f.goal.deadlineAt=999;
 if(scenario==='active-grant')f.data['chatgpt-journal:meta'].active[7]={operationId:'another'};
 if(scenario==='other-tab-grant')f.data['chatgpt-journal:meta'].active[9]={operationId:f.goal.operation.id};
 if(scenario==='journal-race')f.after(()=>{f.data['chatgpt-journal:meta'].active[7]={operationId:'another'};});
 if(scenario==='route-race')f.after(()=>f.route('https://chatgpt.com/c/other'));
 if(scenario==='state-race')f.after(()=>f.goal.phase='stopped');
 await f.run();assert.equal(f.messages.length,0,scenario);
}
console.log('Goal preparation recovery: idle-only unspent reservation, unchanged budget/deadline, intent/click/stop/manual/journal/route fences passed.');
