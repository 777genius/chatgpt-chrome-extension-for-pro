import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
type V=Record<string,any>;
const url='https://chatgpt.com/c/missing-input-fixture',prefix='/c/missing-input-fixture|';
const worker=readFileSync('extension/service-worker.js','utf8'),helper=worker.slice(worker.indexOf('async function restoreMissingComposerGoal('),worker.indexOf('async function bindNativeComposerGoal('));
async function fixture(witness=false){
 const data:V={},journal:V[]=[],dispatched:V[]=[];let live=url,clock=1000,after:(()=>void)|null=null;
 const users=[{userId:'follow-1',userText:'First sent clarification',userSentAtMs:20000,promptKey:prefix+'first'},
  {userId:'follow-2',userText:'Second sent clarification',userSentAtMs:40000,promptKey:prefix+'second'}];
 const native:V={ok:true,url,isLatest:true,isReadOnly:false,...users[1],firstServerMessageId:'server-alias',firstTurnMessageIds:['original-native-user'],firstTurnResponseConfirmed:true,
  turnStatus:'in_progress',generating:true,hasError:false};
 const history:V={...native,recoveryTimeline:users};
 const events:V[]=[{kind:'request.started',tabId:7,sourceUrl:'https://chatgpt.com/',requestId:'root-request',eventAt:1100},
  {kind:'tab.updated',tabId:7,sourceUrl:url,changes:{url},recordedAt:1200},
  ...users.map((u,i)=>({kind:'request.started',tabId:7,sourceUrl:url,requestId:'follow-request-'+i,eventAt:u.userSentAtMs}))];
 events.forEach((e,i)=>{e.sequence=i+1;});
 const ctx=createContext({URL,Date,console,readJournal:async()=>({ok:true,meta:{sequence:events.length},events:structuredClone(events)}),inspectCompletedTurn:function(){},
  chrome:{tabs:{get:async()=>({id:7,url:live})},scripting:{executeScript:async({args}:V)=>{const result=structuredClone(args.length>2?history:native);after?.();return [{result}];}}}});
 for(const file of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+file,'utf8'),ctx);
 ctx.deps={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))},
  tabs:{get:async()=>({id:7,url:live}),sendMessage:async(id:number,m:V)=>{dispatched.push(m);return {ok:true};}},
  appendJournal:async(e:V)=>{journal.push(e);return {ok:true};},now:()=>clock,uuid:()=> 'root-arm'};
 const store=runInContext('ChatGPTGoalStore.create(deps)',ctx);ctx.goalController=store;
 await store.composerArm({tabId:7,url:'https://chatgpt.com/',rules:'Original criteria',maxContinuations:10,maxMinutes:1440});
 await store.composerIntent({tabId:7,url:'https://chatgpt.com/',armId:'root-arm',eventAt:1000,text:'Exact original objective',baselineKey:''});
 await store.composerRequest({tabId:7,armId:'root-arm',requestId:'root-request',startedAt:1100,url:'https://chatgpt.com/',
  ...(witness?{submission:{userId:'original-native-user',userText:'Exact original objective'}}:{})});
 clock=50000;runInContext(helper,ctx);
 return {data,events,journal,dispatched,native,history,store,users,time:(v:number)=>{clock=v;},after:(fn:()=>void)=>{after=fn;},route:(v:string)=>{live=v;},
  recover:(confirmed=false)=>runInContext(`restoreMissingComposerGoal(7,'${url}','root-arm',${confirmed})`,ctx)};
}
{
 const f=await fixture();assert.equal((await f.recover()).pending,true);assert.equal(f.data['chatgpt-goal:'+url],undefined,'legacy intent alone grants no automatic recovery');
 const r=await f.recover(true),g=f.data['chatgpt-goal:'+url];assert.equal(r.ok,true);assert.equal(g.phase,'waiting');
 assert.equal(g.goal,'Exact original objective');assert.equal(g.rules,'Original criteria');assert.equal(g.startedAt,1100);
 assert.equal(g.deadlineAt,1100+1440*60000);assert.equal(g.continuations,0);assert.equal(g.maxContinuations,10);
 assert.deepEqual(g.supplements.map((x:V)=>x.userText),f.users.map(x=>x.userText));assert.equal(g.expectedPromptKey,prefix+'second');
 assert.equal(g.restoredIntent.confirmation,'explicit-user');assert.equal(f.dispatched.length,0,'active response is observed, not interrupted or duplicated');
 await f.recover(true);assert.equal(f.journal.filter(e=>e.kind==='goal.composer_restored').length,1,'a consumed arm cannot restore twice');
}
{
 const f=await fixture(true);assert.equal((await f.recover()).ok,true);assert.equal(f.data['chatgpt-goal:'+url].restoredIntent.confirmation,'request-body');
}
for(const marker of [false,true]){
 const f=await fixture();Object.assign(f.native,{turnStatus:'complete',generating:false,assistantCompleted:true,assistantPhase:'final_answer',
  assistantKey:'final-answer',goalResponse:marker?'GOAL_COMPLETE':'Work remains',goalRawExact:marker});
 await f.recover(true);assert.equal(f.data['chatgpt-goal:'+url].phase,marker?'completed':'preparing');
 assert.equal(f.dispatched.length,marker?0:1,'only one normal guarded continuation, never replay the original send');
 if(!marker)assert.match(f.dispatched[0].text,/Exact original objective/);
}
for(const scenario of ['wrong-allocation','ambiguous-root','unknown-followup','missing-followup','missing-history','server-id','route-race','disarm-race','different-current-user']){
 const f=await fixture(true);
 if(scenario==='wrong-allocation')f.events[1].changes.url='https://chatgpt.com/c/other';
 if(scenario==='ambiguous-root')f.events.push({...f.events[0]});
 if(scenario==='unknown-followup')f.events[2].operationId='unknown-send';
 if(scenario==='missing-followup')f.events.pop();
 if(scenario==='missing-history')f.history.recoveryTimeline=null;
 if(scenario==='server-id')f.native.firstTurnMessageIds=['different-user'];
 if(scenario==='route-race')f.route('https://chatgpt.com/c/other');
 if(scenario==='disarm-race')f.after(()=>{f.data['chatgpt-goal-composer:7'].phase='disabled';});
 if(scenario==='different-current-user')f.native.userId='new-user';
 assert.equal((await f.recover()).pending,true,scenario);assert.equal(f.data['chatgpt-goal:'+url],undefined,scenario);assert.equal(f.dispatched.length,0);
}
{
 const f=await fixture();f.time(1100+1440*60000+1);await f.recover(true);assert.equal(f.data['chatgpt-goal:'+url].phase,'stopped');
 assert.equal(f.dispatched.length,0,'explicit recovery preserves the original expired deadline');
}
console.log('Missing first Goal input: explicit legacy recovery or exact body/server-ID witness, original objective/limits/follow-ups, no original replay, marker and race fences passed.');
