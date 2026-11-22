import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const require=createRequire(import.meta.url);
require('../extension/goal-policy.js');
const {create}=require('../extension/goal-store.js');
const url='https://chatgpt.com/c/queued-suffix-test',oldPrompt='/c/queued-suffix-test|old',prompt='/c/queued-suffix-test|manual';
const data:Record<string,any>={},sent:any[]=[],events:any[]=[];
let busy=true,sequence=0;
const now=Date.now(),sentAt=now+1000;
let clock=now;
const storage={async get(k:string){return {[k]:structuredClone(data[k])}},async set(v:any){Object.assign(data,structuredClone(v))}};
const tabs={async get(id:number){return{id,url}},async sendMessage(id:number,message:any){if(message.type==='CHATGPT_GOAL_READINESS')return{ok:true,idle:!busy};sent.push({id,message});return{ok:true}}};
const store=create({storage,tabs,appendJournal:async(e:any,_tab:any,options:any)=>{
 if(options?.goalCAS){const cas=options.goalCAS,key='chatgpt-goal:'+cas.url;
  if(JSON.stringify(data[key])!==JSON.stringify(cas.expected))throw Object.assign(new Error('Goal changed'),{code:'GOAL_FENCE_CHANGED'});
  data[key]=structuredClone(cas.next);
 }
 events.push(structuredClone(e));return {ok:true};},now:()=>clock,uuid:()=>`operation-${++sequence}`});
await store.start({url,tabId:7,goal:'Complete the isolated task',rules:'',maxContinuations:3,maxMinutes:60});
let g=data['chatgpt-goal:'+url],op=g.operation;
await store.intent({url,tabId:7,id:g.id,operationId:op.id,text:op.text,baselineKey:'/c/queued-suffix-test|previous'});
await store.authorize({url,tabId:7,id:g.id,operationId:op.id,text:op.text});
await store.report({url,tabId:7,id:g.id,operationId:op.id,status:'clicked'});
await store.report({url,tabId:7,id:g.id,operationId:op.id,status:'confirmed',newPromptKey:oldPrompt});
await store.completion({url,tabId:7,completionKey:oldPrompt+'|blocked',promptKey:oldPrompt,response:'GOAL_BLOCKED',rawExact:true,nativeVerified:true});
busy=false;await store.control({action:'resume',url,tabId:7});
assert.equal(data['chatgpt-goal:'+url].resumeRequested,true);
assert.equal(sent.length,1,'an idle blocked Goal must wait for manual-turn reconciliation');
const queuedManual=await store.manual({url,tabId:7,requestId:'later-manual',startedAt:sentAt+100,eventAt:sentAt+100,text:'Later follow-up',baselineKey:oldPrompt});
assert.equal(queuedManual.ok,false);assert.equal(queuedManual.pending,true);
assert.equal(data['chatgpt-goal:'+url].phase,'blocked');assert.equal(data['chatgpt-goal:'+url].resumeRequested,true,'a manual request cannot bypass earlier unbound follow-ups');
clock=sentAt+1;
const sentAt2=sentAt+25000,receipt={requestId:'request-2',startedAt:sentAt2,submittedUserId:'manual-user-2'};
clock=sentAt2+1;
const prompt2='/c/queued-suffix-test|manual-2';
const user1={userId:'manual-user',promptKey:prompt,userSentAtMs:sentAt+1,userText:'First addition'};
const user2={userId:'manual-user-2',promptKey:prompt2,userSentAtMs:sentAt2+1,userText:'Second addition'};
const native={ok:true,isLatest:true,isReadOnly:false,turnStatus:'complete',generating:false,hasError:false,assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'answer',...user2,userVisibleText:user2.userText,goalResponse:'Still working',goalRawExact:false,goalMarkerPending:false};
const historical={ok:true,isReadOnly:false,userId:user1.userId,recoveryTimeline:[user1,user2]};
const journal={ok:true,storageError:'',meta:{sequence:105},events:[
 {kind:'goal.answer_blocked',tabId:7,goalId:g.id,promptKey:oldPrompt,completionKey:oldPrompt+'|blocked',sequence:99},
 {kind:'request.started',tabId:7,sourceUrl:url,requestId:'request-1',eventAt:sentAt,sequence:100},
 {kind:'retry.preparation_superseded',tabId:7,sourceUrl:url,requestId:'request-1',startedAt:sentAt,sequence:101},
 {kind:'request.completed',tabId:7,sourceUrl:url,requestId:'request-1',sequence:102},
 {kind:'request.started',tabId:7,sourceUrl:url,requestId:'request-2',eventAt:sentAt2,sequence:103},
 {kind:'retry.preparation_superseded',tabId:7,sourceUrl:url,requestId:'request-2',startedAt:sentAt2,sequence:104},
 {kind:'request.completed',tabId:7,sourceUrl:url,requestId:'request-2',sequence:105}]};
