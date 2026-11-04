import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const worker=readFileSync('extension/service-worker.js','utf8');
const source=worker.slice(worker.indexOf('async function recoverNativeComposerGoal('),worker.indexOf('async function bindNativeComposerGoal('));
const url='https://chatgpt.com/c/late-recovery-fixture';
type V=Record<string,any>;
async function fixture(){
 const data:V={},events:V[]=[],messages:V[]=[];
 let journalError=false;
 let live=url,afterProbe:(()=>Promise<void>|void)|null=null,failSave=false;
 const users=[{userId:'initial',userText:'Original objective',userSentAtMs:100011,promptKey:'/c/late-recovery-fixture|initial'},
 {userId:'follow-one',userText:'First clarification',userSentAtMs:140000,promptKey:'/c/late-recovery-fixture|follow-one'},
 {userId:'follow-two',userText:'Second clarification',userSentAtMs:180000,promptKey:'/c/late-recovery-fixture|follow-two'}];
 const requests:V[]=users.map((u,i)=>({kind:'request.started',tabId:7,requestId:'request-'+i,eventAt:u.userSentAtMs,
  sourceUrl:i===0?'https://chatgpt.com/':url,operationId:null}));
 const original:V={ok:true,url,isReadOnly:false,isLatest:false,...users[0],userVisibleText:'Original objective\n',firstTurn:false,recoveryTimeline:users};
 const latest:V={ok:true,url,isReadOnly:false,isLatest:true,...users[2],turnStatus:'in_progress',generating:true,hasError:false};
 const ctx=createContext({URL,Date,console,latestRequestReceipt:async()=>({requestId:requests.at(-1)!.requestId,startedAt:requests.at(-1)!.eventAt,url}),readJournal:async()=>({ok:true,storageError:journalError?'Disk full':'',events:requests}),inspectCompletedTurn:function(){},
  chrome:{tabs:{get:async()=>({id:7,url:live})},scripting:{executeScript:async({args}:V)=>{
   const result=structuredClone(args.length>2?original:latest);await afterProbe?.();return [{result}];
  }}}});
 for(const file of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+file,'utf8'),ctx);
 ctx.dependencies={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>{if(failSave&&v['chatgpt-goal:'+url])throw Error('Synthetic disk failure');Object.assign(data,structuredClone(v));}},
  tabs:{get:async()=>({id:7,url:live}),sendMessage:async(id:number,message:V)=>{messages.push({id,message});return {ok:true};}},
  appendJournal:async(e:V)=>{events.push(structuredClone(e));return {ok:true};},now:()=>200000,uuid:()=> 'late-arm'};
 const store=runInContext('ChatGPTGoalStore.create(dependencies)',ctx);ctx.goalController=store;
 const arm=await store.composerArm({tabId:7,url:'https://chatgpt.com/',maxContinuations:10,maxMinutes:1440});
 // Build a historical intent with the same production acceptance checks.
 ctx.dependencies.now=()=>100010;
 // Store captures dependencies at creation, so use a fresh historical instance.
 const historical=runInContext('ChatGPTGoalStore.create({...dependencies,now:()=>100010})',ctx);
 data['chatgpt-goal-composer:7'].armedAt=100000;
 await historical.composerIntent({tabId:7,url:'https://chatgpt.com/',armId:arm.record.id,eventAt:100010,text:'Original objective',baselineKey:''});
 const pending=structuredClone(data['chatgpt-goal-composer:7']);ctx.pending=pending;
 runInContext(source,ctx);
 runInContext(worker.slice(worker.indexOf('async function bindNativeComposerGoal('),worker.indexOf('// An initial native conversation')),ctx);
 return {data,events,messages,users,requests,original,latest,store,pending,
  recover:()=>runInContext(`recoverNativeComposerGoal(7,'${url}',pending)`,ctx),
  bind:()=>runInContext(`bindNativeComposerGoal(7,'${url}',pending.id)`,ctx),
  journalError:()=>{journalError=true;},
  route:(v:string)=>{live=v;},after:(f:()=>Promise<void>|void)=>{afterProbe=f;},failSave:(value:boolean)=>{failSave=value;}};
}
{
 const f=await fixture(),r=await f.recover(),g=f.data['chatgpt-goal:'+url];
 assert.equal(r.ok,true);assert.equal(g.goal,'Original objective');assert.equal(g.startedAt,100011);
 assert.equal(g.deadlineAt,100011+1440*60000);assert.equal(g.maxContinuations,10);assert.equal(g.continuations,0);
 assert.deepEqual(g.supplements.map((s:V)=>s.text),['First clarification','Second clarification']);
 assert.equal(g.expectedPromptKey,f.users[2].promptKey);assert.equal(g.manualStartedAt,180000);
 assert.equal(f.messages.length,0,'a live response cannot trigger another send');
 assert.equal((await f.recover()).pending,true);assert.equal(f.messages.length,0,'atomic recovery is not replayed');
 assert.equal(f.events.filter(e=>e.kind==='goal.manual_started').length,1);
}
for(const marker of [false,true]){
 const f=await fixture();Object.assign(f.latest,{turnStatus:'complete',generating:false,assistantCompleted:true,
  assistantPhase:'final_answer',assistantKey:'latest-answer',goalResponse:marker?'GOAL_COMPLETE':'Still working',goalRawExact:marker});
 await f.recover();const g=f.data['chatgpt-goal:'+url];
 assert.equal(g.phase,marker?'completed':'preparing');
 assert.equal(f.messages.length,marker?0:1,'only the latest complete response can dispatch once');
 assert.equal(f.events.filter(e=>e.kind==='goal.answer_continue').length,marker?0:1);
}
for(const scenario of ['ambiguous-request','missing-followup','hidden-history','wrong-first','readonly','route-race','disarm-race']){
 const f=await fixture();
 if(scenario==='ambiguous-request')f.requests.push({...f.requests[0],requestId:'ambiguous'});
 if(scenario==='missing-followup')f.requests.splice(1,1);
 if(scenario==='hidden-history')f.original.recoveryTimeline=null;
 if(scenario==='wrong-first')f.original.recoveryTimeline=f.users.slice(1);
 if(scenario==='readonly')f.latest.isReadOnly=true;
 if(scenario==='route-race')f.after(()=>f.route('https://chatgpt.com/c/elsewhere'));
 if(scenario==='disarm-race')f.after(()=>f.store.composerDisarm({tabId:7}));
 assert.equal((await f.recover()).pending,true,scenario);
 assert.equal(f.data['chatgpt-goal:'+url],undefined,scenario);assert.equal(f.messages.length,0,scenario);
}
{
 const f=await fixture();f.requests[2].eventAt=139999;
 assert.equal((await f.recover()).pending,true);
 assert.equal(f.data['chatgpt-goal:'+url],undefined);assert.equal(f.messages.length,0);
}
{
 const f=await fixture();f.data['chatgpt-goal:'+url]={id:'another-goal',phase:'waiting'};
 await assert.rejects(()=>f.recover(),/уже запущена цель/);
 assert.equal(f.data['chatgpt-goal:'+url].id,'another-goal');assert.equal(f.messages.length,0);
}
{
 const f=await fixture();f.failSave(true);
 await assert.rejects(()=>f.recover(),/disk failure/);
 assert.equal(f.data['chatgpt-goal:'+url],undefined);
 assert.equal(f.data['chatgpt-goal-composer:7'].phase,'intent');assert.equal(f.messages.length,0);
 f.failSave(false);await f.recover();
 assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2,'retrying an uncommitted state write preserves all context');
 assert.equal(f.messages.length,0);
}
console.log('Late Goal recovery: atomic original+all supplements, original limits/deadline, latest-only dispatch, marker, duplicate/request/route/disarm/history fences passed.');

