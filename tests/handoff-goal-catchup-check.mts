import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const worker=readFileSync('extension/service-worker.js','utf8');
const source=worker.slice(worker.indexOf('async function reconcileAcceptedHandoffGoal('),worker.indexOf('async function confirmNativeGoalSend('));
const url='https://chatgpt.com/c/handoff-catchup-fixture';
type V=Record<string,any>;
function fixture(){
 const goal:V={id:'goal',url,originUrl:'https://chatgpt.com/c/handoff-source',goal:'Complete test objective',rules:'',
 phase:'waiting',operation:null,handoffId:'handoff',handoffPending:true,handoffAcceptedUserId:'accepted-user',
 expectedPromptKey:null,startedAt:500,deadlineAt:100000,maxContinuations:10,maxMinutes:1440,continuations:2};
 const handoff:V={id:'handoff',stage:'sent',targetUrl:url,sendReceipt:{submittedText:'Exact sent history'},acceptance:{messageId:'accepted-user'}};
 const data:V={['chatgpt-goal:'+url]:goal,'chatgpt-handoff:7':handoff},messages:V[]=[],events:V[]=[];
 let live=url,after:(()=>void)|null=null;
 const native:V={ok:true,url,isLatest:true,isReadOnly:false,turnStatus:'complete',generating:false,hasError:false,
  userId:'accepted-user',userText:'Exact sent history',promptKey:'/c/handoff-catchup-fixture|user',assistantKey:'answer',assistantCompleted:true,assistantPhase:'final_answer',goalResponse:'Continue work',goalRawExact:false};
 const storage={get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))),set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url:live}),sendMessage:async(id:number,message:V)=>{messages.push(message);return {ok:true};}};
 const ctx=createContext({URL,console,handoffKey:(id:number)=>'chatgpt-handoff:'+id,inspectCompletedTurn:function(){},
  chrome:{storage:{local:storage},tabs,scripting:{executeScript:async()=>{const result=structuredClone(native);after?.();return[{result}];}}}});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.deps={storage,tabs,appendJournal:async(e:V)=>{events.push(e);return{ok:true};},now:()=>1000,uuid:()=> 'operation'};
 const store=runInContext('ChatGPTGoalStore.create(deps)',ctx);ctx.goalController=store;
 runInContext(source,ctx);
 return{data,goal,handoff,native,messages,events,run:()=>runInContext(`reconcileAcceptedHandoffGoal(7,'${url}')`,ctx),waiting:()=>runInContext(`reconcileWaitingGoalAnswer(7,'${url}')`,ctx),after:(f:()=>void)=>{after=f;},route:(u:string)=>{live=u;}};
}
{
 const h=fixture();await h.run();
 assert.equal(h.data['chatgpt-goal:'+url].phase,'preparing');assert.equal(h.messages.length,1);
 assert.equal(h.events.filter(e=>e.kind==='goal.answer_continue').length,1);
 await h.run();assert.equal(h.messages.length,1,'a processed answer never triggers another dispatch');
}
{
 const h=fixture();Object.assign(h.native,{goalResponse:'GOAL_COMPLETE',goalRawExact:true});await h.run();
 assert.equal(h.data['chatgpt-goal:'+url].phase,'completed');assert.equal(h.messages.length,0);
}
for(const patch of [{generating:true},{turnStatus:'in_progress'},{hasError:true},{assistantCompleted:false},
 {assistantPhase:'commentary'},{userText:'Wrong history'},{userId:'another-user'},{isLatest:false},{isReadOnly:true}]){
 const h=fixture();Object.assign(h.native,patch);await h.run();assert.equal(h.messages.length,0);
 assert.equal(h.data['chatgpt-goal:'+url].phase,'waiting');
}
for(const scenario of ['unknown-send','different-handoff','wrong-target','stopped','changed-goal','route-race']){
 const h=fixture();
 if(scenario==='unknown-send')h.handoff.stage='awaiting-confirmation';
 if(scenario==='different-handoff')h.handoff.id='another';
 if(scenario==='wrong-target')h.handoff.targetUrl='https://chatgpt.com/c/another';
 if(scenario==='stopped')h.goal.phase='stopped';
 if(scenario==='changed-goal')h.after(()=>h.goal.id='replaced');
 if(scenario==='route-race')h.after(()=>h.route('https://chatgpt.com/c/another'));
 await h.run();assert.equal(h.messages.length,0,scenario);
}
console.log('Handoff Goal catch-up: exact accepted native completion, marker/one continuation, unknown-send/stop/route/state fences passed.');

{
 const h=fixture();
 Object.assign(h.goal,{handoffPending:false,expectedPromptKey:h.native.promptKey});
 assert.equal((await h.waiting()).ok,true);
 assert.equal(h.messages.length,1,'a missed native answer reserves and dispatches one continuation');
 await h.waiting();assert.equal(h.messages.length,1);
}
for(const patch of [{generating:true},{promptKey:'wrong'},{hasError:true},{isLatest:false},{assistantPhase:'commentary'}]){
 const h=fixture();
 Object.assign(h.goal,{handoffPending:false,expectedPromptKey:h.native.promptKey});
 Object.assign(h.native,patch);
 await h.waiting();assert.equal(h.messages.length,0);
}
console.log('Waiting Goal catch-up: missed matching final answer resumes once, unrelated or unfinished answers do not dispatch.');
