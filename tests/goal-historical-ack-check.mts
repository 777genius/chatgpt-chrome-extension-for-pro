import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
type V=Record<string,any>;
const url='https://chatgpt.com/c/historical-ack-fixture',prefix='/c/historical-ack-fixture|';
async function fixture(){
 const data:V={},events:V[]=[],sends:V[]=[];let time=1000;
 const ctx=createContext({URL,console});
 for(const name of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+name,'utf8'),ctx);
 ctx.deps={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))},
 tabs:{get:async()=>({id:7,url}),sendMessage:async(id:number,m:V)=>{sends.push(m);return {ok:true};}},
 appendJournal:async(e:V)=>{events.push(e);return {ok:true};},uuid:()=> 'fixture-id',now:()=>time};
 const store=runInContext('ChatGPTGoalStore.create(deps)',ctx);
 await store.start({url,tabId:7,goal:'Keep this exact objective',rules:'Keep criteria',maxContinuations:10,maxMinutes:1440});
 let record=data['chatgpt-goal:'+url];
 await store.intent({url,tabId:7,id:record.id,operationId:record.operation.id,text:record.operation.text,baselineKey:prefix+'baseline'});
 await store.report({url,tabId:7,id:record.id,operationId:record.operation.id,status:'clicked'});
 await store.report({url,tabId:7,id:record.id,operationId:record.operation.id,status:'blocked',reason:'Unknown click'});
 record=data['chatgpt-goal:'+url];
 const args={url,tabId:8,expectedRecord:structuredClone(record),operationId:record.operation.id,
  promptKey:prefix+'accepted',userId:'accepted-id',nativeVerified:true,
  supplements:[{userId:'manual-id',userText:'Sent clarification',text:'Sent clarification',requestId:'manual-request',
   startedAt:3000,userSentAtMs:2990,promptKey:prefix+'manual',tabId:7}]};
 return {data,store,record,args,events,sends,time:(v:number)=>{time=v;}};
}
{
 const h=await fixture(),before=h.sends.length,deadline=h.record.deadlineAt;
 assert.equal((await h.store.recoverAcknowledgement(h.args)).ok,true);
 const g=h.data['chatgpt-goal:'+url];assert.equal(g.phase,'waiting');assert.equal(g.operation,null);
 assert.equal(g.goal,'Keep this exact objective');assert.equal(g.rules,'Keep criteria');assert.equal(g.deadlineAt,deadline);
 assert.equal(g.maxContinuations,10);assert.equal(g.maxMinutes,1440);assert.equal(g.expectedPromptKey,prefix+'manual');
 assert.equal(g.supplements[0].text,'Sent clarification');assert.equal(g.manualStartedAt,3000);
 assert.equal(h.events.filter(e=>e.kind==='goal.confirmed'&&e.operationId===h.args.operationId).length,1);
 assert.equal(h.sends.length,before,'reconciling a consumed click never sends a message');
 assert.equal((await h.store.recoverAcknowledgement(h.args)).ok,false,'duplicate observers cannot consume the operation twice');
}
for(const scenario of ['stop','pause','manual-pending','new-operation','no-native','old-prompt','duplicate-manual','wrong-chat','unproven-time']) {
 const h=await fixture();
 if(scenario==='stop')h.record.stopRequested=true;
 if(scenario==='pause')h.record.pauseRequested=true;
 if(scenario==='manual-pending')h.record.manualPending={text:'Do not overwrite'};
 if(scenario==='new-operation')h.record.operation.id='different';
 if(scenario==='no-native')h.args.nativeVerified=false;
 if(scenario==='old-prompt')h.args.promptKey=prefix+'baseline';
 if(scenario==='duplicate-manual')h.args.supplements.push({...h.args.supplements[0]});
 if(scenario==='wrong-chat')h.args.supplements[0].promptKey='/c/other|manual';
 if(scenario==='unproven-time')h.args.supplements[0].startedAt=50000;
 const before=h.sends.length;assert.equal((await h.store.recoverAcknowledgement(h.args)).ok,false,scenario);
 assert.equal(h.sends.length,before);assert.equal(h.record.phase,'blocked');
}
{
 const h=await fixture();h.time(h.record.deadlineAt+1);
 assert.equal((await h.store.recoverAcknowledgement(h.args)).ok,true);
 assert.equal(h.data['chatgpt-goal:'+url].phase,'stopped','an expired goal acknowledges history without resuming');
}
console.log('Historical Goal ACK: atomic observation-only recovery, sent clarifications, original limits, duplicate/Stop/Pause/race/deadline fences passed.');
const worker=readFileSync('extension/service-worker.js','utf8');
const reconciliation=worker.slice(worker.indexOf('const goalAckProofs='),worker.indexOf('async function reconcileAcceptedHandoffGoal('));
async function workerFixture(){
 const h=await fixture(),op=h.record.operation;
 const historical:V={ok:true,url,nativeConversationId:'historical-ack-fixture',isReadOnly:false,userId:'accepted-id',userText:op.text,promptKey:prefix+'accepted',
  recoveryTimeline:[{userId:'accepted-id',userText:op.text,userSentAtMs:2000,promptKey:prefix+'accepted'},
   {userId:'manual-id',userText:'Sent clarification',userSentAtMs:29900,promptKey:prefix+'manual'}]};
 const latest:V={ok:true,url,nativeConversationId:'historical-ack-fixture',isLatest:true,isReadOnly:false,userId:'manual-id',userText:'Sent clarification',
  userSentAtMs:29900,promptKey:prefix+'manual',generating:true,turnStatus:'in_progress'};
 const events:V[]=[{kind:'send.authorized',operationId:op.id,tabId:7,sourceUrl:url,recordedAt:1900},
  {kind:'send.dispatched',operationId:op.id,tabId:7,sourceUrl:url,requestedText:op.text,text:op.text,recordedAt:2100},
  {kind:'request.started',operationId:op.id,tabId:7,sourceUrl:url,requestId:'own-request',eventAt:20000},
  {kind:'request.started',operationId:null,tabId:7,sourceUrl:url,requestId:'manual-request',eventAt:30000}];
 let live=url,probes=0,onLast:(()=>void)|null=null,ackCalls=0,ackOk=true,journalReads=0,journalError=false;
 let request:V|null={operationId:op.id,requestId:'own-request',startedAt:20000,url};
 const ctx=createContext({URL,console,goalController:h.store,readJournal:async()=>{journalReads++;if(journalError)throw Error('Full journal unavailable');return {events:structuredClone(events)};},
  latestRequestReceipt:async()=>structuredClone(request),
  confirmNativeGoalSend:async()=>{ackCalls++;return {ok:ackOk};},
  inspectCompletedTurn:function(){},ChatGPTGoalPolicy:{canonical:(u:string)=>u},
  chrome:{storage:{local:{get:async(k:string)=>({[k]:structuredClone(h.data[k])})}},tabs:{get:async()=>({url:live})},
   scripting:{executeScript:async({args}:V)=>{probes++;if(probes===3)onLast?.();return [{result:structuredClone(args[3]?historical:latest)}];}}}});
 runInContext(reconciliation,ctx);
 return {...h,events,historical,latest,route:(v:string)=>{live=v;},onLast:(fn:()=>void)=>{onLast=fn;},
  run:()=>runInContext(`reconcileNativeGoalAcknowledgement(8,'${url}')`,ctx),
  runOwner:()=>runInContext(`reconcileNativeGoalAcknowledgement(7,'${url}')`,ctx),
  ackCalls:()=>ackCalls,ackOk:(v:boolean)=>{ackOk=v;},journalReads:()=>journalReads,failJournal:()=>{journalError=true;},setRequest:(value:V|null)=>{request=value;}};
}
for(const phase of ['sending','clicked']) {
 const h=await workerFixture();h.record.phase=phase;h.failJournal();
 assert.equal((await h.runOwner()).ok,true,phase+' should reconcile without waiting for a timeout');
 assert.equal(h.journalReads(),0,'background Goal ACK with its exact live receipt bypasses full journal loading');
 assert.equal(h.ackCalls(),1);assert.equal(h.sends.length,1,'observation never dispatches');
 const pending=await workerFixture();pending.record.phase=phase;pending.ackOk(false);
 assert.equal(await pending.runOwner(),undefined,'unconfirmed in-flight sends stay in flight');
 assert.equal(pending.data['chatgpt-goal:'+url].phase,phase);
 assert.equal(pending.sends.length,1,'an uncertain send is never repeated');
}
{
 const h=await workerFixture();h.record.phase='clicked';h.setRequest(null);
 assert.equal((await h.runOwner()).ok,true,'lost receipt still uses immutable journal proof');
 assert.equal(h.journalReads(),1);assert.equal(h.ackCalls(),1);
}
for(const flag of ['stopRequested','pauseRequested','manualOverride','manualPending']) {
 const h=await workerFixture();h.record[flag]=true;h.failJournal();
 assert.equal(await h.runOwner(),undefined,flag);
 assert.equal(h.ackCalls(),0);assert.equal(h.journalReads(),0,'background observation preserves '+flag+' before either ACK path');
 assert.equal(h.data['chatgpt-goal:'+url].phase,'blocked');
}
{
 const h=await workerFixture(),before=h.sends.length;assert.equal((await h.run()).ok,true);
 const goal=h.data['chatgpt-goal:'+url];assert.equal(goal.phase,'waiting');assert.equal(goal.expectedPromptKey,prefix+'manual');
 assert.equal(goal.supplements[0].text,'Sent clarification');assert.equal(h.sends.length,before);
 assert.equal(await h.run(),undefined,'a second observer sees the consumed operation, never another recovery');
}
for(const scenario of ['duplicate-request','unknown-later-send','missing-manual','unrendered-history','wrong-native-text','route-race','goal-race','native-race']) {
 const h=await workerFixture();
 if(scenario==='duplicate-request')h.events.push({...h.events[2],requestId:'second-owned'});
 if(scenario==='unknown-later-send')h.events[3].operationId='another-automation';
 if(scenario==='missing-manual')h.events.pop();
 if(scenario==='unrendered-history')h.historical.recoveryTimeline=null;
 if(scenario==='wrong-native-text')h.historical.userText='Other text';
 if(scenario==='route-race')h.onLast(()=>h.route('https://chatgpt.com/c/other'));
 if(scenario==='goal-race')h.onLast(()=>{h.record.stopRequested=true;});
 if(scenario==='native-race')h.onLast(()=>{h.latest.userId='new-user';});
 const before=h.sends.length;await h.run();assert.equal(h.data['chatgpt-goal:'+url].phase,'blocked',scenario);
 assert.equal(h.sends.length,before,scenario);
}
console.log('Historical ACK worker: exact grant/click/native text, all later manual requests, reopened tab, route/state/new-message races and no replay passed.');