{
 const f=await fixture();
 f.users[2].userSentAtMs=140005;f.requests[2].eventAt=140005;
 f.latest.userSentAtMs=140005;
 const result=await f.recover();assert.equal(result.ok,true);
 assert.ok(f.data['chatgpt-goal:'+url],'close follow-ups must adopt the Goal');
 assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2,'close chronological requests bind one-to-one');
}

{
 const f=await fixture();
 f.pending.url=url;f.data['chatgpt-goal-composer:7'].url=url;
 f.requests[0].sourceUrl=url;
 const result=await f.recover();assert.equal(result.ok,true,'saved-chat intent survives later native sends');
 assert.equal(f.data['chatgpt-goal:'+url].goal,'Original objective');
 assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2);
}

{
 const f=await fixture();f.pending.url=url;f.data['chatgpt-goal-composer:7'].url=url;f.requests[0].sourceUrl=url;
 f.data['chatgpt-goal-composer:7'].request={requestId:f.requests[0].requestId,startedAt:f.requests[0].eventAt,url};
 f.pending.request=f.data['chatgpt-goal-composer:7'].request;
 assert.equal((await f.bind()).ok,true,'saved original receipt survives newer tab receipt through native timeline');
 assert.equal(f.data['chatgpt-goal:'+url].supplements.length,2);
}

{
 const f=await fixture();f.journalError();
 assert.equal((await f.recover()).pending,true,'incomplete journal evidence cannot authorize Goal adoption');
 assert.equal(f.data['chatgpt-goal:'+url],undefined);assert.equal(f.messages.length,0);
}