const source=readFileSync('extension/service-worker.js','utf8'),start=source.indexOf('async function reconcileQueuedGoalResume('),end=source.indexOf('async function reconcileAcceptedHandoffGoal(',start);
assert.ok(start>0&&end>start);
let flipReadOnly=false,injectLate=false;
const ctx=createContext({URL,Date,JSON,Number,Math,ChatGPTGoalPolicy:{canonical:(v:string)=>v},inspectCompletedTurn:()=>{},chrome:{tabs,scripting:{executeScript:async(input:any)=>{if(input.args.length>3){if(flipReadOnly)native.isReadOnly=true;return [{result:structuredClone(historical)}]}return [{result:structuredClone(native)}]}}},latestRequestReceipt:async()=>structuredClone(receipt),readJournal:async()=>{const copy=structuredClone(journal);if(injectLate&&data['chatgpt-goal:'+url].phase==='waiting'){copy.events.push({kind:'request.started',tabId:8,sourceUrl:url,requestId:'later',eventAt:sentAt2+1000,sequence:106});copy.meta.sequence=106}return copy},goalController:store});
runInContext(source.slice(start,end),ctx);ctx.url=url;
const missingAnchor=journal.events.shift();
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
assert.equal(data['chatgpt-goal:'+url].phase,'blocked','missing blocked anchor cannot release the Goal');
assert.equal(sent.length,1);
journal.events.unshift(missingAnchor!);
const missingWitness=journal.events.splice(2,1)[0];
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
assert.equal(data['chatgpt-goal:'+url].phase,'blocked','incomplete journal cannot release the Goal');
assert.equal(sent.length,1);
journal.events.splice(2,0,missingWitness);
flipReadOnly=true;
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
assert.equal(data['chatgpt-goal:'+url].phase,'blocked','a read-only change during history inspection is refused');
assert.equal(sent.length,1);
native.isReadOnly=false;flipReadOnly=false;
const savedQueued=structuredClone(data['chatgpt-goal:'+url]);
injectLate=true;
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
assert.equal(data['chatgpt-goal:'+url].phase,'waiting');
assert.equal(data['chatgpt-goal:'+url].queuedResumeFence?.requestId,receipt.requestId,'the committed waiting state retains the exact request fence after a late request');
assert.equal(sent.length,1,'a late same-chat request prevents dispatch after resume is committed');
data['chatgpt-goal:'+url]=savedQueued;injectLate=false;
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
g=data['chatgpt-goal:'+url];
assert.equal(g.phase,'preparing');assert.equal(g.resumeRequested,false);assert.equal(g.expectedPromptKey,prompt2);assert.equal(g.supplements.length,2);assert.deepEqual(g.supplements.map((s:any)=>s.userId),['manual-user','manual-user-2']);
assert.equal(sent.length,2,'one initial send and one continuation; no direct retry');
await runInContext('reconcileQueuedGoalResume(7,url)',ctx);
assert.equal(sent.length,2,'replaying recovery does not dispatch twice');
// A crash or new request after the coordinator commits waiting must not let
// the ordinary waiting-answer recovery consume the stale answer later.
const fence={requestId:receipt.requestId,startedAt:receipt.startedAt,userId:user2.userId,requestSequence:103};
Object.assign(data['chatgpt-goal:'+url],{phase:'waiting',operation:null,queuedResumeFence:fence,lastCompletionKey:null});
Object.assign(native,{url});
const waitingStart=source.indexOf('async function reconcileWaitingGoalAnswer('),waitingEnd=source.indexOf('async function reconcileCompletedSourceHandoff(',waitingStart);
assert.ok(waitingStart>0&&waitingEnd>waitingStart);
runInContext(source.slice(waitingStart,waitingEnd),ctx);
journal.events.push({kind:'request.started',tabId:8,sourceUrl:url,requestId:'later',eventAt:sentAt2+1000,sequence:106});journal.meta.sequence=106;
await runInContext('reconcileWaitingGoalAnswer(7,url)',ctx);
assert.equal(sent.length,2,'newer same-chat request fences later waiting recovery');
assert.equal((await store.completion({url,tabId:7,completionKey:prompt2+'|answer',promptKey:prompt2,userId:user2.userId,response:'Still working',nativeVerified:true})).ok,false,'ordinary completion cannot bypass the durable queued-resume fence');
journal.events.pop();journal.meta.sequence=105;
await runInContext('reconcileWaitingGoalAnswer(7,url)',ctx);
assert.equal(sent.length,3,'the exact receipt and gap-free journal release the fence once');
await runInContext('reconcileWaitingGoalAnswer(7,url)',ctx);
assert.equal(sent.length,3,'the recovered completion cannot dispatch twice');
console.log('Queued resume integration: retained suffix, actual Goal coordinator, saved both manual follow-ups and one continuation passed.');
