import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createContext,runInContext} from 'node:vm';
const require=createRequire(import.meta.url);require('../extension/goal-policy.js');const {create}=require('../extension/goal-store.js');
const source=readFileSync('extension/service-worker.js','utf8');
const start=source.indexOf('async function reconcileGoalPromptBinding('),end=source.indexOf('const retryReadinessRecoveries=new Map();',start);assert.ok(start>=0&&end>start);
const url='https://chatgpt.com/c/native-timestamp-fixture',old='/c/native-timestamp-fixture|fallback-turn-0:0:user',next='/c/native-timestamp-fixture|fallback-turn-0:2:user';
async function fixture(response:string,variant:'normal'|'newer'|'stop'|'bad-checkpoint'='normal') {
 const now=Date.now(),manual={requestId:'manual-request',startedAt:1000000,promptKey:old,userId:'user-id',userText:'Same objective',userSentAtMs:999990,tabId:7,sourceUrl:url};
 const data:Record<string,any>={['chatgpt-goal:'+url]:{id:'goal-id',url,goal:'Same objective',rules:'',phase:'waiting',startedAt:now-1000,deadlineAt:now+60000,continuations:0,maxContinuations:30,maxMinutes:60,expectedPromptKey:old,lastCompletionKey:'',manualStart:manual}};
 let checkpoint:any={state:'active',url,requestId:manual.requestId,startedAt:manual.startedAt,promptKey:old,nativeUserId:variant==='bad-checkpoint'?'other-user':'user-id',nativeUserSentAtMs:manual.userSentAtMs};
 const events:any[]=[{kind:'request.started',operationId:null,tabId:7,sourceUrl:url,requestId:'manual-request',eventAt:1000000,sequence:1}];
 if(variant==='newer')events.push({...events[0],requestId:'newer',sequence:2,eventAt:1100000});
 const native={ok:true,url,isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'answer',promptKey:next,userId:'user-id',userText:'Same objective',userSentAtMs:1300000,goalResponse:response,goalRawExact:response==='GOAL_COMPLETE'};
 const sends:any[]=[],journal:any[]=[];const storage={get:async(k:string|string[])=>Object.fromEntries((Array.isArray(k)?k:[k]).filter(x=>data[x]!==undefined).map(x=>[x,structuredClone(data[x])])),set:async(v:any)=>Object.assign(data,structuredClone(v))};
 const tabs={get:async()=>({id:7,url}),sendMessage:async(_id:number,m:any)=>{sends.push(m);return {ok:true};}};
 const goalController=create({storage,tabs,appendJournal:async(e:any)=>{journal.push(e);return {ok:true};},now:()=>now,uuid:()=> 'new-operation'});
 if(variant==='stop')data['chatgpt-goal:'+url].stopRequested=true;
 const ctx=createContext({Date,JSON,Number,Object,Array,URL,goalController,inspectCompletedTurn:()=>{},ChatGPTHandoffTitle:{chatUrl:(v:string)=>v},readJournal:async()=>({ok:true,storageError:'',events:structuredClone(events)}),completionCheckpointRead:async()=>structuredClone(checkpoint),completionCheckpointChange:async(_tab:number,fn:any)=>{const change=fn(checkpoint);if(change.record)checkpoint=change.record;return change.value;},manualRequestReceiptsByTab:new Map(),chrome:{tabs,scripting:{executeScript:async()=>[{result:structuredClone(native)}]}}});
 runInContext(source.slice(start,end),ctx);const run=()=>runInContext(`reconcileGoalPromptBinding(7,${JSON.stringify(url)})`,ctx);const result=await run();return {result,run,data,sends,journal,checkpoint};
}
const complete=await fixture('GOAL_COMPLETE');assert.equal(complete.data['chatgpt-goal:'+url].phase,'completed');assert.equal(complete.sends.length,0);
const ongoing=await fixture('Still working');assert.equal(ongoing.data['chatgpt-goal:'+url].phase,'preparing');assert.equal(ongoing.sends.length,1);assert.equal(ongoing.sends[0].type,'CHATGPT_GOAL_DISPATCH');await ongoing.run();assert.equal(ongoing.sends.length,1,'repeated observations cannot dispatch twice');
for(const v of ['newer','stop','bad-checkpoint'] as const){const f=await fixture('Still working',v);assert.equal(f.sends.length,0,v);assert.equal(f.result.ok,false,v)}
console.log('Timestamp-shift integration: actual coordinator completes or dispatches once; newer requests, Stop and mismatched checkpoints prevent dispatch.');
