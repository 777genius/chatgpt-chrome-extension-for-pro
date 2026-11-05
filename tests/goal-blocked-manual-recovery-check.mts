import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
type V=Record<string,any>;
const source='https://chatgpt.com/c/blocked-source',target='https://chatgpt.com/c/manual-target';
const worker=readFileSync('extension/service-worker.js','utf8');
const code=worker.slice(worker.indexOf('async function reconcileBlockedManualHandoff('),worker.indexOf('async function bindNativeComposerGoal('));
function fixture() {
 const time=Date.now(),events:V[]=[],messages:V[]=[];let changeJournal=false,journalReads=0;
 const old:V={id:'goal',url:source,originUrl:source,phase:'blocked',reason:'Передача Goal остановлена: Не удалось дождаться готовности нового чата',
  handoffId:'handoff',handoffTabId:7,preHandoffPhase:'waiting',startedAt:time-10000,deadlineAt:time+60000,
  goal:'Original objective',rules:'Keep criteria',maxContinuations:30,continuations:4,maxMinutes:1440,operation:null};
 const witness={requestId:'manual',startedAt:time-1000,url:'https://chatgpt.com/',userId:'user-id',userText:'Continue the saved task'};
 const composer:V={id:'goal',phase:'bound',binding:{url:source},blockedFollowups:[witness]};
 const data:V={['chatgpt-goal:'+source]:old,'chatgpt-goal-composer:7':composer};
 const journal:V[]=[
  {kind:'handoff.navigating',sourceUrl:source,operationId:'handoff',text:'Saved source history'},
  {kind:'handoff.failed',sourceUrl:source,operationId:'handoff',reason:'Не удалось дождаться готовности нового чата'},
  {kind:'request.started',sourceUrl:'https://chatgpt.com/',operationId:null,requestId:'manual',eventAt:witness.startedAt},
  {kind:'tab.updated',operationId:null,changes:{url:target}}
 ].map((e,i)=>({...e,tabId:7,sequence:i+1}));
 const native:V={ok:true,url:target,isLatest:true,isReadOnly:false,userId:witness.userId,userText:witness.userText,
  userSentAtMs:witness.startedAt,promptKey:'/c/manual-target|user',turnStatus:'complete',generating:false,
  hasError:false,assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'answer',goalResponse:'Work remains',goalRawExact:false};
 const storage={get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url:target}),sendMessage:async(_id:number,m:V)=>{messages.push(m);return {ok:true};}};
 const ctx=createContext({URL,Date,console,chrome:{storage:{local:storage},tabs,scripting:{executeScript:async()=>[{result:structuredClone(native)}]}},
  readJournal:async()=>({ok:true,meta:{sequence:journal.length+(changeJournal&&++journalReads>1?1:0)},events:structuredClone(journal)}),inspectCompletedTurn:()=>{}});
 for(const f of ['goal-policy.js','goal-lineage.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.deps={storage,tabs,appendJournal:async(e:V)=>{events.push(e);return{ok:true};},now:()=>Date.now(),uuid:()=> 'new-operation'};
 ctx.goalController=runInContext('ChatGPTGoalStore.create(deps)',ctx);runInContext(code,ctx);
 return {data,old,composer,witness,journal,native,messages,events,changeJournal:()=>{changeJournal=true;},run:()=>runInContext(`reconcileBlockedManualHandoff(7,'${target}')`,ctx)};
}
{
 const f=fixture();assert.equal((await f.run()).ok,true);
 const g=f.data['chatgpt-goal:'+target];assert.equal(g.id,'goal');assert.equal(g.continuations,4);assert.equal(g.deadlineAt,f.old.deadlineAt);
 assert.equal(g.supplements[0].userText,'Continue the saved task');assert.equal(f.messages.length,1);
 assert.match(f.messages[0].text,/Original objective/);await f.run();assert.equal(f.messages.length,1);
}
for(const scenario of ['missing-witness','wrong-user','unknown-send','paused','stopped','unrelated-goal','different-route','stale-journal','journal-race']) {
 const f=fixture();
 if(scenario==='missing-witness')f.composer.blockedFollowups=[];
 if(scenario==='wrong-user')f.native.userId='someone-else';
 if(scenario==='unknown-send')f.journal.splice(1,0,{kind:'send.dispatched',operationId:'handoff',tabId:7,sequence:1.5});
 if(scenario==='paused')f.old.pauseRequested=true;
 if(scenario==='stopped')f.old.stopRequested=true;
 if(scenario==='unrelated-goal')f.data['chatgpt-goal:'+target]={id:'other',phase:'waiting'};
 if(scenario==='different-route')f.native.url=source;
 if(scenario==='stale-journal')f.journal[3].sequence=9;
 if(scenario==='journal-race')f.changeJournal();
 try{await f.run();}catch{}
 assert.equal(f.data['chatgpt-goal:'+source].phase,'blocked',scenario);assert.equal(f.messages.length,0,scenario);
}
console.log('Bound Goal manual recovery: exact journal/body/native proof, one continuation and unsafe-state fences passed.');
