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
 const native:V={ok:true,isLatest:true,isReadOnly:false,promptKey:'/c/preparation-recovery-fixture|previous',userId:'previous-user',turnStatus:'complete',generating:false,hasError:false,assistantCompleted:true,assistantPhase:'final_answer'};
 const editor:V={ok:true};function inspectCompletedTurn(){}function controlChatComposer(){}
 let idle=true,live=url,after:(()=>void)|null=null,failReplacement=false;
 const storage={get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>{if(failReplacement&&v['chatgpt-goal:'+url]?.phase==='preparing'){failReplacement=false;throw Error('Replacement write failed');}return Object.assign(data,structuredClone(v));}};
 const tabs={get:async()=>({id:7,url:live}),sendMessage:async(id:number,m:V)=>{
  if(m.type==='CHATGPT_GOAL_READINESS'){after?.();return {ok:true,idle};}
  messages.push(m);return {ok:true};
 }};
 const ctx=createContext({URL,console,inspectCompletedTurn,controlChatComposer,readJournal:async()=>({ok:true,meta:{...structuredClone(data['chatgpt-journal:meta']),sequence:journal.length},events:structuredClone(journal)}),JOURNAL_META:'chatgpt-journal:meta',chrome:{storage:{local:storage},tabs,scripting:{executeScript:async({func}:V)=>[{result:structuredClone(func===inspectCompletedTurn?native:editor)}]}}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.appendJournal=async(e:V)=>{events.push(e);journal.push({...e,tabId:7,sequence:journal.length+1});delete data['chatgpt-journal:meta'].active[7];return {ok:true};};
 ctx.deps={storage,tabs,appendJournal:async(e:V)=>{events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'unused'};
 ctx.goalController=runInContext('ChatGPTGoalStore.create(deps)',ctx);
 runInContext(helper,ctx);
 return {goal,data,messages,events,journal,native,editor,failReplacement:()=>{failReplacement=true;},run:()=>runInContext(`reconcileGoalPreparation(7,'${url}')`,ctx),idle:(v:boolean)=>{idle=v;},route:(v:string)=>{live=v;},after:(f:()=>void)=>{after=f;}};
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
function restartedIntent(){
 const f=fixture();f.goal.reason='Неподтверждённая отправка пережила перезапуск; автоматический повтор запрещён';
 f.goal.expectedPromptKey=f.native.promptKey;Object.assign(f.goal.operation,{status:'intent',baselineKey:f.native.promptKey});
 f.data['chatgpt-journal:meta'].active[7]={kind:'goal.send_intent',goalId:'goal',operationId:'unspent-operation',chatUrl:url};
 f.journal.unshift({sequence:1,kind:'goal.send_intent',operationId:'unspent-operation'});
 f.journal.forEach((e,i)=>e.sequence=i+1);return f;
}
{
 const f=restartedIntent();await f.run();assert.equal(f.messages.length,1,'untouched unconsumed restart intent safely resumes');
 assert.ok(f.events.some(e=>e.kind==='goal.unsent_release'));await f.run();assert.equal(f.messages.length,1);
}
for(const scenario of ['draft-saved','draft-replaced','clicked','authorized','different-prompt','generating','error','editor','newer-request','stopped']){
 const f=restartedIntent();
 if(['draft-saved','draft-replaced','clicked','authorized'].includes(scenario))f.journal.push({sequence:f.journal.length+1,operationId:'unspent-operation',kind:{'draft-saved':'draft.saved','draft-replaced':'draft.replaced',clicked:'goal.clicked',authorized:'send.authorized'}[scenario]});
 if(scenario==='different-prompt')f.native.promptKey='other';
 if(scenario==='generating')f.native.generating=true;
 if(scenario==='error')f.native.hasError=true;
 if(scenario==='editor')f.editor.ok=false;
 if(scenario==='newer-request')f.journal.push({sequence:f.journal.length+1,kind:'request.started',sourceUrl:url,eventAt:300});
 if(scenario==='stopped')f.goal.stopRequested=true;
 await f.run();assert.equal(f.messages.length,0,scenario);
}
console.log('Restarted unconsumed intent: exact completed previous turn and untouched empty editor recover once; uncertain sends and drafts remain fenced.');

{
 const f=restartedIntent();f.journal.splice(f.journal.findIndex(e=>e.kind==='goal.dispatch_failed'),1);f.journal.forEach((e,i)=>e.sequence=i+1);
 await f.run();assert.equal(f.messages.length,1,'pre-grant restart has no dispatch callback to depend on');
}
{
 const f=restartedIntent();f.failReplacement();await assert.rejects(()=>f.run(),/Replacement write failed/);
 assert.equal(f.data['chatgpt-journal:meta'].active[7],undefined);assert.equal(f.messages.length,0);
 await f.run();assert.equal(f.messages.length,1,'committed release survives failed replacement write');
 assert.equal(f.events.filter(e=>e.kind==='goal.unsent_release').length,1,'recovery never writes the consumed release twice');
}
for(const scenario of ['wrong-goal','wrong-tab','wrong-url','duplicate','later-send','foreign-grant']) {
 const f=restartedIntent();f.failReplacement();await assert.rejects(()=>f.run(),/Replacement write failed/);
 const release=f.journal.find(e=>e.kind==='goal.unsent_release')!;
 if(scenario==='wrong-goal')release.goalId='other';
 if(scenario==='wrong-tab')release.tabId=8;
 if(scenario==='wrong-url')release.sourceUrl='https://chatgpt.com/c/other';
 if(scenario==='duplicate')f.journal.push({...release,sequence:f.journal.length+1});
 if(scenario==='later-send')f.journal.push({kind:'request.started',sourceUrl:url,eventAt:300,sequence:f.journal.length+1});
 if(scenario==='foreign-grant')f.data['chatgpt-journal:meta'].active[8]={operationId:'other',chatUrl:url};
 await f.run();assert.equal(f.messages.length,0,scenario+' cannot consume a released preparation');
}

{
 const f=fixture();f.journal.pop();await f.run();assert.equal(f.messages.length,0,'ordinary no-click preparation still needs dispatch-failure evidence');
}
